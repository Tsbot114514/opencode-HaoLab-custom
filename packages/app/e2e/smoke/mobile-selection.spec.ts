import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"

const projects = ["alpha", "beta"].map((name) => ({
  id: `fixture-${name}`, name, worktree: `/synthetic/${name}`, sandboxes: [],
  time: { created: 1700000000000, updated: 1700000000000 },
}))
const sessions = projects.flatMap((project) => Array.from({ length: 12 }, (_, index) => ({
  id: `ses_${project.name}_${index}`, projectID: project.id, directory: project.worktree,
  title: `${project.name} session ${index}`, slug: `${project.name}-${index}`, version: "1",
  time: { created: 1700000000000 + index, updated: 1700000000000 + index },
})))
type FixtureWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_CACHE__: unknown
  __selectionWrites: string[]
  __sessionRequests: { path: string; started: number; aborted?: number; finished?: number }[]
  __sessionWrites: unknown[]
  __document: string
  webkit: unknown
}

test.describe("smoke: mobile default selection", () => {
  test.skip(!process.env.PLAYWRIGHT_MOBILE_SELECTION, "Requires a same-origin production build; set PLAYWRIGHT_MOBILE_SELECTION=1")
  test.use({ viewport: { width: 390, height: 844 } })

  test("persists the displayed default and refreshes cached sessions without resetting pagination", async ({ page }) => {
    const loads: string[] = []
    const sessionReads: string[] = []
    const transcriptProbes: string[] = []
    const ownership = (directory: string) => page.evaluate((directory) => {
      const value = localStorage.getItem("opencode.global.dat:layout.page")
      if (!value) return
      return (JSON.parse(value) as {
        lastProjectSession: Record<string, { id: string; directory: string; at: number }>
      }).lastProjectSession[directory]
    }, directory)
    let refreshed = false
    await page.addInitScript((projects) => {
      const fixture = window as FixtureWindow
      fixture.__HAOLAB_MOBILE__ = true
      fixture.__HAOLAB_CONNECTION__ = { state: "connecting", active: true, revision: 1 }
      fixture.__HAOLAB_CACHE__ = { version: 1, projects: projects.map((project) => project.worktree), sessions: {} }
      fixture.__selectionWrites = []
      fixture.webkit = { messageHandlers: {
        haolabCache: { postMessage: (value: { type: string; directory: string }) => {
          if (value.type === "selected") fixture.__selectionWrites.push(value.directory)
        } },
        haolabConnection: { postMessage: () => {
          fixture.__HAOLAB_CONNECTION__.revision++
          window.dispatchEvent(new CustomEvent("haolab:connection", { detail: { ...fixture.__HAOLAB_CONNECTION__ } }))
        } },
      } }
    }, projects)
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path)) {
        transcriptProbes.push(path)
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      }
      const directory = url.searchParams.get("directory") ?? route.request().headers()["x-opencode-directory"] ?? projects[0].worktree
      const project = projects.find((project) => project.worktree === directory) ?? projects[0]
      const entries = sessions.filter((session) => session.directory === directory).map((session) => ({
        ...session, title: refreshed ? `${session.title} refreshed` : session.title,
      }))
      const data = (() => {
        if (path === "/__haolab/projects") return { directories: projects.map((project) => project.worktree) }
        if (path === "/global/health") return { healthy: true, version: "fixture" }
        if (path === "/project") return projects
        if (path === "/project/current") return project
        if (path === "/path") return { home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: project.worktree, directory }
        if (path === "/provider") return { all: [], default: {}, connected: [] }
        if (path === "/vcs") return { branch: "fixture" }
        if (path === "/session/sidebar/snapshot") {
          loads.push(directory)
          return { cursor: 1, total: entries.length, items: entries, next: null }
        }
        if (path === "/session/sidebar/changes") {
          loads.push(directory)
          return { cursor: 1, total: entries.length, changes: [], more: false }
        }
        if (path === "/session" || path === "/experimental/session") return entries
        if (/^\/session\/ses_[^/]+$/.test(path)) {
          sessionReads.push(path.split("/")[2])
          return sessions.find((session) => path.endsWith(session.id))
        }
        if (/\/session\/[^/]+\/(message|diff|todo|children)$/.test(path)) {
          if (path.endsWith("/message")) sessionReads.push(path.split("/")[2])
          return []
        }
        if (path === "/config/providers") return { providers: [], default: {} }
        if (["/permission", "/question", "/agent", "/command", "/lsp", "/skill", "/pty"].includes(path)) return []
        if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
      })()
      if (path === "/global/event" || path === "/event")
        return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
      if (data === undefined) return route.fallback()
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) })
    })
    await page.goto("/")
    const home = page.locator('[data-component="home-design"]:not([data-drawer])')
    await expect(home.getByRole("status")).toContainText("Syncing")
    expect(loads).toEqual([])
    await page.evaluate(() => {
      const fixture = window as FixtureWindow
      fixture.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
      window.dispatchEvent(new CustomEvent("haolab:connection", { detail: fixture.__HAOLAB_CONNECTION__ }))
    })
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__selectionWrites)).toEqual([projects[0].worktree])
    await expect(home.getByText("alpha session 11", { exact: true })).toBeVisible()
    await home.getByRole("button", { name: /load more/i }).click()
    await expect(home.getByText("alpha session 0", { exact: true })).toBeVisible()
    const before = loads.length
    refreshed = true
    await home.getByRole("button", { name: "Refresh projects and sessions" }).click()
    await expect.poll(() => loads.length).toBeGreaterThan(before)
    await expect(home.getByText("alpha session 0 refreshed", { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__selectionWrites)).toEqual([projects[0].worktree])

    // A drawer's explicit choice must not fight subsequent session route ownership.
    await home.getByText("alpha session 11 refreshed", { exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${base64Encode(projects[0].worktree)}/session/ses_alpha_11$`))
    await page.locator('[data-component="mobile-header"] button[aria-controls="sidebar-nav-mobile"]').click()
    await page.locator('[data-component="home-design"][data-drawer] [data-component="home-project-row"]').filter({ hasText: "beta" }).click()
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__selectionWrites)).toEqual([projects[0].worktree, projects[1].worktree])
    await page.evaluate((directory) => {
      history.pushState(null, "", `/${directory}/session/ses_beta_11`)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, base64Encode(projects[1].worktree))
    await expect(page).toHaveURL(new RegExp(`${base64Encode(projects[1].worktree)}/session/ses_beta_11$`))
    await expect.poll(() => sessionReads.includes("ses_beta_11")).toBe(true)
    await expect.poll(() => ownership(projects[1].worktree)).toMatchObject({ directory: projects[1].worktree, id: "ses_beta_11" })
    const previousAlpha = await ownership(projects[0].worktree)
    const alphaTransition = await page.evaluate((directory) => {
      history.pushState(null, "", `/${directory}/session/ses_alpha_11`)
      window.dispatchEvent(new PopStateEvent("popstate"))
      return Date.now()
    }, base64Encode(projects[0].worktree))
    await expect(page).toHaveURL(new RegExp(`${base64Encode(projects[0].worktree)}/session/ses_alpha_11$`))
    // The URL changes before Layout touches the project and records the active session.
    await expect.poll(async () => (await ownership(projects[0].worktree))?.at ?? 0).toBeGreaterThan(previousAlpha?.at ?? 0)
    await expect.poll(() => ownership(projects[0].worktree)).toMatchObject({ directory: projects[0].worktree, id: "ses_alpha_11" })
    console.log(JSON.stringify({ phase: "alpha-route-owned", afterMs: (await ownership(projects[0].worktree))!.at - alphaTransition }))
    await page.locator('[data-component="mobile-header"] button[aria-controls="sidebar-nav-mobile"]').click()
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(home.locator('[data-component="home-project-row"][data-selected]')).toContainText("alpha")
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__selectionWrites)).toEqual([projects[0].worktree, projects[1].worktree, projects[0].worktree])
    // This fixture has no native transcript storage, so the feed is never probed.
    expect(transcriptProbes).toEqual([])
    await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
  })

  for (const scenario of [
    { endpoint: "/session/sidebar/snapshot", cached: true },
    { endpoint: "/session/sidebar/reconcile", cached: true },
    { endpoint: "/experimental/session", cached: true },
    { endpoint: "/session/sidebar/snapshot", cached: false },
  ]) {
    const endpoint = scenario.endpoint
    test(scenario.cached ? `aborts a held ${endpoint} load and refreshes without losing cached sessions`
      : "loads sessions after a delayed initial connection with no cache", async ({ page }) => {
      let attempts = 0
      let documents = 0
      const responses: { path: string; status: number }[] = []
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname
        if (["/__haolab/projects", "/project", "/path", "/global/config", endpoint].includes(path))
          responses.push({ path, status: response.status() })
      })
      await page.addInitScript(({ project, session, cached }) => {
        const fixture = window as FixtureWindow
        fixture.__HAOLAB_MOBILE__ = true
        fixture.__HAOLAB_CONNECTION__ = { state: "connecting", active: true, revision: 1 }
        fixture.__HAOLAB_CACHE__ = { version: 1, projects: cached ? [project.worktree] : [], selected: cached ? project.worktree : undefined,
          sessions: cached ? { [project.worktree]: [{ ...session, title: "Cached session" }] } : {} }
        fixture.__document = crypto.randomUUID()
        fixture.__sessionRequests = []
        fixture.__sessionWrites = []
        fixture.webkit = { messageHandlers: {
          haolabCache: { postMessage: (value: { type: string }) => {
            if (value.type === "sessions") fixture.__sessionWrites.push(value)
          } },
          haolabConnection: { postMessage: () => {
            fixture.__HAOLAB_CONNECTION__.revision++
            window.dispatchEvent(new CustomEvent("haolab:connection", { detail: { ...fixture.__HAOLAB_CONNECTION__ } }))
          } },
        } }
        const original = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          if (path.startsWith("/session/sidebar/") || path === "/experimental/session") {
            const entry: FixtureWindow["__sessionRequests"][number] = { path, started: performance.now() }
            fixture.__sessionRequests.push(entry)
            request.signal.addEventListener("abort", () => {
              if (entry.finished === undefined) entry.aborted = performance.now()
            })
            return original(request).finally(() => { entry.finished = performance.now() })
          }
          return original(request)
        }
      }, { project: projects[0], session: sessions[0], cached: scenario.cached })
      await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname
        if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path))
          return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
        if (route.request().isNavigationRequest()) documents++
        if (path === endpoint && ++attempts === 1 && scenario.cached) return
        if ((path === "/session/sidebar/snapshot" && endpoint !== path) ||
          (path === "/session/sidebar/reconcile" && endpoint === "/experimental/session")) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
        }
        const data = (() => {
          if (path === "/__haolab/projects") return { directories: [projects[0].worktree] }
          if (path === "/global/health") return { healthy: true, version: "fixture" }
          if (path === "/project") return [{ ...projects[0], name: "Server project metadata" }]
          if (path === "/project/current") return projects[0]
          if (path === "/path") return { home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: projects[0].worktree, directory: projects[0].worktree }
          if (path === "/provider") return { all: [], default: {}, connected: [] }
          if (path === "/session/sidebar/snapshot") return { cursor: 1, total: 1, items: [sessions[0]], next: null }
          if (path === "/session/sidebar/reconcile") return { upserts: [sessions[0]], removed: [], limited: false, limit: 10 }
          if (path === "/experimental/session") return [sessions[0]]
          if (path === "/config/providers") return { providers: [], default: {} }
          if (["/permission", "/question", "/agent", "/command", "/lsp", "/skill", "/pty"].includes(path)) return []
          if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
        })()
        if (path === "/global/event" || path === "/event")
          return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" })
        if (data === undefined) return route.fallback()
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) })
      })
      await page.goto("/")
      const document = await page.evaluate(() => (window as FixtureWindow).__document)
      const home = page.locator('[data-component="home-design"]:not([data-drawer])')
      await expect(home.getByRole("status")).toContainText("Syncing")
      expect(responses).toEqual([])
      expect(attempts).toBe(0)
      if (scenario.cached) {
        await expect(home.getByText("Cached session", { exact: true })).toBeVisible()
        await page.evaluate(() => {
          const fixture = window as FixtureWindow
          fixture.__HAOLAB_CONNECTION__ = { state: "offline", active: true, revision: 1 }
          window.dispatchEvent(new CustomEvent("haolab:connection", { detail: fixture.__HAOLAB_CONNECTION__ }))
        })
        await expect(home.getByRole("status")).toContainText("Offline")
        await expect(home.getByText("Cached session", { exact: true })).toBeVisible()
      }
      await page.evaluate(() => {
        const fixture = window as FixtureWindow
        fixture.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
      })
      // Native can already be connected while the page still awaits its state event.
      await expect(home.getByRole("status")).toContainText(scenario.cached ? "Offline" : "Syncing")
      expect(attempts).toBe(0)
      expect(responses).toEqual([])
      await page.evaluate(() => {
        const fixture = window as FixtureWindow
        window.dispatchEvent(new CustomEvent("haolab:connection", { detail: fixture.__HAOLAB_CONNECTION__ }))
      })
      await expect.poll(() => attempts).toBe(1)
      await expect(home.locator('[data-component="home-project-row"]')).toContainText("Server project metadata")
      await expect.poll(() => responses.filter((response) => response.path === "/project" && response.status === 200).length).toBe(1)
      await expect.poll(() => responses.filter((response) => response.path === "/__haolab/projects" && response.status === 200).length).toBe(1)
      if (!scenario.cached) {
        await expect(home.getByText(sessions[0].title, { exact: true })).toBeVisible()
        await expect(home.getByRole("status")).toContainText("Synced")
        expect(await page.evaluate(() => (window as FixtureWindow).__document)).toBe(document)
        expect(documents).toBe(1)
        console.log(JSON.stringify({ phase: "cold-connected", endpoint, attempts, responses, documents }))
        return
      }
      await expect(home.getByText("Cached session", { exact: true })).toBeVisible()
      await expect(home.getByRole("status")).toContainText("Syncing")
      await expect(home.getByRole("status")).toContainText("Request failed", { timeout: 15_000 })
      const requests = await page.evaluate(() => (window as FixtureWindow).__sessionRequests)
      const held = requests.find((request) => request.path === endpoint)
      expect(held?.aborted).toBeDefined()
      expect(held!.aborted! - held!.started).toBeLessThan(12_000)
      expect(held!.aborted! - requests[0].started).toBeLessThan(12_000)
      expect(requests.filter((request) => request.aborted !== undefined)).toHaveLength(1)
      expect(attempts).toBe(1)
      await expect(home.getByText("Cached session", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => (window as FixtureWindow).__sessionWrites)).toEqual([])
      await home.getByRole("button", { name: "Refresh projects and sessions" }).click()
      await expect(home.getByText(sessions[0].title, { exact: true })).toBeVisible()
      await expect(home.getByRole("status")).toContainText("Synced")
      expect(attempts).toBe(2)
      expect(await page.evaluate(() => (window as FixtureWindow).__document)).toBe(document)
      expect(documents).toBe(1)
      console.log(JSON.stringify({ phase: "cached-timeout-recovered", endpoint, attempts,
        aborts: requests.filter((request) => request.aborted !== undefined).length,
        abortedAfterMs: held!.aborted! - held!.started, responses, documents }))
    })
  }
})
