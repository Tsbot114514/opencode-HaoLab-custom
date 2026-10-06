import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Event, Message, Part, Session, SessionTranscriptChangesResponse, SessionTranscriptSnapshotResponse } from "@opencode-ai/sdk/v2/client"
import { validEntry, type TranscriptEntry } from "../../src/context/global-sync/transcript-cache"

const directory = "/synthetic/supported-feed"
const project = { id: "fixture-supported-feed", name: "Supported feed fixture", worktree: directory, sandboxes: [], time: { created: 1, updated: 1 } }
const session: Session = { id: "ses_supported_feed", projectID: project.id, directory, slug: "supported-feed", title: "Supported feed fixture", version: "1", time: { created: 1, updated: 40 } }
const generation = "fixture-generation-original"
const baseCursor = "opaque:original/snapshot?checkpoint"
const toolOutput = `TOOL-BEGIN\n${"x".repeat(100_000)}\nTOOL-END`
const message = (index: number): Message => ({
  id: `msg_${String(index).padStart(4, "0")}`, sessionID: session.id, role: "user", time: { created: index + 1 },
  agent: "build", model: { providerID: "fixture", modelID: "fixture" },
})
const text = (info: Message, body: string): Extract<Part, { type: "text" }> => ({
  id: `text_${info.id}`, sessionID: session.id, messageID: info.id, type: "text", text: body, time: { start: info.time.created, end: info.time.created + 1 },
})
const items = Array.from({ length: 40 }, (_, index) => {
  const info: Message = index % 2 === 0 ? message(index) : {
    id: message(index).id, sessionID: session.id, role: "assistant", parentID: message(index - 1).id,
    time: { created: index + 1, completed: index + 2 }, agent: "build", mode: "build", modelID: "fixture", providerID: "fixture",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const parts: Part[] = [text(info, `Fixture message ${index}`)]
  if (index === 39) parts.push({
    id: "tool_unchanged", messageID: info.id, sessionID: session.id, type: "tool", tool: "bash", callID: "call_unchanged",
    state: { status: "completed", input: { command: "fixture-command" }, output: toolOutput, title: "Fixture tool", metadata: {}, time: { start: 40, end: 41 } },
  })
  return { info, parts }
})
// The wire contract permits null; the current generated SDK incorrectly narrows next to string.
const snapshot = (body = items.slice(-20), cursor = baseCursor, epoch = generation, version = 10) => ({
  session, status: { type: "idle" }, items: body, cursor, generation: epoch, version, next: null,
}) satisfies Omit<SessionTranscriptSnapshotResponse, "next"> & { next: string | null }
const delta = (cursor: string, changes: SessionTranscriptChangesResponse["changes"] = [], more = false, epoch = generation): SessionTranscriptChangesResponse => ({
  cursor, highwater: "opaque:fixture/highwater", generation: epoch, more, changes, status: { type: "idle" },
})
type FixtureWindow = Window & {
  __HAOLAB_MOBILE__: boolean
  __HAOLAB_CONNECTION__: { state: string; active: boolean; revision: number }
  __HAOLAB_TRANSCRIPTS__: { scope: string; document: string }
  __HAOLAB_CACHE__: unknown
  webkit: unknown
  __feedFixture: { document: string; emit?: (event: unknown) => void; streams: number }
}

async function fixture(page: Page, initial?: TranscriptEntry) {
  if (initial) expect(validEntry(initial)).toBe(true)
  let disk = initial ? JSON.stringify({ version: 1, entries: [initial] }) : ""
  const reads: { path: string; cursor: string | null; limit: string | null; bytes?: number; status?: number }[] = []
  const errors: string[] = []
  let documents = 0
  const replies: ((route: Route, read: (typeof reads)[number]) => Promise<void>)[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => { if (request.isNavigationRequest()) documents++ })
  await page.addInitScript(({ directory, project, session }) => {
    const host = window as FixtureWindow
    const original = window.fetch.bind(window)
    host.__HAOLAB_MOBILE__ = true
    host.__HAOLAB_CONNECTION__ = { state: "connected", active: true, revision: 1 }
    host.__feedFixture = { document: crypto.randomUUID(), streams: 0 }
    host.__HAOLAB_TRANSCRIPTS__ = { scope: `tunnel.v1.${"c".repeat(64)}`, document: host.__feedFixture.document }
    host.__HAOLAB_CACHE__ = { version: 1, projects: [directory], selected: directory, sessions: { [directory]: [session] } }
    host.webkit = { messageHandlers: {
      haolabCache: { postMessage() {} }, haolabConnection: { postMessage() {} },
      haolabTranscripts: { async postMessage(request: unknown) {
        return original("/__fixture/native-transcripts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }).then((response) => response.json())
      } },
    } }
    localStorage.setItem("settings.v3", JSON.stringify({ general: { showReasoningSummaries: true, shellToolPartsExpanded: true } }))
    window.fetch = (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== "/global/event") return original(request)
      host.__feedFixture.streams++
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        host.__feedFixture.emit = (payload) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory, payload })}\n\n`))
        controller.enqueue(new TextEncoder().encode(": fixture connected\n\n"))
        const timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": fixture heartbeat\n\n")), 1000)
        request.signal.addEventListener("abort", () => { clearInterval(timer); controller.close() }, { once: true })
      } }), { headers: { "content-type": "text/event-stream" } }))
    }
  }, { directory, project, session })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === "/__fixture/native-transcripts") {
      const request = route.request().postDataJSON() as { operation: string; scope: string; document: string; value?: string }
      expect(request.scope).toBe(`tunnel.v1.${"c".repeat(64)}`)
      expect(request.document).toBeTruthy()
      if (request.operation === "set") {
        expect(typeof request.value).toBe("string")
        disk = request.value!
      }
      if (request.operation === "remove") disk = ""
      return route.fulfill({ json: request.operation === "get" ? disk || null : null })
    }
    if (path.startsWith(`/session/${session.id}`) && !/\/(diff|todo|children)$/.test(path)) {
      const read = { path, cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }
      reads.push(read)
      const reply = replies.shift()
      expect(reply, `Unexpected transcript/legacy read: ${path}`).toBeDefined()
      return reply!(route, read)
    }
    const data = (() => {
      if (path === "/__haolab/projects") return { directories: [directory] }
      if (path === "/global/health") return { healthy: true, version: "fixture" }
      if (path === "/project") return [project]
      if (path === "/project/current") return project
      if (path === "/path") return { home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: directory, directory }
      if (path === "/provider") return { all: [], default: {}, connected: [] }
      if (path === "/session/sidebar/snapshot") return { cursor: 1, total: 1, items: [session], next: null }
      if (path === "/session/sidebar/changes") return { cursor: 1, total: 1, changes: [], more: false }
      if (path === "/session/sidebar/reconcile") return { upserts: [session], removed: [], limited: false, limit: 10 }
      if (path === "/session" || path === "/experimental/session") return [session]
      if (/\/session\/[^/]+\/(diff|todo|children)$/.test(path)) return []
      if (path === "/config/providers") return { providers: [], default: {} }
      if (path === "/agent") return [{ name: "build", mode: "primary", permission: [] }]
      if (["/permission", "/question", "/command", "/lsp", "/skill", "/pty", "/pty/shells"].includes(path)) return []
      if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(path)) return {}
    })()
    if (data === undefined) return route.fallback()
    return route.fulfill({ json: data })
  })
  const send = async (route: Route, read: (typeof reads)[number], value: unknown, status = 200) => {
    const body = JSON.stringify(value)
    Object.assign(read, { bytes: new TextEncoder().encode(body).length, status })
    await route.fulfill({ status, contentType: "application/json", headers: { "x-opencode-transcript-feed": "1" }, body })
  }
  return {
    reads, errors,
    entry: () => disk ? (JSON.parse(disk) as { entries: TranscriptEntry[] }).entries[0] : undefined,
    reply(value: unknown, status = 200) { replies.push((route, read) => send(route, read, value, status)) },
    hold(value: unknown) {
      let release: (() => void) | undefined
      replies.push(async (route, read) => { await new Promise<void>((resolve) => { release = resolve }); await send(route, read, value) })
      return { entered: () => !!release, release: () => release!() }
    },
    async open() {
      await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
      await expect.poll(() => page.evaluate(() => !!(window as FixtureWindow).__feedFixture.emit)).toBe(true)
    },
    async emit(event: Event) { await page.evaluate((event) => (window as FixtureWindow).__feedFixture.emit!(event), event) },
    async refresh() { await this.emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "idle" } } }) },
    async checkpoint(cursor: string) { await expect.poll(() => this.entry()?.syncCursor).toBe(cursor); expect(validEntry(this.entry())).toBe(true) },
    async check(testInfo: TestInfo, expectedDocuments = 1) {
      expect(documents).toBe(expectedDocuments)
      expect(errors).toEqual([])
      await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
      expect(reads.every((read) => read.path.includes("/transcript/"))).toBe(true)
      expect(replies).toHaveLength(0)
      console.log(JSON.stringify({ fixture: "supported-feed", documents, reads }))
      await testInfo.attach("synthetic-feed-http", { contentType: "application/json", body: JSON.stringify({ mocked: "API, SSE frames, native HTTP-memory storage", real: "production bundle, generated SDK, cache codec, timeline", documents, reads }) })
    },
  }
}

test.describe("production mobile supported transcript feed", () => {
  test.skip(!process.env.PLAYWRIGHT_MOBILE_SELECTION, "Requires an isolated same-origin production build")
  test.use({ viewport: { width: 390, height: 844 } })

  test("cold latest twenty uses one snapshot; persisted restart edits only text and retains the 100KB tool", async ({ page }, testInfo) => {
    const host = await fixture(page)
    host.reply(snapshot())
    await host.open()
    await expect(page.getByText("Fixture message 39", { exact: true })).toBeVisible()
    await host.checkpoint(baseCursor)
    expect(host.entry()?.session).toHaveLength(20)
    expect(host.reads.map(({ path, cursor, limit }) => ({ path, cursor, limit }))).toEqual([{ path: `/session/${session.id}/transcript/snapshot`, cursor: null, limit: "20" }])
    const document = await page.evaluate(() => (window as FixtureWindow).__feedFixture.document)
    const held = host.hold(delta("opaque:edited/checkpoint", [{ seq: 11, type: "part.upsert", info: items[39].info, part: text(items[39].info, "Small edited reply") }]))
    await page.reload()
    await expect.poll(held.entered).toBe(true)
    await expect(page.getByText("Fixture message 39", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as FixtureWindow).__feedFixture.document)).not.toBe(document)
    expect(host.reads[1]).toMatchObject({ path: `/session/${session.id}/transcript/changes`, cursor: baseCursor, limit: "100" })
    held.release()
    await expect(page.getByText("Small edited reply", { exact: true })).toBeVisible()
    await host.checkpoint("opaque:edited/checkpoint")
    const tool = host.entry()?.part.find((item) => item.id === items[39].info.id)?.part.find((part) => part.id === "tool_unchanged")
    expect(tool).toMatchObject({ type: "tool", state: { output: toolOutput } })
    await expect(page.locator('[data-component="bash-output"] code')).toContainText("TOOL-END")
    expect(host.reads).toHaveLength(2)
    expect(host.reads[0].bytes).toBeGreaterThan(100_000)
    expect(host.reads[1].bytes).toBeLessThan(1000)
    await host.check(testInfo, 2)
  })

  test("paged changes persist the admitted prefix across restart and edit known old cache without a history walk", async ({ page }, testInfo) => {
    const cached: TranscriptEntry = {
      directory, sessionID: session.id, session: items.map((item) => item.info), part: items.map((item) => ({ id: item.info.id, part: item.parts })), complete: true,
      syncCursor: baseCursor, syncGeneration: generation, feed: { version: 10, session, snapshot: items.slice(-20).map((item) => item.info.id), versions: [] },
    }
    const host = await fixture(page, cached)
    const first = delta("opaque:admitted/prefix", [
      { seq: 100, type: "part.upsert", info: items[0].info, part: text(items[0].info, "Known older message edited") },
      { seq: 101, type: "part.remove", sessionID: session.id, messageID: items[38].info.id, partID: items[38].parts[0].id },
      { seq: 102, type: "message.remove", sessionID: session.id, messageID: items[37].info.id },
    ], true)
    const heldFirst = host.hold(first)
    const held = host.hold(delta("opaque:unused/obsolete"))
    await host.open()
    await expect.poll(heldFirst.entered).toBe(true)
    await expect(page.getByText("Fixture message 37", { exact: true })).toBeAttached()
    await expect(page.getByText("Fixture message 38", { exact: true })).toBeAttached()
    heldFirst.release()
    await expect.poll(held.entered).toBe(true)
    await host.checkpoint("opaque:admitted/prefix")
    expect(host.entry()?.part.find((item) => item.id === items[0].info.id)?.part[0]).toMatchObject({ text: "Known older message edited" })
    await expect(page.getByText("Fixture message 38", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Fixture message 37", { exact: true })).toHaveCount(0)
    expect(host.entry()?.feed?.versions).toEqual(expect.arrayContaining([
      { messageID: items[38].info.id, partID: items[38].parts[0].id, seq: 101, removed: true },
      { messageID: items[37].info.id, seq: 102, removed: true },
    ]))
    host.reply(delta("opaque:completed/prefix", [
      { seq: 20, type: "part.upsert", info: items[0].info, part: text(items[0].info, "Stale older edit") },
      { seq: 100, type: "part.upsert", info: items[0].info, part: text(items[0].info, "Known older message edited") },
    ]))
    await page.reload()
    await host.checkpoint("opaque:completed/prefix")
    held.release()
    expect(host.reads.map((read) => read.cursor)).toEqual([baseCursor, "opaque:admitted/prefix", "opaque:admitted/prefix"])
    // An older known edit is reconciled in storage without requesting or opening history.
    expect(host.entry()?.part.find((item) => item.id === items[0].info.id)?.part[0]).toMatchObject({ text: "Known older message edited" })
    expect(host.entry()?.session.some((info) => info.id === items[37].info.id)).toBe(false)
    expect(host.entry()?.part.find((item) => item.id === items[38].info.id)?.part).toEqual([])
    expect(host.reads).toHaveLength(3)
    await host.check(testInfo, 2)
  })

  test("sequenced SSE suppresses covered deltas, repairs provisional ac with full abc, and accepts forward append", async ({ page }, testInfo) => {
    test.setTimeout(90000)
    const info = items[39].info
    const host = await fixture(page)
    const evidence: { stage: string; rendered: string; persisted: Part | undefined }[] = []
    const record = async (stage: string) => evidence.push({ stage, rendered: await page.locator('[data-slot="text-part-body"]').innerText(), persisted: host.entry()?.part[0].part[0] })
    host.reply(snapshot([{ info, parts: [text(info, "a")] }], baseCursor, generation, 1))
    await host.open()
    await expect(page.getByText("a", { exact: true })).toBeVisible()
    await host.checkpoint(baseCursor)
    const frame = (seq: number, value: string): Event => ({ type: "message.part.delta", properties: {
      sessionID: session.id, messageID: info.id, partID: text(info, "").id, field: "text", delta: value, transcript: { generation, seq },
    } })
    await host.emit(frame(3, "c"))
    await expect.poll(() => host.entry()?.part[0].part[0]).toMatchObject({ text: "ac" })
    await record("provisional-seq-3")
    // Soft assertions remain failures, but let the trace also verify full repair and restart.
    await expect.soft(page.getByText("ac", { exact: true }), "Assistant UI must retain its snapshot base during an additive SSE delta").toBeVisible()
    await host.emit({ type: "message.part.updated", properties: { part: text(info, "ab"), transcript: { generation, seq: 2 } } })
    await expect.soft(page.getByText("ac", { exact: true }), "Stale full SSE must not replace newer provisional text").toBeVisible()
    await record("stale-full-seq-2")
    expect(host.entry()?.part[0].part[0]).toMatchObject({ text: "ac" })
    host.reply(delta("opaque:full/three", [{ seq: 3, type: "part.upsert", info, part: text(info, "abc") }]))
    await host.refresh()
    await expect(page.getByText("abc", { exact: true })).toBeVisible()
    await host.checkpoint("opaque:full/three")
    await record("full-http-seq-3")
    await host.emit(frame(3, "c"))
    await host.emit({ type: "message.part.updated", properties: { part: text(info, "stale"), transcript: { generation, seq: 2 } } })
    await page.waitForTimeout(50)
    await expect(page.getByText("abc", { exact: true })).toBeVisible()
    await host.emit(frame(4, "d"))
    await expect.poll(() => host.entry()?.part[0].part[0]).toMatchObject({ text: "abcd" })
    await record("forward-seq-4")
    await expect.soft(page.getByText("abcd", { exact: true }), "Forward SSE must append to the repaired full base").toBeVisible()
    host.reply(delta("opaque:full/four", [{ seq: 4, type: "part.upsert", info, part: text(info, "abcd") }]))
    await host.refresh()
    await host.checkpoint("opaque:full/four")
    await expect(page.getByText("abcd", { exact: true })).toBeVisible()
    await host.emit(frame(4, "d"))
    host.reply(delta("opaque:restart/ack"))
    await page.reload()
    await expect(page.getByText("abcd", { exact: true })).toBeVisible()
    await host.checkpoint("opaque:restart/ack")
    await record("repaired-restart")
    expect(host.reads.map((read) => read.cursor)).toEqual([null, baseCursor, "opaque:full/three", "opaque:full/four"])
    await testInfo.attach("sse-base-evidence", { contentType: "application/json", body: JSON.stringify(evidence) })
    console.log(JSON.stringify({ fixture: "supported-feed-sse", evidence }))
    await host.check(testInfo, 2)
  })

  test("410 preserves cached rendering during a new-generation snapshot; auth and schema failures retry the current cursor inline", async ({ page }, testInfo) => {
    const host = await fixture(page)
    host.reply(snapshot())
    await host.open()
    await expect(page.getByText("Fixture message 39", { exact: true })).toBeVisible()
    await host.checkpoint(baseCursor)
    host.reply({ _tag: "TranscriptCursorExpiredError", reason: "session-reset", message: "Fixture cursor expired" }, 410)
    const freshCursor = "opaque:new-generation/start"
    const freshGeneration = "fixture-generation-replaced"
    const info = message(40)
    const held = host.hold(snapshot([{ info, parts: [text(info, "New generation message")] }], freshCursor, freshGeneration, 1))
    await host.refresh()
    await expect.poll(held.entered).toBe(true)
    await expect(page.getByText("Fixture message 39", { exact: true })).toBeVisible()
    held.release()
    await expect(page.getByText("New generation message", { exact: true })).toBeVisible()
    await expect(page.getByText("Fixture message 39", { exact: true })).toHaveCount(0)
    await host.checkpoint(freshCursor)
    expect(host.entry()?.syncGeneration).toBe(freshGeneration)
    expect(host.entry()?.feed?.version).toBe(1)
    expect(host.entry()?.session.map((info) => info.id)).toEqual([info.id])
    for (const [index, failure] of [
      { body: { name: "Unauthorized", message: "Synthetic auth failure" }, status: 401, error: "Transcript feed request failed (401)" },
      { body: { ...delta("opaque:not-admitted", [], false, freshGeneration), changes: [{ seq: 2, type: "part.upsert", info, part: { ...text(info, "Invalid owner"), sessionID: "ses_wrong_owner" } }] }, status: 200, error: "Invalid transcript change entities" },
    ].entries()) {
      const currentCursor = index === 0 ? freshCursor : "opaque:retry/recovered-0"
      host.reply(failure.body, failure.status)
      await host.refresh()
      await expect(page.getByRole("status").filter({ hasText: "Unable to load session messages" })).toContainText(failure.error)
      await expect(page.getByText(index === 0 ? "New generation message" : "Recovered generation 0", { exact: true })).toBeVisible()
      await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
      expect(host.entry()?.syncCursor).toBe(currentCursor)
      const recoveredCursor = `opaque:retry/recovered-${index}`
      const heldRetry = host.hold(delta(recoveredCursor, [{ seq: index + 2, type: "part.upsert", info, part: text(info, `Recovered generation ${index}`) }], false, freshGeneration))
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await expect.poll(heldRetry.entered).toBe(true)
      expect(host.reads.at(-1)).toMatchObject({ path: `/session/${session.id}/transcript/changes`, cursor: currentCursor })
      heldRetry.release()
      await expect(page.getByText(`Recovered generation ${index}`, { exact: true })).toBeVisible()
      await host.checkpoint(recoveredCursor)
      await expect(page.getByRole("status").filter({ hasText: "Unable to load session messages" })).toHaveCount(0)
    }
    expect(host.reads.map((read) => read.cursor)).toEqual([null, baseCursor, null, freshCursor, freshCursor, "opaque:retry/recovered-0", "opaque:retry/recovered-0"])
    await host.check(testInfo)
  })

  test("marked supported-feed 404 removes the session and persisted transcript without legacy fallback", async ({ page }, testInfo) => {
    const host = await fixture(page)
    host.reply(snapshot())
    await host.open()
    await expect(page.getByText("Fixture message 39", { exact: true })).toBeVisible()
    await host.checkpoint(baseCursor)
    host.reply({ name: "NotFoundError", data: { message: "Synthetic session deleted" } }, 404)
    await host.refresh()
    await expect(page.getByText("Fixture message 39", { exact: true })).toHaveCount(0)
    await expect.poll(() => host.entry()).toBeUndefined()
    expect(host.reads.map((read) => read.cursor)).toEqual([null, baseCursor])
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
    await host.check(testInfo)
  })
})
