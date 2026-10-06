import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"

const directory = "/synthetic/cellular"
const project = { id: "fixture-cellular", worktree: directory, sandboxes: [], time: { created: 1, updated: 1 } }
const session = {
  id: "ses_cellular",
  projectID: project.id,
  directory,
  title: "Cellular fixture",
  slug: "cellular",
  version: "1",
  time: { created: 1, updated: 2 },
}
type CellularWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_TRANSCRIPTS__: { scope: string; document: string }
  __HAOLAB_CACHE__: unknown
  webkit: unknown
  __cellular: {
    start: number
    cached?: number
    fresh?: number
    freshVisible?: number
    cachedVisible?: number
    released?: number
    releaseLatest?: () => void
    streams: number
    aborts: number
    transcriptProbes: string[]
    requests: { path: string; before: string | null; bytes: number; start: number; end?: number }[]
  }
}

test.describe("smoke: mobile cellular recent page", () => {
  test.skip(!process.env.PLAYWRIGHT_MOBILE_SELECTION, "Requires an isolated same-origin production build")
  test.use({ viewport: { width: 390, height: 844 } })

  for (const [count, total] of [
    [20, 21],
    [100, 101],
    [300, 301],
    [300, 1000],
  ])
    for (const rtt of [150, 300, 500]) {
      test(`${count} cached messages, ${total} server messages, ${rtt}ms RTT, 3Mbps: fresh text does not wait for old history`, async ({
        page,
      }, testInfo) => {
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.addInitScript(
          ({ directory, project, session, count, total, rtt }) => {
            const host = window as CellularWindow
            const item = (index: number, fresh = false) => {
              const id = `msg_${String(index).padStart(5, "0")}`
              return {
                info: {
                  id,
                  sessionID: session.id,
                  role: "user",
                  time: { created: index + 1 },
                  agent: "build",
                  model: { providerID: "fixture", modelID: "fixture" },
                },
                parts: [
                  {
                    id: `part_${id}_a`,
                    sessionID: session.id,
                    messageID: id,
                    type: "text",
                    text: `${fresh ? "FRESH" : "CACHED"}-MARKER-${index}`,
                  },
                  {
                    id: `part_${id}_b`,
                    sessionID: session.id,
                    messageID: id,
                    type: "tool",
                    callID: id,
                    tool: "bash",
                    state: {
                      status: "completed",
                      input: { command: "synthetic" },
                      output: "x".repeat(8192),
                      title: "synthetic output",
                      metadata: {},
                      time: { start: 1, end: 2 },
                    },
                  },
                ],
              }
            }
            const cached = Array.from({ length: count }, (_, index) => item(index))
            const current = Array.from({ length: total }, (_, index) => item(index, true))
            let disk = JSON.stringify({
              version: 1,
              entries: [
                {
                  directory,
                  sessionID: session.id,
                  session: cached.map((item) => item.info),
                  part: cached.map((item) => ({ id: item.info.id, part: item.parts })),
                  complete: true,
                  updated: 1,
                },
              ],
            })
            host.__HAOLAB_MOBILE__ = true
            host.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
            host.__HAOLAB_TRANSCRIPTS__ = { scope: `tunnel.v1.${"a".repeat(64)}`, document: "cellular-fixture" }
            host.__HAOLAB_CACHE__ = {
              version: 1,
              projects: [directory],
              selected: directory,
              sessions: { [directory]: [session] },
            }
            host.__cellular = { start: 0, streams: 0, aborts: 0, requests: [], transcriptProbes: [] }
            const latestGate = new Promise<void>((resolve) => {
              host.__cellular.releaseLatest = () => {
                host.__cellular.released = performance.now()
                resolve()
              }
            })
            host.webkit = {
              messageHandlers: {
                haolabCache: { postMessage() {} },
                haolabConnection: { postMessage() {} },
                haolabTranscripts: {
                  async postMessage(request: { operation: string; value: string }) {
                    if (request.operation === "get") return disk
                    if (request.operation === "set") disk = request.value
                    return null
                  },
                },
              },
            }
            new MutationObserver(() => {
              const stats = host.__cellular
              if (!stats.start) return
              const text = document.body?.textContent ?? ""
              if (text.includes(`CACHED-MARKER-${count - 1}`)) stats.cached ??= performance.now() - stats.start
              if (text.includes(`FRESH-MARKER-${total - 1}`)) stats.fresh ??= performance.now() - stats.start
            }).observe(document, { subtree: true, childList: true, characterData: true })
            const original = window.fetch.bind(window)
            window.fetch = async (input, init) => {
              const request = new Request(input, init)
              const url = new URL(request.url)
              const path = url.pathname
              const stats = host.__cellular
              if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path)) {
                // Old A lacks the feed; track its one capability probe outside legacy page budgets.
                stats.transcriptProbes.push(path)
                return Response.json({}, { status: 404 })
              }
              if (path === "/global/event") {
                stats.streams++
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      const send = (type: string) =>
                        controller.enqueue(
                          new TextEncoder().encode(
                            `data: ${JSON.stringify({ payload: { type, properties: {} } })}\n\n`,
                          ),
                        )
                      send("server.connected")
                      const timer = setInterval(() => send("server.heartbeat"), 1000)
                      request.signal.addEventListener("abort", () => {
                        stats.aborts++
                        clearInterval(timer)
                        controller.close()
                      })
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }
              let data: unknown
              let cursor: string | undefined
              if (path.endsWith("/message")) {
                const before = url.searchParams.get("before")
                const end = before
                  ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time - 1
                  : current.length
                const start = Math.max(0, end - Number(url.searchParams.get("limit") ?? 20))
                data = current.slice(start, end)
                if (start)
                  cursor = btoa(JSON.stringify({ id: current[start].info.id, time: current[start].info.time.created }))
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/, "")
              } else if (path === `/session/${session.id}`) data = session
              else if (path === "/__haolab/projects") data = { directories: [directory] }
              else if (path === "/global/health") data = { healthy: true, version: "fixture" }
              else if (path === "/project") data = [project]
              else if (path === "/project/current") data = project
              else if (path === "/path")
                data = {
                  home: "/synthetic",
                  state: "/synthetic/state",
                  config: "/synthetic/config",
                  worktree: directory,
                  directory,
                }
              else if (path === "/provider") data = { all: [], default: {}, connected: [] }
              else if (path === "/session/sidebar/snapshot")
                data = { cursor: 1, total: 1, items: [session], next: null }
              else if (path === "/session/sidebar/changes") data = { cursor: 1, total: 1, changes: [], more: false }
              else if (path === "/session" || path === "/experimental/session") data = [session]
              else if (/\/session\/[^/]+\/(diff|todo|children)$/.test(path)) data = []
              else if (path === "/config/providers") data = { providers: [], default: {} }
              else if (path === "/agent") data = [{ name: "build", mode: "primary", permission: [] }]
              else if (["/permission", "/question", "/command", "/lsp", "/skill", "/pty", "/pty/shells"].includes(path))
                data = []
              else if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path))
                data = {}
              if (data === undefined) {
                if (!path.startsWith("/assets/")) throw new Error(`Unmocked fixture API: ${path}`)
                return original(request)
              }
              const body = JSON.stringify(data)
              const bytes = new TextEncoder().encode(body).length
              const record: CellularWindow["__cellular"]["requests"][number] = {
                path,
                before: url.searchParams.get("before"),
                bytes,
                start: performance.now(),
              }
              stats.requests.push(record)
              request.signal.addEventListener("abort", () => {
                stats.aborts++
              })
              if (path.endsWith("/message") && !record.before) await latestGate
              // Pace complete JSON bodies, including collapsed tool output, not just response headers.
              await new Promise((resolve) => setTimeout(resolve, rtt + (bytes / 375000) * 1000))
              record.end = performance.now()
              return new Response(body, {
                headers: { "content-type": "application/json", ...(cursor ? { "x-next-cursor": cursor } : {}) },
              })
            }
          },
          { directory, project, session, count, total, rtt },
        )
        await page.goto("/")
        await expect.poll(() => page.evaluate(() => (window as CellularWindow).__cellular.streams)).toBe(1)
        await expect
          .poll(() =>
            page.evaluate(() =>
              ["/project", "/provider", "/global/config", "/session/sidebar/snapshot"].every((path) =>
                (window as CellularWindow).__cellular.requests.some(
                  (request) => request.path === path && request.end !== undefined,
                ),
              ),
            ),
          )
          .toBe(true)
        await page.evaluate(
          ({ directory, sessionID }) => {
            ;(window as CellularWindow).__cellular.start = performance.now()
            history.pushState(null, "", `/${directory}/session/${sessionID}`)
            window.dispatchEvent(new PopStateEvent("popstate"))
          },
          { directory: base64Encode(directory), sessionID: session.id },
        )
        const cachedViewport = () =>
          page.evaluate(
            (marker) => {
              const root = document.querySelector<HTMLElement>(".scroll-view__viewport")
              const node = [...(root?.querySelectorAll('[data-slot="user-message-text"]') ?? [])].find(
                (element) => element.textContent?.trim() === marker,
              )
              const last = [...(root?.querySelectorAll('[data-timeline-row="UserMessage"]') ?? [])].at(-1)
              return {
                top: root?.scrollTop,
                height: root?.scrollHeight,
                client: root?.clientHeight,
                viewport: root?.getBoundingClientRect().toJSON(),
                marker: node?.getBoundingClientRect().toJSON(),
                lastRow: last?.getBoundingClientRect().toJSON(),
                cachedDomMs: (window as CellularWindow).__cellular.cached,
              }
            },
            `CACHED-MARKER-${count - 1}`,
          )
        await expect(page.getByText(`CACHED-MARKER-${count - 1}`, { exact: true }))
          .toBeVisible()
          .catch(async (error) => {
            const geometry = await cachedViewport()
            console.log(JSON.stringify({ count, total, rtt, cachedViewport: geometry }))
            await testInfo.attach("cached-viewport", {
              contentType: "application/json",
              body: JSON.stringify(geometry),
            })
            throw error
          })
        await expect(page.getByText(`CACHED-MARKER-${count - 1}`, { exact: true })).toBeInViewport()
        await testInfo.attach("cached-viewport", {
          contentType: "application/json",
          body: JSON.stringify(await cachedViewport()),
        })
        await page.evaluate(() => {
          const stats = (window as CellularWindow).__cellular
          stats.cachedVisible = performance.now() - stats.start
          stats.releaseLatest?.()
        })
        await page.waitForFunction(
          (marker) => {
            const root = document.querySelector<HTMLElement>(".scroll-view__viewport")
            const node = [...(root?.querySelectorAll('[data-slot="user-message-text"]') ?? [])].find(
              (element) => element.textContent?.trim() === marker,
            )
            if (!root || !node || getComputedStyle(node).visibility === "hidden") return false
            const viewport = root.getBoundingClientRect()
            const rect = node.getBoundingClientRect()
            if (
              !rect.width ||
              !rect.height ||
              rect.bottom <= viewport.top ||
              rect.top >= viewport.bottom ||
              rect.right <= viewport.left ||
              rect.left >= viewport.right
            )
              return false
            const stats = (window as CellularWindow).__cellular
            stats.freshVisible ??= performance.now() - stats.start
            return true
          },
          `FRESH-MARKER-${total - 1}`,
          { polling: "raf" },
        )
        await expect(page.getByText(`FRESH-MARKER-${total - 1}`, { exact: true })).toBeVisible()
        await expect(page.getByText(`FRESH-MARKER-${total - 1}`, { exact: true })).toBeInViewport()
        const report = await page.evaluate(() => {
          const stats = (window as CellularWindow).__cellular
          const reads = stats.requests.filter(
            (request) =>
              request.start >= stats.start &&
              (request.path.endsWith("/message") || request.path === "/session/ses_cellular"),
          )
          return {
            start: stats.start,
            cachedMs: stats.cached,
            cachedVisibleMs: stats.cachedVisible,
            freshMs: stats.fresh,
            freshVisibleMs: stats.freshVisible,
            released: stats.released,
            freshAfterReleaseMs: stats.freshVisible! - (stats.released! - stats.start),
            reads,
            streams: stats.streams,
            aborts: stats.aborts,
            transcriptProbes: stats.transcriptProbes,
          }
        })
        const messages = report.reads.filter((request) => request.path.endsWith("/message"))
        expect(messages).toHaveLength(1)
        expect(messages[0].before).toBeNull()
        expect(report.reads.filter((request) => request.path === `/session/${session.id}`)).toHaveLength(1)
        expect(report.freshAfterReleaseMs).toBeLessThan(rtt + (messages[0].bytes / 375000) * 1000 + 500)
        expect(report.freshMs! - (messages[0].end! - report.start)).toBeGreaterThanOrEqual(0)
        expect(report.freshMs! - (messages[0].end! - report.start)).toBeLessThan(500)
        expect(report.streams).toBe(1)
        expect(report.aborts).toBe(0)
        expect(report.transcriptProbes).toEqual([`/session/${session.id}/transcript/snapshot`])
        await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
        expect(errors).toEqual([])
        console.log(
          JSON.stringify({
            count,
            total,
            rtt,
            Mbps: 3,
            ...report,
            bodyBytes: report.reads.reduce((sum, request) => sum + request.bytes, 0),
          }),
        )
      })
    }
})
