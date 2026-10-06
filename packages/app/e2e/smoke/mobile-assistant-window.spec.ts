import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"

const directory = "/synthetic/assistant-window"
const project = { id: "fixture-assistant-window", worktree: directory, sandboxes: [], time: { created: 1, updated: 1 } }
const session = {
  id: "ses_assistant_window",
  projectID: project.id,
  directory,
  title: "Partial assistant window",
  slug: "assistant-window",
  version: "1",
  time: { created: 1, updated: 1 },
}
const prompt = {
  info: {
    id: "msg_000_parent",
    sessionID: session.id,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "fixture", modelID: "fixture" },
  },
  parts: [
    {
      id: "part_prompt",
      messageID: "msg_000_parent",
      sessionID: session.id,
      type: "text",
      text: "The real earlier prompt",
    },
  ],
}
const replies = Array.from({ length: 20 }, (_, index) => {
  const id = `msg_${String(index + 1).padStart(3, "0")}_reply`
  return {
    info: {
      id,
      sessionID: session.id,
      role: "assistant",
      parentID: prompt.info.id,
      agent: "build",
      mode: "build",
      modelID: "fixture",
      providerID: "fixture",
      path: { cwd: directory, root: directory },
      time: { created: index + 2, completed: index + 3 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      ...(index === 18
        ? [
            {
              id: `reasoning_${id}`,
              messageID: id,
              sessionID: session.id,
              type: "reasoning",
              text: "Visible assistant reasoning",
              time: { start: 20, end: 21 },
            },
          ]
        : []),
      ...(index === 19
        ? [
            {
              id: `tool_${id}`,
              messageID: id,
              sessionID: session.id,
              type: "tool",
              tool: "bash",
              callID: "call_fixture",
              state: {
                status: "completed",
                input: { command: "fixture-command" },
                output: "Fixture tool output",
                title: "Fixture command",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
          ]
        : []),
      {
        id: `text_${id}`,
        messageID: id,
        sessionID: session.id,
        type: "text",
        text: `Assistant reply ${String(index).padStart(2, "0")}`,
      },
    ],
  }
})
const cursor = btoa(JSON.stringify({ id: replies[0].info.id, time: replies[0].info.time.created }))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "")
type FixtureWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_CACHE__: unknown
  __HAOLAB_TRANSCRIPTS__: { scope: string; document: string }
  webkit: unknown
  __assistantFixture: {
    disk: string
    requests: string[]
    pages: { before: string | null; limit: string | null }[]
    emit?: (event: unknown) => void
  }
}

test.describe("production mobile assistant-only windows", () => {
  test.skip(!process.env.PLAYWRIGHT_MOBILE_SELECTION, "Requires an isolated same-origin production build")
  test.use({ viewport: { width: 390, height: 844 } })

  for (const mode of ["server", "offline-cache"] as const)
    test(`${mode}: renders latest twenty assistants and joins the real older prompt`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.addInitScript(
        ({ directory, project, session, prompt, replies, mode }) => {
          const host = window as FixtureWindow
          host.__HAOLAB_MOBILE__ = true
          host.__HAOLAB_CONNECTION__ = { state: mode === "server" ? "connected" : "offline", active: true, revision: 1 }
          host.__HAOLAB_CACHE__ = {
            version: 1,
            projects: [directory],
            selected: directory,
            sessions: { [directory]: [session] },
          }
          const cached = [prompt, ...replies]
          host.__assistantFixture = {
            requests: [],
            pages: [],
            disk:
              mode === "server"
                ? ""
                : JSON.stringify({
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
                  }),
          }
          host.__HAOLAB_TRANSCRIPTS__ = { scope: `tunnel.v1.${"b".repeat(64)}`, document: "assistant-fixture" }
          host.webkit = {
            messageHandlers: {
              haolabCache: { postMessage() {} },
              haolabConnection: { postMessage() {} },
              haolabTranscripts: {
                async postMessage(request: { operation: string; value?: string }) {
                  if (request.operation === "get") return host.__assistantFixture.disk || null
                  if (request.operation === "set") host.__assistantFixture.disk = request.value ?? ""
                  return null
                },
              },
            },
          }
          localStorage.setItem(
            "settings.v3",
            JSON.stringify({ general: { showReasoningSummaries: true, shellToolPartsExpanded: true } }),
          )
          const original = window.fetch.bind(window)
          window.fetch = (input, init) => {
            const request = new Request(input, init)
            const url = new URL(request.url)
            host.__assistantFixture.requests.push(url.pathname)
            if (url.pathname.endsWith("/message"))
              host.__assistantFixture.pages.push({
                before: url.searchParams.get("before"),
                limit: url.searchParams.get("limit"),
              })
            if (url.pathname !== "/global/event") return original(request)
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    host.__assistantFixture.emit = (event) =>
                      controller.enqueue(
                        new TextEncoder().encode(`data: ${JSON.stringify({ directory, payload: event })}\n\n`),
                      )
                    controller.enqueue(new TextEncoder().encode(": synthetic open stream\n\n"))
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
            )
          }
        },
        { directory, project, session, prompt, replies, mode },
      )
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        const path = url.pathname
        if (/^\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(path))
          return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
        if (path === `/session/${session.id}/message`)
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(url.searchParams.has("before") ? [prompt] : replies),
            headers: url.searchParams.has("before") ? {} : { "x-next-cursor": cursor },
          })
        const data = (() => {
          if (path === "/__haolab/projects") return { directories: [directory] }
          if (path === "/global/health") return { healthy: true, version: "fixture" }
          if (path === "/project") return [project]
          if (path === "/project/current") return project
          if (path === "/path")
            return {
              home: "/synthetic",
              state: "/synthetic/state",
              config: "/synthetic/config",
              worktree: directory,
              directory,
            }
          if (path === "/provider") return { all: [], default: {}, connected: [] }
          if (path === "/session/sidebar/snapshot") return { cursor: 1, total: 1, items: [session], next: null }
          if (path === "/session/sidebar/changes") return { cursor: 1, total: 1, changes: [], more: false }
          if (path === "/session/sidebar/reconcile")
            return { upserts: [session], removed: [], limited: false, limit: 10 }
          if (path === "/session" || path === "/experimental/session") return [session]
          if (path === `/session/${session.id}`) return session
          if (/\/session\/[^/]+\/(diff|todo|children)$/.test(path)) return []
          if (path === "/config/providers") return { providers: [], default: {} }
          if (path === "/agent") return [{ name: "build", mode: "primary", permission: [] }]
          if (["/permission", "/question", "/command", "/lsp", "/skill", "/pty", "/pty/shells"].includes(path))
            return []
          if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
        })()
        if (data === undefined) return route.fallback()
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) })
      })
      await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
      await expect(page.getByText("Assistant reply 19", { exact: true })).toBeVisible()
      await expect(page.locator('[data-component="user-message"]')).toHaveCount(0)
      await expect(page.locator('[data-component="reasoning-part"]')).toBeVisible()
      await expect(page.locator('[data-component="bash-output"] code')).toBeVisible()
      await expect(page.locator('[data-component="bash-output"] code')).toContainText("Fixture tool output")
      await expect(page.locator('[data-timeline-row="AssistantPart"]').first()).toHaveAttribute(
        "data-message-id",
        prompt.info.id,
      )
      const initial = await page.evaluate(() => (window as FixtureWindow).__assistantFixture.pages)
      expect(initial).toEqual(mode === "server" ? [{ before: null, limit: "20" }] : [])
      if (mode === "offline-cache")
        expect(await page.evaluate(() => (window as FixtureWindow).__assistantFixture.requests)).toEqual([])

      const scroller = page.getByRole("region", { name: "scrollable content", exact: true })
      const beforeScroll = await scroller.evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        client: element.clientHeight,
      }))
      // Use the viewport gutter, not nested tool output, so the gesture owns the conversation scroll.
      await scroller.hover({ position: { x: 12, y: 32 } })
      await page.mouse.wheel(0, -3000)
      await expect(page.getByText("Assistant reply 00", { exact: true })).toBeVisible()
      // Newly measured rows may compensate the offset; the first reply must remain in view.
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(48)
      await expect
        .poll(() => scroller.evaluate((element) => (element as HTMLElement).style.overflowAnchor))
        .toBe("auto")
      await testInfo.attach("assistant-user-scroll", {
        contentType: "application/json",
        body: JSON.stringify({
          mode,
          before: beforeScroll,
          after: await scroller.evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            client: element.clientHeight,
            anchor: (element as HTMLElement).style.overflowAnchor,
          })),
        }),
      })
      await expect(page.locator(`#message-${prompt.info.id}`)).toHaveCount(1)
      await page.getByRole("button", { name: "Load more", exact: true }).click()
      await scroller.hover({ position: { x: 12, y: 32 } })
      await page.mouse.wheel(0, -3000)
      await expect(page.getByText("The real earlier prompt", { exact: true })).toBeVisible()
      await expect(page.locator('[data-component="user-message"]')).toHaveCount(1)
      await expect(page.locator(`#message-${prompt.info.id}`)).toHaveCount(1)
      await expect(page.getByText("Assistant reply 00", { exact: true })).toHaveCount(1)
      const after = await page.evaluate(() => (window as FixtureWindow).__assistantFixture.pages)
      expect(after).toEqual(
        mode === "server"
          ? [
              { before: null, limit: "20" },
              { before: cursor, limit: "20" },
            ]
          : [],
      )
      if (mode === "server") {
        await page.evaluate(
          ({ reply, directory, session }) => {
            const emit = (window as FixtureWindow).__assistantFixture.emit
            emit?.({
              type: "message.updated",
              properties: {
                info: {
                  ...reply.info,
                  id: "msg_live_reply",
                  parentID: "msg_missing_live_parent",
                  time: { created: 100, completed: 101 },
                },
              },
            })
            emit?.({
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_live",
                  messageID: "msg_live_reply",
                  sessionID: session.id,
                  type: "text",
                  text: "Live assistant without a loaded prompt",
                },
              },
            })
          },
          { reply: replies[19], directory, session },
        )
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
          element.dispatchEvent(new Event("scroll"))
        })
        await expect(page.getByText("Live assistant without a loaded prompt", { exact: true })).toBeVisible()
        await expect(
          page.locator('[data-timeline-row="AssistantPart"][data-message-id="msg_missing_live_parent"]'),
        ).toHaveCount(1)
        expect(await page.evaluate(() => (window as FixtureWindow).__assistantFixture.pages)).toEqual(after)
        await expect
          .poll(() => scroller.evaluate((element) => (element as HTMLElement).style.overflowAnchor))
          .toBe("none")
        await page.evaluate((id) => {
          history.pushState(null, "", `${location.pathname}#message-${id}`)
          window.dispatchEvent(new PopStateEvent("popstate"))
        }, prompt.info.id)
        await expect(page).toHaveURL(new RegExp(`#message-${prompt.info.id}$`))
        await expect(page.getByText("The real earlier prompt", { exact: true })).toBeVisible()
        expect(await page.evaluate(() => (window as FixtureWindow).__assistantFixture.pages)).toEqual(after)
      }
      expect(errors).toEqual([])
      expect(await page.evaluate(() => (window as FixtureWindow).__assistantFixture.requests
        .filter((path) => path.includes("/transcript/"))))
        .toEqual(mode === "server" ? [`/session/${session.id}/transcript/snapshot`] : [])
      await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
    })
})
