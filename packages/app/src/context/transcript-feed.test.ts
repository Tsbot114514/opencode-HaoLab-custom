import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createDirSyncContext } from "./directory-sync"
import { createTranscriptCache, transcriptCursor, validEntry } from "./global-sync/transcript-cache"
import type { State } from "./global-sync/types"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { applyDirectoryEvent } from "./global-sync/event-reducer"
import { createMobileReadTransport } from "../utils/mobile-request"
import { getSessionContextMetrics } from "../components/session/session-context-metrics"
import { decodeTranscriptSnapshot } from "../utils/transcript-feed"
import { validTranscriptPart } from "../utils/transcript-entities"

const directory = "/synthetic/feed"
const sessionID = "ses_feed"
const generation = "opaque-database-session-generation"
const session = {
  id: sessionID,
  directory,
  projectID: "fixture",
  slug: "fixture",
  title: "Synthetic feed",
  version: "1",
  time: { created: 1, updated: 300 },
}
const message = (index: number): Extract<Message, { role: "user" }> => ({
  id: `msg_${String(index).padStart(4, "0")}`,
  sessionID,
  role: "user",
  time: { created: index },
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
})
const text = (index: number, body = "fixture"): Part => ({
  id: `part_${index}`,
  sessionID,
  messageID: message(index).id,
  type: "text",
  text: body,
})
const items = (start = 280, end = 300) =>
  Array.from({ length: end - start }, (_, index) => ({ info: message(start + index), parts: [text(start + index)] }))
const headers = { "x-opencode-transcript-feed": "1" }
const snapshot = (cursor = "opaque-0", start = 280, end = 300) => ({
  generation,
  session,
  status: { type: "idle" },
  items: items(start, end),
  cursor,
  version: 10,
  next: start ? transcriptCursor(message(start)) : null,
})
const delta = (cursor = "opaque-1", changes: unknown[] = [], more = false) => ({
  generation,
  cursor,
  highwater: "opaque-highwater",
  more,
  changes,
  status: { type: "idle" },
})
const smallSnapshot = (body = "a", epoch = generation) => ({
  ...snapshot("seq-1", 299, 300),
  generation: epoch,
  version: 1,
  next: null,
  items: [{ info: message(299), parts: [text(299, body)] }],
})
const stampDelta = (seq: number, value: string, epoch = generation) => ({
  type: "message.part.delta" as const,
  properties: {
    sessionID,
    messageID: message(299).id,
    partID: text(299).id,
    field: "text",
    delta: value,
    transcript: { generation: epoch, seq },
  },
})
const disk = () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: async (key: string) => {
      data.delete(key)
    },
  }
  return { data, storage }
}
function fixture(cache: ReturnType<typeof createTranscriptCache>, fetcher: (request: Request) => Promise<Response>) {
  clearSessionPrefetchDirectory(directory)
  const requests: Request[] = []
  const transport = createMobileReadTransport(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return fetcher(request)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  return createRoot((dispose) => {
    const [store, setStore] = createStore({
      session: [],
      message: {},
      part: {},
      part_text_accum_delta: {},
      session_status: {},
      path: { directory },
      status: "complete",
      todo: {},
      session_diff: {},
      permission: {},
      question: {},
    } as unknown as State)
    const client = createOpencodeClient({
      baseUrl: "http://feed.fixture",
      directory,
      fetch: transport.fetch,
      throwOnError: true,
    })
    const context = createDirSyncContext(client, directory, {
      child: () => [store, setStore],
      transcript: cache,
      todo: { set() {} },
      data: { project: [], session_todo: {} },
      recovery: { epoch: () => 0, signal: transport.signal },
    })
    return {
      store,
      context,
      requests,
      dispose,
      transport,
      event(event: Parameters<typeof applyDirectoryEvent>[0]["event"]) {
        if (cache.event(directory, event) === false) return
        applyDirectoryEvent({ event, directory, store, setStore, push() {}, setSessionTodo() {}, loadLsp() {} })
      },
    }
  })
}

describe("mobile durable transcript feed", () => {
  const host = window as Window & { __HAOLAB_MOBILE__?: boolean }
  let previous: boolean | undefined
  beforeEach(() => {
    previous = host.__HAOLAB_MOBILE__
    host.__HAOLAB_MOBILE__ = true
  })
  afterEach(() => {
    host.__HAOLAB_MOBILE__ = previous
    clearSessionPrefetchDirectory(directory)
  })

  test("cold snapshot is one GET; restart uses only changes, retaining a 100KB unchanged sibling", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    const initial = snapshot()
    initial.items[19].parts.push({
      id: "large_tool_output",
      sessionID,
      messageID: message(299).id,
      type: "tool",
      tool: "bash",
      callID: "fixture_call",
      state: {
        status: "completed",
        input: { command: "synthetic" },
        output: "x".repeat(100_000),
        title: "Fixture",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    initial.items[18].parts.push({ ...text(298, "y".repeat(75_000)), id: "another_unchanged_output" })
    expect(JSON.stringify(initial).length).toBeGreaterThan(175_000)
    const first = fixture(cache, async () => Response.json(initial, { headers }))
    await first.context.session.sync(sessionID, { force: true })
    expect(first.requests).toHaveLength(1)
    expect(new URL(first.requests[0].url).pathname).toEndWith("/transcript/snapshot")
    expect(first.store.message[sessionID]).toHaveLength(20)
    await cache.flush()
    first.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const changed = delta("opaque-edited", [
      { seq: 11, type: "part.upsert", info: message(299), part: text(299, "small edit") },
    ])
    const second = fixture(restored, async () => Response.json(changed, { headers }))
    await second.context.session.sync(sessionID, { force: true })
    expect(second.requests).toHaveLength(1)
    expect(new URL(second.requests[0].url).searchParams.get("cursor")).toBe("opaque-0")
    expect(new URL(second.requests[0].url).pathname).toEndWith("/transcript/changes")
    expect(JSON.stringify(changed).length).toBeLessThan(700)
    expect(second.store.part[message(299).id]?.find((part) => part.id === "large_tool_output")).toMatchObject({
      type: "tool",
      state: { output: "x".repeat(100_000) },
    })
    await restored.flush()
    expect(JSON.parse(storage.data.get("sidecar.v1")!).entries[0].syncCursor).toBe("opaque-edited")
    second.dispose()
    restored.dispose()
  })

  test("300 cached messages reconcile unchanged in one 300ms RTT with a tiny body and no history scan", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    await cache.ready
    cache.applyFeed(directory, sessionID, cache.beginFeed(directory, sessionID), {
      cursor: "base",
      generation,
      version: 10,
      session,
      page: {
        session: items().map((item) => item.info),
        part: items().map((item) => ({ id: item.info.id, part: item.parts })),
        complete: false,
        cursor: transcriptCursor(message(280)),
      },
    })
    cache.write(
      directory,
      sessionID,
      {
        session: items(0, 280).map((item) => item.info),
        part: items(0, 280).map((item) => ({ id: item.info.id, part: item.parts })),
        complete: true,
      },
      { before: transcriptCursor(message(280)), range: { before: message(280) } },
    )
    expect(cache.feedEntry(directory, sessionID)?.session).toHaveLength(300)
    const body = delta("same-content")
    const mounted = fixture(cache, async () => {
      await Bun.sleep(300)
      return Response.json(body, { headers })
    })
    const started = performance.now()
    await mounted.context.session.sync(sessionID, { force: true })
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
    expect(mounted.requests).toHaveLength(1)
    expect(JSON.stringify(body).length).toBeLessThan(200)
    expect(cache.feedEntry(directory, sessionID)?.session).toHaveLength(300)
    expect(mounted.store.message[sessionID]).toHaveLength(20)
    mounted.dispose()
    cache.dispose()
  })

  test("paged current-state versions beyond the acknowledged prefix resume exactly and delete parts/messages", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    let held: (() => void) | undefined
    let entered = false
    const mounted = fixture(cache, async (request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("snapshot")) return Response.json(snapshot(), { headers })
      if (url.searchParams.get("cursor") === "opaque-0")
        return Response.json(
          delta(
            "prefix-1",
            [{ seq: 100, type: "part.upsert", info: message(299), part: text(299, "current state") }],
            true,
          ),
          { headers },
        )
      entered = true
      await new Promise<void>((resolve) => {
        held = resolve
      })
      return Response.json(delta("prefix-2"), { headers })
    })
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true }).catch(() => undefined)
    while (!entered) await Bun.sleep(0)
    await cache.flush()
    expect(JSON.parse(storage.data.get("sidecar.v1")!).entries[0].syncCursor).toBe("prefix-1")
    mounted.transport.invalidate()
    await pending
    held?.()
    mounted.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const next = fixture(restored, async (request) => {
      expect(new URL(request.url).searchParams.get("cursor")).toBe("prefix-1")
      return Response.json(
        delta("prefix-3", [
          { seq: 20, type: "part.upsert", info: message(299), part: text(299, "stale") },
          { seq: 101, type: "part.remove", sessionID, messageID: message(298).id, partID: text(298).id },
          { seq: 102, type: "message.remove", sessionID, messageID: message(297).id },
        ]),
        { headers },
      )
    })
    await next.context.session.sync(sessionID, { force: true })
    expect(next.store.part[message(299).id]?.[0]).toMatchObject({ text: "current state" })
    expect(next.store.part[message(298).id]).toEqual([])
    expect(next.store.message[sessionID]?.some((info) => info.id === message(297).id)).toBe(false)
    next.event({ type: "message.updated", properties: { info: message(297) } })
    expect(next.store.message[sessionID]?.some((info) => info.id === message(297).id)).toBe(false)
    next.dispose()
    restored.dispose()
  })

  test("unloaded old edits do not create ghosts; owner info admits future assistant without loading its parent", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    const assistant: Message = {
      id: message(301).id,
      sessionID,
      role: "assistant",
      parentID: message(1).id,
      time: { created: 301 },
      modelID: "fixture",
      providerID: "fixture",
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const mounted = fixture(cache, async (request) =>
      new URL(request.url).pathname.endsWith("snapshot")
        ? Response.json(snapshot(), { headers })
        : Response.json(
            delta("next", [
              { seq: 12, type: "part.upsert", info: message(1), part: text(1, "irrelevant old edit") },
              { seq: 13, type: "part.upsert", info: assistant, part: text(301, "visible orphan reply") },
            ]),
            { headers },
          ),
    )
    await mounted.context.session.sync(sessionID, { force: true })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("next")
    expect(mounted.store.part[message(1).id]).toBeUndefined()
    expect(mounted.store.message[sessionID]?.at(-1)).toMatchObject({ id: assistant.id, parentID: message(1).id })
    mounted.dispose()
    cache.dispose()
  })

  for (const code of [400, 410])
    test(`${code} reinitializes atomically without clearing cached UI while snapshot is held`, async () => {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      let snapshots = 0
      let release: ((response: Response) => void) | undefined
      const mounted = fixture(cache, async (request) => {
        if (new URL(request.url).pathname.endsWith("changes"))
          return Response.json(
            { _tag: "TranscriptCursorExpiredError", reason: "session-reset", message: "expired" },
            { status: code, headers },
          )
        if (++snapshots === 1) return Response.json(snapshot(), { headers })
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      })
      await mounted.context.session.sync(sessionID, { force: true })
      const pending = mounted.context.session.sync(sessionID, { force: true })
      while (!release) await Bun.sleep(0)
      expect(mounted.store.message[sessionID]).toHaveLength(20)
      expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBeUndefined()
      release(Response.json(snapshot("new-generation", 290, 310), { headers }))
      await pending
      expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("new-generation")
      expect(mounted.requests).toHaveLength(3)
      mounted.dispose()
      cache.dispose()
    })

  test("SSE racing a delta preserves dirty text, applies unaffected edits, holds cursor, then reconciles on idle", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    let first = true
    const mounted = fixture(cache, async () => {
      if (first) {
        first = false
        return Response.json(snapshot(), { headers })
      }
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    mounted.event({ type: "message.part.updated", properties: { part: text(299, "live latest") } })
    release(
      Response.json(
        delta("unsafe", [
          { seq: 11, type: "part.upsert", info: message(299), part: text(299, "HTTP older") },
          { seq: 12, type: "part.upsert", info: message(298), part: text(298, "unaffected edit") },
        ]),
        { headers },
      ),
    )
    await pending
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "live latest" })
    expect(mounted.store.part[message(298).id]?.[0]).toMatchObject({ text: "unaffected edit" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBeUndefined()
    expect(mounted.requests).toHaveLength(2)
    release = undefined
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    const idle = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    ;(release as (response: Response) => void)(
      Response.json(
        {
          ...snapshot("safe"),
          version: 13,
          items: items().map((item) => ({
            ...item,
            parts: [
              text(
                item.info.time.created,
                item.info.time.created === 299
                  ? "live latest"
                  : item.info.time.created === 298
                    ? "unaffected edit"
                    : "fixture",
              ),
            ],
          })),
        },
        { headers },
      ),
    )
    await idle
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("safe")
    mounted.dispose()
    cache.dispose()
  })

  test("SSE during the first snapshot stays visible and does not grant a cursor", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    const mounted = fixture(
      cache,
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    mounted.event({ type: "message.updated", properties: { info: message(299) } })
    mounted.event({ type: "message.part.updated", properties: { part: text(299, "newer live snapshot text") } })
    release(Response.json(snapshot(), { headers }))
    await pending
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "newer live snapshot text" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBeUndefined()
    mounted.dispose()
    cache.dispose()
  })

  test("old A HTML route 404 uses legacy reads; marked deletion clears contents; auth/malformed responses never fall back", async () => {
    const legacy = createTranscriptCache(disk().storage, "sidecar.v1")
    const old = fixture(legacy, async (request) => {
      const path = new URL(request.url).pathname
      if (path.includes("/transcript/"))
        return new Response("<html>old route</html>", { status: 404, headers: { "content-type": "text/html" } })
      return Response.json(path.endsWith("/message") ? items() : session)
    })
    await old.context.session.sync(sessionID, { force: true })
    expect(old.requests).toHaveLength(3)
    expect(legacy.feedCapability()).toBe(false)
    await old.context.session.sync(sessionID, { force: true })
    expect(old.requests.filter((request) => new URL(request.url).pathname.includes("/transcript/"))).toHaveLength(1)
    old.dispose()
    legacy.dispose()
    for (const code of [401, 403, 404, 200]) {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      let initial = true
      const mounted = fixture(cache, async () => {
        if (initial) {
          initial = false
          return Response.json(snapshot(), { headers })
        }
        return Response.json(code === 404 ? { name: "NotFoundError", data: { message: "missing" } } : {}, {
          status: code,
          headers,
        })
      })
      await mounted.context.session.sync(sessionID, { force: true })
      const result = mounted.context.session.sync(sessionID, { force: true })
      if (code === 404) {
        await result
        expect(cache.feedEntry(directory, sessionID)).toBeUndefined()
        expect(mounted.store.message[sessionID]).toBeUndefined()
      }
      if (code !== 404) {
        await expect(result).rejects.toBeDefined()
        expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("opaque-0")
        expect(mounted.store.message[sessionID]).toHaveLength(20)
      }
      expect(mounted.requests).toHaveLength(2)
      expect(cache.feedCapability()).toBe(true)
      mounted.dispose()
      cache.dispose()
    }
  })

  test("failed persistence retains the disk checkpoint and eviction drops feed authority", async () => {
    const storage = disk()
    let fail = false
    const cache = createTranscriptCache(
      {
        ...storage.storage,
        setItem: async (key, value) => {
          if (fail) throw new Error("fixture disk failure")
          await storage.storage.setItem(key, value)
        },
      },
      "sidecar.v1",
    )
    const mounted = fixture(cache, async (request) =>
      Response.json(new URL(request.url).pathname.endsWith("snapshot") ? snapshot() : delta("new"), { headers }),
    )
    await mounted.context.session.sync(sessionID, { force: true })
    await cache.flush()
    fail = true
    await mounted.context.session.sync(sessionID, { force: true })
    await cache.flush()
    expect(cache.persistenceError()?.operation).toBe("write")
    expect(JSON.parse(storage.data.get("sidecar.v1")!).entries[0].syncCursor).toBe("opaque-0")
    cache.clearDirectory(directory)
    expect(cache.feedEntry(directory, sessionID)).toBeUndefined()
    mounted.dispose()
    cache.dispose()
  })

  test("strict version validation rejects duplicate, noninteger and prototype-shaped records", () => {
    const entry = {
      directory,
      sessionID,
      session: [],
      part: [],
      complete: true,
      syncCursor: "opaque",
      syncGeneration: generation,
      feed: { version: 0, session, snapshot: [], versions: [] as unknown[] },
    }
    expect(validEntry(entry)).toBe(true)
    for (const versions of [
      null,
      {},
      [{ messageID: "x", seq: true }],
      [{ messageID: "x", seq: 1.5 }],
      [
        { messageID: "x", seq: 1 },
        { messageID: "x", seq: 2 },
      ],
      [{ messageID: "x", seq: 1, __proto__: { polluted: true }, extra: true }],
    ]) {
      expect(validEntry({ ...entry, feed: { ...entry.feed, versions } })).toBe(false)
    }
  })

  test("a restore during the first snapshot and an obsolete cursor commit cannot resurrect an entry", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    const mounted = fixture(
      cache,
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    cache.clearDirectory(directory)
    release(Response.json(snapshot(), { headers }))
    await pending
    expect(cache.feedEntry(directory, sessionID)).toBeUndefined()
    expect(mounted.store.message[sessionID]).toBeUndefined()
    const old = cache.beginFeed(directory, sessionID)
    cache.resetFeed(directory, sessionID)
    expect(
      cache.applyFeed(directory, sessionID, old, {
        cursor: "obsolete",
        generation,
        version: 1,
        session,
        page: { session: [], part: [], complete: true },
      }),
    ).toBeUndefined()
    mounted.dispose()
    cache.dispose()
  })

  test("history keeps the feed cursor and an in-flight delta cannot roll back a newer historical page", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    const mounted = fixture(cache, async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("snapshot")) return Response.json(snapshot(), { headers })
      if (path.endsWith("changes"))
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      return Response.json(
        items(260, 280).map((item) => ({ ...item, parts: [text(Number(item.info.time.created), "new history")] })),
        { headers: { "x-next-cursor": transcriptCursor(message(260)) } },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    await mounted.context.session.history.loadMore(sessionID)
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("opaque-0")
    release(
      Response.json(
        delta("not-safe", [{ seq: 12, type: "part.upsert", info: message(279), part: text(279, "older delta") }]),
        { headers },
      ),
    )
    await pending
    expect(mounted.store.part[message(279).id]?.[0]).toMatchObject({ text: "new history" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("opaque-0")
    expect(mounted.store.message[sessionID]).toHaveLength(40)
    mounted.dispose()
    cache.dispose()
  })

  test("an unstamped idle race settles with one authoritative snapshot, never a busy retry loop", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    let changes = 0
    let snapshots = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) {
        if (++snapshots === 1) return Response.json(snapshot(), { headers })
        return Response.json(
          {
            ...snapshot("settled"),
            version: 13,
            items: items().map((item) =>
              item.info.id === message(299).id ? { ...item, parts: [text(299, "final SSE")] } : item,
            ),
          },
          { headers },
        )
      }
      if (++changes === 1)
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      return Response.json(
        delta("settled", [{ seq: 13, type: "part.upsert", info: message(299), part: text(299, "final SSE") }]),
        { headers },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "message.part.updated", properties: { part: text(299, "final SSE") } })
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    release(
      Response.json(delta("racing", [{ seq: 11, type: "part.upsert", info: message(299), part: text(299, "older") }]), {
        headers,
      }),
    )
    await pending
    expect(changes).toBe(1)
    expect(snapshots).toBe(2)
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("settled")
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "final SSE" })
    mounted.dispose()
    cache.dispose()
  })

  test("oversized feed bodies reject finitely without checkpointing and publish an actionable sync error", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let canceled = false
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) return Response.json(snapshot(), { headers })
      const chunk = new Uint8Array(1024 * 1024)
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { ...headers, "content-type": "application/json" } },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toThrow("32 MiB")
    expect(mounted.context.session.error(sessionID)).toContain("32 MiB")
    expect(canceled).toBe(true)
    expect(mounted.requests).toHaveLength(2)
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("opaque-0")
    expect(mounted.store.message[sessionID]).toHaveLength(20)
    mounted.dispose()
    cache.dispose()
  })

  test("malformed JSON and cross-session part payloads keep contents/cursor and do not disable feed capability", async () => {
    for (const response of [
      new Response("{", { headers: { ...headers, "content-type": "application/json" } }),
      Response.json(
        delta("bad", [
          { seq: 11, type: "part.upsert", info: message(299), part: { ...text(299), sessionID: "other" } },
        ]),
        { headers },
      ),
    ]) {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      let first = true
      const mounted = fixture(cache, async () => {
        if (first) {
          first = false
          return Response.json(snapshot(), { headers })
        }
        return response
      })
      await mounted.context.session.sync(sessionID, { force: true })
      await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toBeDefined()
      expect(cache.feedCapability()).toBe(true)
      expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("opaque-0")
      expect(mounted.store.message[sessionID]).toHaveLength(20)
      mounted.dispose()
      cache.dispose()
    }
  })

  test("delta c3 before queued full ab2 is repaired by HTTP full abc3, not frozen as ac", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    let reads = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) return Response.json(smallSnapshot(), { headers })
      return Response.json(
        ++reads === 1
          ? delta("full-3", [{ seq: 3, type: "part.upsert", info: message(299), part: text(299, "abc") }])
          : delta("empty-after-full"),
        { headers },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event(stampDelta(3, "c"))
    expect(
      cache.feedEntry(directory, sessionID)?.feed?.versions.find((version) => version.partID === text(299).id),
    ).toMatchObject({ seq: 3, full: 1 })
    mounted.event({
      type: "message.part.updated",
      properties: { part: text(299, "ab"), transcript: { generation, seq: 2 } },
    })
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "ac" })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("full-3")
    expect(
      cache.feedEntry(directory, sessionID)?.feed?.versions.find((version) => version.partID === text(299).id)?.full,
    ).toBeUndefined()
    mounted.event(stampDelta(3, "c"))
    await mounted.context.session.sync(sessionID, { force: true })
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    await cache.flush()
    mounted.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const cold = fixture(restored, async () => Response.json(delta("cold-empty"), { headers }))
    await cold.context.session.sync(sessionID, { force: true })
    expect(cold.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    cold.dispose()
    restored.dispose()
  })

  test("same-sequence full SSE repairs an additive body and its late duplicate delta is suppressed", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    const mounted = fixture(cache, async (request) =>
      Response.json(new URL(request.url).pathname.endsWith("snapshot") ? smallSnapshot() : delta("live-full-ack"), {
        headers,
      }),
    )
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event(stampDelta(3, "c"))
    mounted.event({
      type: "message.part.updated",
      properties: { part: text(299, "abc"), transcript: { generation, seq: 3 } },
    })
    mounted.event(stampDelta(3, "c"))
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("live-full-ack")
    mounted.dispose()
    cache.dispose()
  })

  test("uncovered delta4 preserves newer UI against full3 without certifying it; metadata applies and idle full4 repairs", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    let reads = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) return Response.json(smallSnapshot(), { headers })
      if (++reads === 1)
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      return Response.json(
        delta("full-4", [{ seq: 4, type: "part.upsert", info: message(299), part: text(299, "abcd") }]),
        { headers },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event({
      type: "message.part.updated",
      properties: { part: text(299, "abc"), transcript: { generation, seq: 3 } },
    })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    mounted.event(stampDelta(4, "d"))
    release(
      Response.json(
        {
          ...delta("older-full-3", [{ seq: 3, type: "part.upsert", info: message(299), part: text(299, "abc") }]),
          session: { ...session, title: "Unaffected metadata" },
        },
        { headers },
      ),
    )
    await pending
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abcd" })
    expect(mounted.store.session[0].title).toBe("Unaffected metadata")
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    expect(mounted.requests).toHaveLength(2)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("full-4")
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abcd" })
    mounted.dispose()
    cache.dispose()
  })

  test("empty feed cannot acknowledge a provisional additive base, including across disk restart", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    const mounted = fixture(cache, async (request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("snapshot")
          ? smallSnapshot()
          : { ...delta("unsafe-empty-3"), status: { type: "busy" } },
        { headers },
      ),
    )
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event(stampDelta(3, "c"))
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    await cache.flush()
    mounted.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const cold = fixture(restored, async (request) => {
      expect(new URL(request.url).pathname).toEndWith("/transcript/changes")
      expect(new URL(request.url).searchParams.get("cursor")).toBe("seq-1")
      return Response.json(
        delta("repaired-full-3", [{ seq: 3, type: "part.upsert", info: message(299), part: text(299, "abc") }]),
        { headers },
      )
    })
    await cold.context.session.sync(sessionID, { force: true })
    expect(cold.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    expect(restored.feedEntry(directory, sessionID)?.syncCursor).toBe("repaired-full-3")
    cold.dispose()
    restored.dispose()
  })

  test("ab at seq 2 rejects a late b delta and older full part before cache AND reducer, then empty-ack/restart stays ab", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    let reads = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) return Response.json(smallSnapshot(), { headers })
      return Response.json(
        ++reads === 1
          ? delta("seq-2", [{ seq: 2, type: "part.upsert", info: message(299), part: text(299, "ab") }])
          : delta("seq-3"),
        { headers },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event(stampDelta(2, "b"))
    mounted.event({
      type: "message.part.updated",
      properties: { part: text(299, "a"), transcript: { generation, seq: 1 } },
    })
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "ab" })
    expect(cache.feedEntry(directory, sessionID)?.part[0].part[0]).toMatchObject({ text: "ab" })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-3")
    await cache.flush()
    mounted.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const cold = fixture(restored, async (request) => {
      expect(new URL(request.url).pathname).toEndWith("/transcript/changes")
      expect(new URL(request.url).searchParams.get("cursor")).toBe("seq-3")
      return Response.json(delta("seq-4"), { headers })
    })
    await cold.context.session.sync(sessionID, { force: true })
    cold.event(stampDelta(2, "b"))
    expect(cold.store.part[message(299).id]?.[0]).toMatchObject({ text: "ab" })
    expect(restored.feedEntry(directory, sessionID)?.syncGeneration).toBe(generation)
    expect(cold.requests).toHaveLength(1)
    cold.dispose()
    restored.dispose()
  })

  test("seq 3 live delta survives seq 2 HTTP, stays provisional and resumes until full3 repairs coverage", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    let changes = 0
    let release: ((response: Response) => void) | undefined
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot")) return Response.json(smallSnapshot(), { headers })
      if (++changes === 1)
        return Response.json(
          delta("seq-2", [{ seq: 2, type: "part.upsert", info: message(299), part: text(299, "ab") }]),
          { headers },
        )
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    await mounted.context.session.sync(sessionID, { force: true })
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    mounted.event(stampDelta(3, "c"))
    release(
      Response.json(delta("seq-3", [{ seq: 2, type: "part.upsert", info: message(299), part: text(299, "ab") }]), {
        headers,
      }),
    )
    await pending
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-2")
    expect(mounted.requests).toHaveLength(3)
    await cache.flush()
    mounted.dispose()
    cache.dispose()
    const restored = createTranscriptCache(storage.storage, "sidecar.v1")
    const cold = fixture(restored, async (request) => {
      expect(new URL(request.url).searchParams.get("cursor")).toBe("seq-2")
      return Response.json(
        delta("seq-4", [{ seq: 3, type: "part.upsert", info: message(299), part: text(299, "abc") }]),
        { headers },
      )
    })
    await cold.context.session.sync(sessionID, { force: true })
    cold.event(stampDelta(3, "c"))
    expect(cold.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    cold.dispose()
    restored.dispose()
  })

  test("stamped part/message tombstones reject late resurrection, while a new generation accepts low sequences", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let reset = false
    const nextGeneration = "new-database-session-generation"
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot"))
        return Response.json(reset ? smallSnapshot("new", nextGeneration) : smallSnapshot("ab"), { headers })
      return reset
        ? Response.json(
            { _tag: "TranscriptCursorExpiredError", reason: "database-reset", message: "expired" },
            { status: 410, headers },
          )
        : Response.json(delta("seq-2"), { headers })
    })
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event({
      type: "message.part.removed",
      properties: { sessionID, messageID: message(299).id, partID: text(299).id, transcript: { generation, seq: 3 } },
    })
    mounted.event({
      type: "message.part.updated",
      properties: { part: text(299, "old"), transcript: { generation, seq: 2 } },
    })
    mounted.event(stampDelta(2, "b"))
    expect(mounted.store.part[message(299).id] ?? []).toEqual([])
    mounted.event({
      type: "message.removed",
      properties: { sessionID, messageID: message(299).id, transcript: { generation, seq: 4 } },
    })
    mounted.event({ type: "message.updated", properties: { info: message(299), transcript: { generation, seq: 3 } } })
    expect(mounted.store.message[sessionID]).toEqual([])
    reset = true
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncGeneration).toBe(nextGeneration)
    mounted.event(stampDelta(100, "late-old", generation))
    mounted.event(stampDelta(2, "!", nextGeneration))
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "new!" })
    mounted.dispose()
    cache.dispose()
  })

  test("a newer live part does not suppress separately hydrated owning-message metadata", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let release: ((response: Response) => void) | undefined
    const mounted = fixture(cache, async (request) =>
      new URL(request.url).pathname.endsWith("snapshot")
        ? Response.json(smallSnapshot("ab"), { headers })
        : new Promise<Response>((resolve) => {
            release = resolve
          }),
    )
    await mounted.context.session.sync(sessionID, { force: true })
    const pending = mounted.context.session.sync(sessionID, { force: true })
    while (!release) await Bun.sleep(0)
    mounted.event({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    mounted.event(stampDelta(4, "c"))
    release(
      Response.json(
        delta("owner-info-ack", [
          { seq: 3, type: "part.upsert", info: { ...message(299), agent: "updated-owner" }, part: text(299, "ab") },
        ]),
        { headers },
      ),
    )
    await pending
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abc" })
    expect(mounted.store.message[sessionID]?.[0]).toMatchObject({ agent: "updated-owner" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    expect(mounted.requests).toHaveLength(2)
    mounted.dispose()
    cache.dispose()
  })

  test("foreign-generation SSE never merges or retires the current generation before a verifying snapshot", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    const mounted = fixture(cache, async () => Response.json(smallSnapshot("current"), { headers }))
    await mounted.context.session.sync(sessionID, { force: true })
    mounted.event(stampDelta(100, "unknown-old", "foreign-generation"))
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "current" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBeUndefined()
    await mounted.context.session.sync(sessionID, { force: true })
    expect(cache.feedEntry(directory, sessionID)?.syncGeneration).toBe(generation)
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    mounted.event(stampDelta(101, "late-old", "foreign-generation"))
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    expect(mounted.requests).toHaveLength(2)
    mounted.dispose()
    cache.dispose()
  })

  test("generation changes mid-more page reset via snapshot instead of merging the foreign body", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let snapshots = 0
    let pages = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot"))
        return Response.json(++snapshots === 1 ? smallSnapshot() : smallSnapshot("new epoch", "next-epoch"), {
          headers,
        })
      if (++pages === 1)
        return Response.json(
          delta("prefix-2", [{ seq: 2, type: "part.upsert", info: message(299), part: text(299, "ab") }], true),
          { headers },
        )
      return Response.json(
        {
          ...delta(
            "foreign-prefix",
            [{ seq: 1, type: "part.upsert", info: message(299), part: text(299, "must never merge") }],
            true,
          ),
          generation: "next-epoch",
        },
        { headers },
      )
    })
    await mounted.context.session.sync(sessionID, { force: true })
    await mounted.context.session.sync(sessionID, { force: true })
    expect(mounted.requests).toHaveLength(4)
    expect(cache.feedEntry(directory, sessionID)?.syncGeneration).toBe("next-epoch")
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "new epoch" })
    mounted.dispose()
    cache.dispose()
  })

  test("missing or malformed generation fails closed without replacing the cached cursor", async () => {
    for (const invalid of [undefined, null, "", "x".repeat(257), 7]) {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      let first = true
      const mounted = fixture(cache, async () => {
        if (first) {
          first = false
          return Response.json(smallSnapshot("ab"), { headers })
        }
        return Response.json({ ...delta("bad-generation"), generation: invalid }, { headers })
      })
      await mounted.context.session.sync(sessionID, { force: true })
      await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toThrow("response")
      expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
      expect(cache.feedCapability()).toBe(true)
      expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "ab" })
      mounted.dispose()
      cache.dispose()
    }
  })

  test("unstamped duplicate delta cannot be certified by an empty page; an authoritative snapshot repairs it", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let reads = 0
    const mounted = fixture(cache, async (request) => {
      if (new URL(request.url).pathname.endsWith("snapshot"))
        return Response.json({ ...smallSnapshot("ab"), version: 2, cursor: "seq-2" }, { headers })
      reads++
      return Response.json(delta("empty-ack"), { headers })
    })
    await mounted.context.session.sync(sessionID, { force: true })
    const event = stampDelta(2, "b")
    const { transcript, ...properties } = event.properties
    mounted.event({ type: event.type, properties })
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "abb" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBeUndefined()
    await mounted.context.session.sync(sessionID, { force: true })
    expect(reads).toBe(0)
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "ab" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-2")
    mounted.dispose()
    cache.dispose()
  })

  test("a stamped append after hydration/gap needs a confirmed base rather than certifying a missed prefix", async () => {
    const storage = disk()
    const cache = createTranscriptCache(storage.storage, "sidecar.v1")
    const mounted = fixture(cache, async () => Response.json({ ...smallSnapshot("ab"), version: 2 }, { headers }))
    await mounted.context.session.sync(sessionID, { force: true })
    cache.revalidate()
    mounted.event(stampDelta(4, "d"))
    expect(mounted.store.part[message(299).id]?.[0]).toMatchObject({ text: "ab" })
    expect(cache.feedEntry(directory, sessionID)?.feed?.versions.some((item) => item.seq === 4)).toBe(false)
    mounted.dispose()
    cache.dispose()
  })

  test("required assistant fields are decoded before the real metrics consumer, and malformed graphs leave previous contents/cursor intact", async () => {
    const assistant: Extract<Message, { role: "assistant" }> = {
      id: message(299).id,
      sessionID,
      role: "assistant",
      time: { created: 299 },
      agent: "build",
      parentID: message(298).id,
      providerID: "fixture",
      modelID: "fixture",
      mode: "build",
      path: { cwd: directory, root: directory },
      cost: 1.5,
      tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
    }
    const good = { ...smallSnapshot("valid"), items: [{ info: assistant, parts: [text(299, "valid")] }] }
    const decoded = decodeTranscriptSnapshot(good, directory, sessionID)
    expect(getSessionContextMetrics(decoded.page.session, []).context?.total).toBe(20)
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    let response: unknown = good
    const mounted = fixture(cache, async () => Response.json(response, { headers }))
    await mounted.context.session.sync(sessionID, { force: true })
    for (const field of ["tokens", "cost", "providerID", "modelID", "mode", "parentID", "path"]) {
      const info = { ...assistant, [field]: undefined }
      response = delta("invalid", [{ seq: 2, type: "message.upsert", info }])
      await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toThrow("entities")
      expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
      expect(getSessionContextMetrics(mounted.store.message[sessionID], []).context?.total).toBe(20)
    }
    response = delta("invalid", [
      { seq: 2, type: "message.upsert", info: { ...assistant, tokens: { ...assistant.tokens, cache: null } } },
    ])
    await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toThrow("entities")
    const tool = {
      id: "tool",
      sessionID,
      messageID: assistant.id,
      type: "tool",
      tool: "bash",
      callID: "fixture",
      state: { status: "completed" },
    }
    response = delta("invalid", [{ seq: 2, type: "part.upsert", info: assistant, part: tool }])
    await expect(mounted.context.session.sync(sessionID, { force: true })).rejects.toThrow("entities")
    expect(mounted.store.part[assistant.id]?.[0]).toMatchObject({ text: "valid" })
    expect(cache.feedEntry(directory, sessionID)?.syncCursor).toBe("seq-1")
    mounted.dispose()
    cache.dispose()
  })

  test("every required part variant/state rejects missing fields without rejecting valid SDK shapes", () => {
    const base = { id: "part", sessionID, messageID: message(299).id }
    for (const part of [
      { type: "reasoning", text: "reasoning", time: { start: 0 } },
      { type: "file", mime: "text/plain", url: "file:///synthetic" },
      { type: "agent", name: "build" },
      { type: "subtask", prompt: "task", description: "description", agent: "build" },
      { type: "snapshot", snapshot: "fixture" },
      { type: "patch", hash: "fixture", files: [] },
      { type: "step-start" },
      {
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { type: "compaction", auto: false },
      {
        type: "retry",
        attempt: 0,
        error: { name: "APIError", data: { message: "fixture", isRetryable: true } },
        time: { created: 1 },
      },
      ...[
        { status: "pending", input: {}, raw: "" },
        { status: "running", input: {}, time: { start: 0 } },
        { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
        { status: "error", input: {}, error: "fixture", time: { start: 0, end: 1 } },
      ].map((state) => ({ type: "tool", tool: "bash", callID: "fixture", state })),
    ]) {
      expect(validTranscriptPart({ ...base, ...part })).toBe(true)
      for (const field of Object.keys(part).filter((field) => field !== "type"))
        expect(validTranscriptPart({ ...base, ...part, [field]: undefined })).toBe(false)
    }
    for (const state of [
      { status: "pending", input: {}, raw: "" },
      { status: "running", input: {}, time: { start: 0 } },
      { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
      { status: "error", input: {}, error: "fixture", time: { start: 0, end: 1 } },
    ]) {
      for (const field of Object.keys(state).filter((field) => field !== "status")) {
        expect(
          validTranscriptPart({
            ...base,
            type: "tool",
            tool: "bash",
            callID: "fixture",
            state: { ...state, [field]: undefined },
          }),
        ).toBe(false)
      }
    }
  })
})
