import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"

const directory = "/synthetic/warm"
const project = { id: "fixture-warm", name: "Warm fixture", worktree: directory, sandboxes: [], time: { created: 1700000000000, updated: 1700000000000 } }
const session = { id: "ses_warm_fixture", projectID: project.id, directory, title: "Synthetic warm session", slug: "warm", version: "1", time: { created: 1700000000000, updated: 1700000000000 } }
const messages = Array.from({ length: 60 }, (_, index) => ({
  info: { id: `msg_fixture_${String(index).padStart(2, "0")}`, sessionID: session.id, role: "user", time: { created: 1700000000000 + index }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } },
  parts: [{ id: `part_fixture_${index}`, sessionID: session.id, messageID: `msg_fixture_${String(index).padStart(2, "0")}`, type: "text", text: `Synthetic cached ${index}` }],
}))
const cursor = (index: number) => btoa(JSON.stringify({ id: messages[index].info.id, time: messages[index].info.time.created })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
type RecoveryWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_CACHE__: unknown
  __HAOLAB_TRANSCRIPTS__: { scope: string; document: string }
  webkit: unknown
  __recovery: {
    document: string
    disk: string
    arm?: string
    body: boolean
    release?: () => void
    handshake?: () => void
    dispose?: () => void
    held?: { path: string; started: number; aborted?: number }
    requests: { path: string; before: string | null; directory: string | null; method: string }[]
  }
}

test.describe("smoke: warm mobile recovery", () => {
  test.skip(!process.env.PLAYWRIGHT_MOBILE_SELECTION, "Requires a same-origin production build; set PLAYWRIGHT_MOBILE_SELECTION=1")
  test.use({ viewport: { width: 390, height: 844 } })

  for (const scenario of [
    { endpoint: "/permission", body: false },
    { endpoint: "/session/status", body: false },
    { endpoint: `/session/${session.id}/message`, body: false },
    { endpoint: "/global/config", body: false },
    { endpoint: `/session/${session.id}/message`, body: true },
    { endpoint: "/global/event", body: false },
    { endpoint: "/session/sidebar/reconcile", body: false },
    { endpoint: "/session/sidebar/reconcile", body: true },
  ]) test(`supersedes held ${scenario.endpoint}${scenario.body ? " body" : " headers"} without losing the warm page`, async ({ page }) => {
    let fresh = 0
    let documents = 0
    const errors: string[] = []
    page.on("request", (request) => { if (request.isNavigationRequest()) documents++ })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(({ project, session, messages, initialCursor }) => {
      const host = window as RecoveryWindow
      Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
      Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { configurable: true, value: undefined })
      host.__HAOLAB_MOBILE__ = true
      host.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
      host.__HAOLAB_CACHE__ = { version: 1, projects: [project.worktree, "/synthetic/unselected"], selected: project.worktree, sessions: { [project.worktree]: [session] } }
      const cached = messages.slice(-40)
      host.__recovery = { document: crypto.randomUUID(), body: false, requests: [], disk: JSON.stringify({ version: 1, entries: [{
        directory: project.worktree, sessionID: session.id, session: cached.map((message) => message.info),
        part: cached.map((message) => ({ id: message.info.id, part: message.parts })), complete: false, cursor: initialCursor, updated: session.time.updated,
      }] }) }
      host.__HAOLAB_TRANSCRIPTS__ = { scope: `tunnel.v1.${"a".repeat(64)}`, document: host.__recovery.document }
      host.webkit = { messageHandlers: {
        haolabCache: { postMessage() {} },
        haolabTranscripts: { async postMessage(request: { operation: string; value: string }) {
          if (request.operation === "get") return host.__recovery.disk
          if (request.operation === "set") host.__recovery.disk = request.value
          return null
        } },
        haolabConnection: { postMessage() {
          host.__HAOLAB_CONNECTION__.revision++
          window.dispatchEvent(new CustomEvent("haolab:connection", { detail: { ...host.__HAOLAB_CONNECTION__ } }))
        } },
      } }
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const fixture = host.__recovery
        fixture.requests.push({ path: url.pathname, before: url.searchParams.get("before"), directory: url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory"), method: request.method })
        if (url.pathname === fixture.arm) {
          fixture.arm = undefined
          const held = { path: url.pathname, started: performance.now(), aborted: undefined as number | undefined }
          fixture.held = held
          request.signal.addEventListener("abort", () => { held.aborted = performance.now() })
          const stale = url.pathname.endsWith("/message") ? messages.slice(-20)
            : url.pathname === "/session/sidebar/reconcile" ? { upserts: [], removed: [session.id], limited: false, limit: 10 }
            : url.pathname === "/permission" ? [] : { username: "stale" }
          // Deliberately ignore abort, as an obsolete native request may do. The production
          // transport must settle on cancellation and reject this eventual stale result.
          if (!fixture.body) return new Promise<Response>((resolve) => {
            fixture.release = () => resolve(Response.json(stale))
          })
          return Promise.resolve(new Response(new ReadableStream({ start(controller) {
            const text = JSON.stringify(stale)
            controller.enqueue(new TextEncoder().encode(text.slice(0, 1)))
            fixture.release = () => { controller.enqueue(new TextEncoder().encode(text.slice(1))); controller.close() }
          } }), { headers: { "content-type": "application/json" } }))
        }
        if (url.pathname === "/global/event") return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          fixture.handshake = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`))
          fixture.dispose = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: "global", payload: { type: "global.disposed", properties: {} } })}\n\n`))
          fixture.handshake()
        } }), { headers: { "content-type": "text/event-stream" } }))
        return original(request)
      }
    }, { project, session, messages, initialCursor: cursor(20) })
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path))
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      if (scenario.endpoint === "/session/sidebar/reconcile" && (path === "/session/sidebar/snapshot" || path === "/session/sidebar/changes"))
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      const data = (() => {
        if (path === "/__haolab/projects") return { directories: [directory, "/synthetic/unselected"] }
        if (path === "/global/health") return { healthy: true, version: "fixture" }
        if (path === "/project") return [{ ...project, name: `Synthetic project ${fresh}` }]
        if (path === "/project/current") return project
        if (path === "/path") return { home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: directory, directory }
        if (path === "/provider") return { all: [{ id: "fixture", name: `Synthetic provider ${fresh}`, env: [], models: {}, source: "env" }], default: {}, connected: ["fixture"] }
        if (path === "/global/config") return { shell: `Synthetic shell ${fresh}` }
        if (path === "/pty/shells") return []
        if (path === "/session/sidebar/snapshot") return { cursor: 1, total: 1, items: [session], next: null }
        if (path === "/session/sidebar/changes") return { cursor: 1, total: 1, changes: [], more: false }
        if (path === "/session/sidebar/reconcile") return { upserts: [session], removed: [], limited: false, limit: 10 }
        if (path === "/session" || path === "/experimental/session") return [session]
        if (path === `/session/${session.id}`) return session
        if (/\/session\/[^/]+\/(diff|todo|children)$/.test(path)) return []
        if (path === "/config/providers") return { providers: [], default: {} }
        if (path === "/agent") return [{ name: "build", mode: "primary", permission: [] }]
        if (["/permission", "/question", "/command", "/lsp", "/skill", "/pty"].includes(path)) return []
        if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
      })()
      if (path === `/session/${session.id}/message`) {
        const before = url.searchParams.get("before")
        const index = before === cursor(40) ? 40 : before === cursor(20) ? 20 : 60
        return route.fulfill({ contentType: "application/json", headers: index > 20 ? { "x-next-cursor": cursor(index - 20) } : {},
          body: JSON.stringify(messages.slice(index - 20, index).map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part,
            text: message.info.id === messages[59].info.id && fresh ? `Synthetic fresh ${fresh}` : part.text,
          })) }))),
        })
      }
      if (data === undefined) return route.fallback()
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) })
    })
    await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
    await expect(page.getByText("Synthetic cached 59", { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as RecoveryWindow).__recovery.requests.filter((request) => request.path.endsWith("/message")).length)).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    await page.getByRole("button", { name: "Load more", exact: true }).click()
    const draft = page.locator('[data-component="prompt-input"][contenteditable="true"]:visible')
    await draft.fill("Synthetic unsent draft")
    const identity = await page.evaluate(() => (window as RecoveryWindow).__recovery.document)
    const globalCounts = () => page.evaluate(() => {
      const requests = (window as RecoveryWindow).__recovery.requests
      return Object.fromEntries(["/global/config", "/provider", "/path", "/project"].map((path) => [path,
        requests.filter((request) => request.path === path && request.directory === null).length,
      ]))
    })
    const checkShell = async (version: number) => {
      await page.keyboard.press("Meta+,")
      await expect(page.locator('[data-action="settings-shell"]')).toContainText(`Synthetic shell ${version}`)
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-action="settings-shell"]')).toHaveCount(0)
    }
    await checkShell(0)
    const timings: number[] = []
    const transition = async (state: string, active: boolean, revision: number) => page.evaluate(({ state, active, revision }) => {
      const host = window as RecoveryWindow
      host.__HAOLAB_CONNECTION__ = { state, active, revision }
      window.dispatchEvent(new CustomEvent("haolab:connection", { detail: { ...host.__HAOLAB_CONNECTION__ } }))
    }, { state, active, revision })
    for (let cycle = 0; cycle < 4; cycle++) {
      const beforeArmGlobals = await globalCounts()
      await page.evaluate((scenario) => {
        const fixture = (window as RecoveryWindow).__recovery
        fixture.arm = scenario.endpoint
        fixture.body = scenario.body
        fixture.held = undefined
      }, scenario)
      const revision = 2 + cycle * 3
      await transition("connected", false, revision)
      await transition("connecting", true, revision)
      await transition("connected", true, revision)
      await expect.poll(() => page.evaluate(() => !!(window as RecoveryWindow).__recovery.held), { timeout: 4000 }).toBe(true)
      // The held directory request can start before the global queries are dispatched.
      await expect.poll(globalCounts, { message: `${scenario.endpoint} cycle ${cycle}: global reads started` })
        .toEqual(Object.fromEntries(Object.entries(beforeArmGlobals).map(([path, count]) => [path, count + 1])))
      const attempts = await page.evaluate((endpoint) => (window as RecoveryWindow).__recovery.requests.filter((request) => request.path === endpoint).length, scenario.endpoint)
      const beforeGlobals = await globalCounts()
      const started = Date.now()
      fresh++
      if (cycle === 0) {
        await transition("connected", false, revision)
        await expect.poll(() => page.evaluate(() => (window as RecoveryWindow).__recovery.held?.aborted)).toBeDefined()
        await expect(draft).toHaveText("Synthetic unsent draft")
        await expect(page.getByText("Synthetic cached 59", { exact: true })).toBeAttached()
        await transition("connecting", true, revision + 1)
        await transition("connected", true, revision + 1)
      } else if (cycle === 3) {
        // Confirmed offline cancels once even without a new recovery revision.
        await transition("offline", true, revision)
        await expect.poll(() => page.evaluate(() => (window as RecoveryWindow).__recovery.held?.aborted)).toBeDefined()
        await transition("connected", true, revision)
      } else if (cycle === 1 || scenario.endpoint === "/global/event") {
        // Manual refresh while already connected must supersede the old epoch immediately.
        await transition("connected", true, revision + 1)
      } else {
        // Stream-only reconciliation must let the finite reader reach its own deadline.
        await page.waitForTimeout(1200)
        await page.evaluate(() => (window as RecoveryWindow).__recovery.handshake?.())
        await page.waitForTimeout(300)
        expect(await page.evaluate(() => (window as RecoveryWindow).__recovery.held?.aborted)).toBeUndefined()
      }
      const streamOnly = cycle === 2 && scenario.endpoint !== "/global/event"
      await expect(page.getByText(`Synthetic fresh ${fresh}`, { exact: true })).toBeAttached({ timeout: streamOnly ? 12000 : 4000 })
      await expect.poll(() => page.evaluate(() => (window as RecoveryWindow).__recovery.held?.aborted)).toBeDefined()
      await expect.poll(() => page.evaluate((endpoint) => (window as RecoveryWindow).__recovery.requests.filter((request) => request.path === endpoint).length, scenario.endpoint), { timeout: 4000 }).toBeGreaterThan(attempts)
      // Genuine recovery refreshes its snapshot and then reconciles the new subscription.
      // Stream-only handshakes coalesce behind the existing reader into one gap-fill.
      await expect.poll(globalCounts, { message: `${scenario.endpoint} cycle ${cycle}: snapshot and subscription refreshes` })
        .toEqual(Object.fromEntries(Object.entries(beforeGlobals).map(([path, count]) => [path, count + (streamOnly ? 1 : 2)])))
      expect(Date.now() - started).toBeLessThan(streamOnly ? 13000 : 5000)
      if (streamOnly) expect(await page.evaluate(() => {
        const held = (window as RecoveryWindow).__recovery.held!
        return held.aborted! - held.started
      })).toBeGreaterThan(9000)
      timings.push(Date.now() - started)
      await page.evaluate(() => (window as RecoveryWindow).__recovery.release?.())
      await page.waitForTimeout(100)
      await expect(page.getByText(`Synthetic fresh ${fresh}`, { exact: true })).toBeAttached()
      await checkShell(fresh)
      const settledGlobals = await globalCounts()
      for (let repeat = 0; repeat < 3; repeat++) await transition("connected", true, cycle === 3 || cycle === 2 && scenario.endpoint !== "/global/event" ? revision : revision + 1)
      await page.waitForTimeout(100)
      expect(await globalCounts()).toEqual(settledGlobals)
      await expect(draft).toHaveText("Synthetic unsent draft")
      await expect(page.getByRole("button", { name: "Load more", exact: true })).toBeEnabled()
      await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
      expect(await page.evaluate(() => (window as RecoveryWindow).__recovery.document)).toBe(identity)
      const requests = await page.evaluate(() => (window as RecoveryWindow).__recovery.requests)
      expect(requests.filter((request) => request.method !== "GET" &&
        !(request.method === "POST" && request.path === "/session/sidebar/reconcile"))).toEqual([])
      expect(requests.some((request) => request.directory === "/synthetic/unselected" && request.path.startsWith("/session"))).toBe(false)
      expect(requests.some((request) => request.path.endsWith("/message") && request.before === cursor(20))).toBe(false)
    }
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse((window as RecoveryWindow).__recovery.disk).entries
      return entries[0].session.length
    })).toBe(40)
    // Disposal is not a native epoch change. Successful global caches must still be dirtied.
    await page.waitForTimeout(2000)
    const beforeDisposed = await globalCounts()
    fresh++
    await page.evaluate(() => {
      const fixture = (window as RecoveryWindow).__recovery
      fixture.dispose?.()
      fixture.dispose?.()
    })
    await checkShell(fresh)
    await expect.poll(globalCounts, { message: `${scenario.endpoint}: coalesced disposal refresh` }).toEqual(Object.fromEntries(Object.entries(beforeDisposed).map(([path, count]) => [path, count + 1])))
    await page.locator('[data-component="mobile-header"] button[aria-controls="sidebar-nav-mobile"]').click()
    await expect(page.locator('[data-component="home-project-row"]').filter({ hasText: `Synthetic project ${fresh}` })).toBeVisible()
    await page.locator('[data-component="mobile-header"] button[aria-controls="sidebar-nav-mobile"]').click()
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await page.keyboard.press("Meta+,")
    await page.getByRole("tab", { name: "Providers", exact: true }).click()
    await expect(page.locator('[data-component="connected-providers-section"]')).toContainText(`Synthetic provider ${fresh}`)
    expect(await globalCounts()).toEqual(Object.fromEntries(Object.entries(beforeDisposed).map(([path, count]) => [path, count + 1])))
    expect(await page.evaluate(() => (window as RecoveryWindow).__recovery.document)).toBe(identity)
    expect(documents).toBe(1)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as RecoveryWindow).__recovery.requests
      .filter((request) => request.path.includes("/transcript/")).map((request) => request.path)))
      .toEqual([`/session/${session.id}/transcript/snapshot`])
    console.log(JSON.stringify({ endpoint: scenario.endpoint, body: scenario.body, cycles: 4, documents, preservedMessages: 40, globalsUpdated: true, globalDisposedUpdated: true, sameEpochDuplicates: 0, abortSignalAny: "unavailable", recoveryMs: timings }))
  })
})
