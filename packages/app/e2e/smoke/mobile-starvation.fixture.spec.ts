import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"

const directory = "/synthetic/starvation"
const project = { id: "fixture-starvation", worktree: directory, sandboxes: [], time: { created: 1, updated: 1 } }
const session = { id: "ses_starvation", projectID: project.id, directory, title: "Uncached session", slug: "starvation", version: "1", time: { created: 1, updated: 1 } }
type FixtureWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_CACHE__: unknown
  webkit: unknown
  __stats: {
    requests: { path: string; started: number; aborted?: number; finished?: number }[]
    streams: { started: number; aborted?: number; closed?: number; beats: number }[]
    start: number
    running: boolean
  }
  __begin: () => void
  __stop: () => void
  __probe?: ReturnType<typeof setInterval>
  __fresh?: boolean
  __releaseHandshake?: () => void
}

for (const mode of ["stable", "probe", "probehealthy", "handshake", "eof", "eofprobe", "stablebackoff", "comments", "data", "metadata", "headers", "gap"] as const) {
  test(`production providers: slow uncached messages with ${mode}`, async ({ page }) => {
    test.setTimeout(80000)
    let gapFresh = false
    await page.addInitScript(({ directory, project, session, mode }) => {
      const host = window as FixtureWindow
      Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
      Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { configurable: true, value: undefined })
      host.__HAOLAB_MOBILE__ = true
      host.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
      host.__HAOLAB_CACHE__ = { version: 1, projects: [directory], selected: directory, sessions: { [directory]: [session] } }
      host.__stats = { requests: [], streams: [], start: performance.now(), running: false }
      host.webkit = { messageHandlers: { haolabCache: { postMessage() {} }, haolabConnection: { postMessage() {} } } }
      const original = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const request = new Request(input, init)
        const path = new URL(request.url).pathname
        const record = { path, started: performance.now(), aborted: undefined as number | undefined, finished: undefined as number | undefined }
        host.__stats.requests.push(record)
        request.signal.addEventListener("abort", () => { if (!record.finished) record.aborted = performance.now() })
        if (mode === "metadata" && path === "/global/config") return new Promise<Response>(() => {})
        if (path.endsWith("/message")) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 3000)
            request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal.reason) }, { once: true })
          })
          record.finished = performance.now()
          return Response.json([{ info: { id: "msg_starvation", sessionID: session.id, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } }, parts: [{ id: "part_starvation", sessionID: session.id, messageID: "msg_starvation", type: "text", text: host.__fresh ? "Gap-filled current message" : "Slow uncached message completed" }] }])
        }
        if (path === "/global/event") {
          const stream = { started: performance.now(), aborted: undefined as number | undefined, closed: undefined as number | undefined, beats: 0 }
          host.__stats.streams.push(stream)
          if (mode === "headers") {
            request.signal.addEventListener("abort", () => { stream.aborted = performance.now() }, { once: true })
            return new Promise<Response>(() => {})
          }
          const response = () => new Response(new ReadableStream({ start(controller) {
            const send = (type: string) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type, properties: {} } })}\n\n`))
            send("server.connected")
            const timer = setInterval(() => {
              stream.beats++
              if (mode === "comments") controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
              else send(mode === "handshake" && host.__stats.running ? "server.connected" : "server.heartbeat")
            }, mode === "handshake" ? 1000 : mode === "comments" ? 5000 : 10000)
            const eof = mode === "eof" || mode === "eofprobe" || mode === "stablebackoff" ? setTimeout(() => {
              clearInterval(timer)
              stream.closed = performance.now()
              controller.close()
            }, mode === "stablebackoff" && host.__stats.streams.length >= 3 ? 12000 : 700) : undefined
            request.signal.addEventListener("abort", () => { clearInterval(timer); clearTimeout(eof); stream.aborted = performance.now(); controller.close() }, { once: true })
          } }), { headers: { "content-type": "text/event-stream" } })
          if (mode === "gap") return new Promise<Response>((resolve) => {
            host.__releaseHandshake = () => resolve(response())
          })
          return response()
        }
        const response = await original(request)
        record.finished = performance.now()
        return response
      }
      host.__begin = () => {
        host.__stats.running = true
        if (mode !== "probe" && mode !== "probehealthy" && mode !== "eofprobe") return
        let cycle = 0
        host.__probe = setInterval(() => {
          cycle++
          const transition = (state: string, active = true) => {
            host.__HAOLAB_CONNECTION__ = { state, active, revision: 1 }
            window.dispatchEvent(new CustomEvent("haolab:connection", { detail: host.__HAOLAB_CONNECTION__ }))
          }
          transition("connecting")
          setTimeout(() => transition(mode === "probe" && cycle % 4 === 0 ? "offline" : "connected", mode !== "probe" || cycle % 4 !== 0), 80)
          setTimeout(() => transition("connected"), 180)
        }, 1000)
      }
      host.__stop = () => { host.__stats.running = false; clearInterval(host.__probe) }
    }, { directory, project, session, mode })
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname
      if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path))
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      const data = (() => {
        if (path === "/__haolab/projects") return { directories: [directory] }
        if (path === "/global/health") return { healthy: true, version: "fixture" }
        if (path === "/project") return [{ ...project, name: gapFresh ? "Gap reconciled project" : "Initial fixture project" }]
        if (path === "/project/current") return project
        if (path === "/path") return { home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: directory, directory }
        if (path === "/provider") return { all: [], default: {}, connected: [] }
        if (path === "/session/sidebar/snapshot") return { cursor: 1, total: 1, items: [session], next: null }
        if (path === "/session/sidebar/changes") return { cursor: 1, total: 1, changes: [], more: false }
        if (path === "/session" || path === "/experimental/session") return [session]
        if (path === `/session/${session.id}`) return gapFresh ? { ...session, title: "Gap reconciled session", time: { created: 1, updated: 2 } } : session
        if (/\/session\/[^/]+\/(diff|todo|children)$/.test(path)) return []
        if (path === "/config/providers") return { providers: [], default: {} }
        if (path === "/agent") return [{ name: "build", mode: "primary", permission: [] }]
        if (path === "/permission") return gapFresh ? [{ id: "per_gap", sessionID: session.id, permission: "bash", patterns: ["fixture-gap-command"], metadata: {}, always: [] }] : []
        if (["/question", "/command", "/lsp", "/skill", "/pty", "/pty/shells"].includes(path)) return []
        if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
      })()
      if (data === undefined) return route.fallback()
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) })
    })
    await page.goto("/")
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__stats.streams.length)).toBeGreaterThan(0)
    await page.evaluate(({ directory, session }) => {
      ;(window as FixtureWindow).__begin()
      history.pushState(null, "", `/${directory}/session/${session}`)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, { directory: base64Encode(directory), session: session.id })
    await expect(page.getByText("Slow uncached message completed", { exact: true })).toBeVisible({ timeout: 4500 })
    expect(await page.evaluate(() => (window as FixtureWindow).__stats.requests
      .filter((request) => request.path.includes("/transcript/")).map((request) => request.path)))
      .toEqual([])
    if (mode === "gap") {
      await expect.poll(() => page.evaluate(() => {
        const requests = (window as FixtureWindow).__stats.requests
        return ["/session/sidebar/snapshot", "/permission", "/project"].every((path) => requests.some((request) => request.path === path && request.finished))
      })).toBe(true)
      const before = await page.evaluate(() => (window as FixtureWindow).__stats.requests)
      expect(before.filter((request) => request.path.endsWith("/message") && request.finished)).toHaveLength(1)
      const permissionReads = before.filter((request) => request.path === "/permission")
      expect(permissionReads.every((request) => request.finished)).toBe(true)
      expect(before.filter((request) => request.aborted)).toHaveLength(0)
      await expect(page.getByText("fixture-gap-command", { exact: true })).toHaveCount(0)
      gapFresh = true
      const started = Date.now()
      await page.evaluate(() => {
        const host = window as FixtureWindow
        host.__fresh = true
        host.__releaseHandshake?.()
      })
      await expect(page.getByText("Gap-filled current message", { exact: true })).toBeVisible({ timeout: 6000 })
      await expect(page.getByText("fixture-gap-command", { exact: true })).toBeVisible()
      await page.locator('[data-component="mobile-header"] button[aria-controls="sidebar-nav-mobile"]').click()
      await expect(page.locator('[data-component="home-project-row"]').filter({ hasText: "Gap reconciled project" })).toBeVisible()
      const report = await page.evaluate(() => {
        const host = window as FixtureWindow
        return { requests: host.__stats.requests.length, aborts: host.__stats.requests.filter((request) => request.aborted).length,
          messages: host.__stats.requests.filter((request) => request.path.endsWith("/message") && request.finished).length,
          permissions: host.__stats.requests.filter((request) => request.path === "/permission" && request.finished).length,
          streams: host.__stats.streams.length, native: host.__HAOLAB_CONNECTION__, documentNavigations: performance.getEntriesByType("navigation").length }
      })
      expect(report.aborts).toBe(0)
      expect(report.messages).toBe(2)
      expect(report.permissions).toBe(permissionReads.length + 1)
      expect(report.streams).toBe(1)
      expect(report.native).toEqual({ state: "connected", active: true, revision: 1 })
      expect(report.documentNavigations).toBe(1)
      await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
      console.log(JSON.stringify({ mode, gapFillMs: Date.now() - started, initialPermissions: permissionReads.length, ...report }))
      return
    }
    await page.waitForTimeout(mode === "comments" || mode === "data" ? 44000 : mode === "headers" ? 32000 : mode === "stablebackoff" ? 18000 : 9000)
    const report = await page.evaluate(() => {
      const stats = (window as FixtureWindow).__stats
      const messages = stats.requests.filter((request) => request.path.endsWith("/message"))
      return { messageRequests: messages.length, messageAborts: messages.filter((r) => r.aborted).length, messageCompletions: messages.filter((r) => r.finished).length, messageMs: messages.filter((r) => r.finished).map((r) => r.finished! - r.started), allRequests: stats.requests.length, allAborts: stats.requests.filter((r) => r.aborted).length, streams: stats.streams, visible: document.body.textContent?.includes("Slow uncached message completed") }
    })
    console.log(JSON.stringify({ mode, ...report }))
    await page.evaluate(() => (window as FixtureWindow).__stop())
    expect(report.visible).toBe(true)
    expect(report.messageCompletions).toBeGreaterThan(0)
    await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
    if (mode !== "probe") expect(report.messageAborts).toBe(0)
    if (mode === "probehealthy" || mode === "comments" || mode === "data") expect(report.streams).toHaveLength(1)
    if (mode === "eof" || mode === "eofprobe") {
      expect(report.streams.length).toBeGreaterThan(2)
      expect(report.streams.length).toBeLessThanOrEqual(5)
      const gaps = report.streams.slice(1).map((stream, index) => stream.started - report.streams[index].closed!)
      gaps.forEach((gap, index) => {
        expect(gap).toBeGreaterThanOrEqual(Math.min(1000 * 2 ** index, 30000) * 0.75 - 20)
        expect(gap).toBeLessThan(Math.min(1000 * 2 ** index, 30000) + 500)
      })
    }
    if (mode === "headers") {
      expect(report.streams.length).toBeGreaterThan(1)
      expect(report.streams[0].aborted! - report.streams[0].started).toBeGreaterThanOrEqual(29000)
      expect(report.streams[0].aborted! - report.streams[0].started).toBeLessThan(31000)
    }
    if (mode === "stablebackoff") {
      expect(report.streams).toHaveLength(4)
      const gaps = report.streams.slice(1).map((stream, index) => stream.started - report.streams[index].closed!)
      gaps.forEach((gap, index) => {
        expect(gap).toBeGreaterThanOrEqual((index === 1 ? 2000 : 1000) * 0.75 - 20)
        expect(gap).toBeLessThan((index === 1 ? 2000 : 1000) + 500)
      })
      expect(report.streams[2].beats).toBeGreaterThan(0)
    }
  })
}
