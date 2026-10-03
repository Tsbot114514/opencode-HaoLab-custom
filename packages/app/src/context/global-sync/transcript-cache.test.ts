import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createComponent, createResource, createRoot, Suspense } from "solid-js"
import { insert, isServer, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { createDirSyncContext } from "../directory-sync"
import { createTranscriptCache, transcriptCursor, type TranscriptPage } from "./transcript-cache"
import type { State } from "./types"
import { clearSessionPrefetchDirectory } from "./session-prefetch"
import { applyDirectoryEvent } from "./event-reducer"

const message = (index: number): Message => ({
  id: `m${index}`,
  sessionID: "s",
  role: "user",
  time: { created: index },
  agent: "build",
  model: { providerID: "p", modelID: "m" },
})
const text = (index: number): Extract<Part, { type: "text" }> => ({
  id: `p${index}`,
  sessionID: "s",
  messageID: `m${index}`,
  type: "text",
  text: `body ${index}`,
})
const page = (start: number, end: number): TranscriptPage => ({
  session: Array.from({ length: end - start }, (_, i) => message(start + i)),
  part: Array.from({ length: end - start }, (_, i) => ({ id: `m${start + i}`, part: [text(start + i)] })),
  cursor: start ? transcriptCursor(message(start)) : undefined,
  complete: start === 0,
})
const disk = () => {
  const data = new Map<string, string>()
  const storage: AsyncStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value)
    },
    removeItem: async (key) => {
      data.delete(key)
    },
  }
  return { data, storage }
}
const title = {
  id: "s",
  slug: "s",
  directory: "/work",
  projectID: "p",
  title: "Session",
  version: "1",
  time: { created: 0, updated: 1 },
}

function context(cache: ReturnType<typeof createTranscriptCache>, fetcher: (request: Request) => Promise<Response>) {
  clearSessionPrefetchDirectory("/work")
  return createRoot((dispose) => {
    const [store, setStore] = createStore({
      session: [title],
      message: {},
      part: {},
      part_text_accum_delta: {},
      path: { directory: "/work" },
      status: "complete",
      todo: {},
      session_diff: {},
      permission: {},
      question: {},
      session_status: {},
      sessionTotal: 1,
      limit: 10,
    } as unknown as State)
    const client = createOpencodeClient({
      baseUrl: "http://transcripts.test",
      throwOnError: true,
      fetch: Object.assign(
        (input: RequestInfo | URL) => fetcher(input instanceof Request ? input : new Request(input)),
        { preconnect: fetch.preconnect },
      ),
    })
    const sync = createDirSyncContext(client, "/work", {
      child: () => [store, setStore],
      todo: { set: () => undefined },
      data: { project: [], session_todo: {} },
      transcript: cache,
    })
    const emit = (event: { type: string; properties?: unknown }) => {
      cache.event("/work", event)
      applyDirectoryEvent({
        event,
        store,
        setStore,
        directory: "/work",
        push: () => undefined,
        loadLsp: () => undefined,
      })
    }
    return { sync, store, setStore, dispose, emit }
  })
}

function resourceDOM(app: ReturnType<typeof context>) {
  const root = document.createElement("div")
  const dispose = render(() => {
    const [session] = createResource(
      () => "s",
      (id) => app.sync.session.sync(id),
    )
    return createComponent(Suspense, {
      fallback: "fallback",
      get children() {
        const body = document.createElement("div")
        insert(body, () => {
          session()
          return app.store.part.m1?.[0]?.type === "text" ? app.store.part.m1[0].text : "empty"
        })
        return body
      },
    })
  }, root)
  return { root, dispose }
}

describe("persistent transcript pages", () => {
  ;(isServer ? test.skip : test)(
    "Solid resource renders hydrated bodies under Suspense while metadata and messages are held",
    async () => {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      await cache.ready
      cache.write("/work", "s", page(0, 2))
      let metadata!: (response: Response) => void
      let messages!: (response: Response) => void
      const app = context(
        cache,
        async (request) =>
          new Promise((resolve) => {
            if (request.url.endsWith("/s")) metadata = resolve
            else messages = resolve
          }),
      )
      const { root, dispose } = resourceDOM(app)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.textContent).toBe("body 1")
      const pending = app.sync.session.sync("s", { force: true })
      metadata(Response.json(title))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.textContent).toBe("body 1")
      messages(new Response("offline", { status: 503 }))
      await pending.catch(() => undefined)
      expect(root.textContent).toBe("body 1")
      dispose()
      app.dispose()
      cache.dispose()
    },
  )
  ;(isServer ? test.skip : test)(
    "an uncached Solid resource stays suspended until the server messages arrive",
    async () => {
      const cache = createTranscriptCache(disk().storage, "sidecar.v1")
      await cache.ready
      let metadata!: (response: Response) => void
      let messages!: (response: Response) => void
      const app = context(
        cache,
        async (request) =>
          new Promise((resolve) => {
            if (request.url.endsWith("/s")) metadata = resolve
            else messages = resolve
          }),
      )
      app.setStore("session", [])
      const { root, dispose } = resourceDOM(app)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.textContent).toBe("fallback")
      metadata(Response.json(title))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.textContent).toBe("fallback")
      messages(Response.json(page(0, 2).session.map((info) => ({ info, parts: [text(info.time.created)] }))))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.textContent).toBe("body 1")
      dispose()
      app.dispose()
      cache.dispose()
    },
  )

  test("an opened validated stream persists new messages and parts before idle, but not after invalidation", async () => {
    const source = disk()
    const cache = createTranscriptCache(source.storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 1), { validated: true, updated: 1 })
    cache.activate("/work", "s")
    cache.event("/work", {
      type: "session.updated",
      properties: { info: { ...title, time: { created: 0, updated: 2 } } },
    })
    cache.event("/work", { type: "message.updated", properties: { info: message(1) } })
    cache.event("/work", { type: "message.part.updated", properties: { part: text(1) } })
    const assistant: Message = {
      id: "m2",
      sessionID: "s",
      role: "assistant",
      parentID: "m1",
      time: { created: 2 },
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: "/work", root: "/work" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    cache.event("/work", { type: "message.updated", properties: { info: assistant } })
    cache.event("/work", { type: "message.part.updated", properties: { part: text(2) } })
    for (let i = 0; i < 10; i++)
      cache.event("/work", {
        type: "message.part.delta",
        properties: { sessionID: "s", messageID: "m2", partID: "p2", field: "text", delta: "x" },
      })
    await cache.flush()
    const snapshot = JSON.parse(source.data.get("sidecar.v1")!).entries[0]
    expect(snapshot.session.map((message: Message) => message.id)).toEqual(["m0", "m1", "m2"])
    expect(snapshot.part[1].part[0].text).toBe("body 1")
    expect(snapshot.part[2].part[0].text).toBe("body 2xxxxxxxxxx")
    cache.invalidate()
    cache.event("/work", { type: "message.updated", properties: { info: message(60) } })
    cache.event("/work", { type: "message.part.updated", properties: { part: text(60) } })
    await cache.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].session.map((message: Message) => message.id)).toEqual(
      ["m0", "m1", "m2"],
    )
    cache.dispose()
  })
  test("cold SSE messages cannot append across an offline gap; opening bridges the retained range", async () => {
    const source = disk()
    const original = createTranscriptCache(source.storage, "sidecar.v1")
    await original.ready
    original.write("/work", "s", page(0, 20))
    await original.flush()
    original.dispose()
    const cache = createTranscriptCache(source.storage, "sidecar.v1")
    await cache.ready
    cache.event("/work", { type: "message.updated", properties: { info: message(60) } })
    cache.event("/work", { type: "message.part.updated", properties: { part: text(60) } })
    expect(cache.read("/work", "s", 100)?.session.map((message) => message.id)).toEqual(
      page(0, 20).session.map((message) => message.id),
    )
    expect(cache.read("/work", "s", 100)?.part.some((part) => part.id === "m60")).toBe(false)
    expect(cache.validationBoundary("/work", "s")?.id).toBe("m0")
    const boundaries: number[] = []
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json(title)
      const before = new URL(request.url).searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : 61
      boundaries.push(end)
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session.map((info) => ({ info, parts: [text(info.time.created)] })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([61, 41, 21, 1])
    expect(cache.read("/work", "s", 100)?.session.map((message) => message.id)).toEqual(
      page(0, 61).session.map((message) => message.id),
    )
    expect(app.store.message.s?.length).toBe(20)
    await app.sync.session.history.loadMore("s")
    expect(boundaries).toHaveLength(4)
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(21, 61).session.map((message) => message.id))
    app.dispose()
    cache.dispose()
  })

  test("cached history stays available during a held newest fetch and late refresh preserves its oldest anchor", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 60), { validated: true })
    let finish!: (response: Response) => void
    const boundaries: number[] = []
    const response = (start: number, end: number) => {
      const result = page(start, end)
      return Response.json(
        result.session.map((info) => ({ info, parts: [text(info.time.created)] })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    }
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json(title)
      const before = new URL(request.url).searchParams.get("before")
      if (!before) {
        boundaries.push(70)
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      const end = JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time
      boundaries.push(end)
      return response(Math.max(0, end - 20), end)
    })
    const pending = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(boundaries).toEqual([70])
    expect(app.sync.session.history.loading("s")).toBe(false)
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(20, 60).session.map((message) => message.id))
    expect(boundaries).toEqual([70])
    finish(response(50, 70))
    await pending
    expect(boundaries).toEqual([70, 50, 30])
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(20, 70).session.map((message) => message.id))
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(0, 70).session.map((message) => message.id))
    expect(boundaries).toHaveLength(3)
    app.dispose()
    cache.dispose()
  })

  test("session.deleted during a held session.get cannot resurrect metadata or start a stale message fetch", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 20))
    let finish!: (response: Response) => void
    let metadata = 0
    let messages = 0
    const app = context(cache, async (request) => {
      if (!request.url.endsWith("/s")) {
        messages++
        return Response.json([{ info: message(0), parts: [text(0)] }])
      }
      metadata++
      if (metadata === 1)
        return new Promise((resolve) => {
          finish = resolve
        })
      if (metadata === 2) return new Response("deleted", { status: 404 })
      return Response.json({ ...title, title: "Recreated", time: { created: 0, updated: 3 } })
    })
    const pending = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    app.emit({ type: "session.deleted", properties: { info: title } })
    finish(Response.json(title))
    await pending
    expect(app.store.session).toEqual([])
    expect(app.store.message.s).toBeUndefined()
    expect(cache.read("/work", "s")).toBeUndefined()
    expect(metadata).toBe(1)
    expect(messages).toBe(0)
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    expect(metadata).toBe(2)
    app.emit({ type: "session.created", properties: { info: { ...title, title: "Recreated" } } })
    await app.sync.session.sync("s", { force: true })
    expect(app.store.session[0].title).toBe("Recreated")
    expect(metadata).toBe(3)
    expect(messages).toBe(1)
    app.dispose()
    cache.dispose()
  })

  test("metadata SSE changes trigger at most one fresh retry, without overwriting the latest sidebar", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 1))
    const releases: Array<(response: Response) => void> = []
    let messages = 0
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s"))
        return new Promise((resolve) => {
          releases.push(resolve)
        })
      messages++
      return Response.json([{ info: message(0), parts: [text(0)] }])
    })
    const pending = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    app.emit({ type: "session.updated", properties: { info: { ...title, title: "Newer" } } })
    releases[0](Response.json(title))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releases).toHaveLength(2)
    expect(app.store.session[0].title).toBe("Newer")
    app.emit({ type: "session.updated", properties: { info: { ...title, title: "Newest" } } })
    releases[1](Response.json({ ...title, title: "Newer" }))
    await pending
    expect(releases).toHaveLength(2)
    expect(messages).toBe(0)
    expect(app.store.session[0].title).toBe("Newest")
    const fresh = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    releases[2](Response.json({ ...title, title: "Newest" }))
    await fresh
    expect(messages).toBe(1)
    expect(app.store.session[0].title).toBe("Newest")
    app.dispose()
    cache.dispose()
  })

  test("reconnect compares deletions in loaded and unloaded ranges while failed refresh retains offline pages", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 60), { validated: true })
    let online = false
    const boundaries: number[] = []
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json(title)
      if (!online) return new Response("offline", { status: 503 })
      const before = new URL(request.url).searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : 60
      boundaries.push(end)
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session
          .filter((info) => info.id !== "m20" && info.id !== "m50")
          .map((info) => ({ info, parts: [text(info.time.created)] })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    cache.invalidate()
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    expect(cache.read("/work", "s", 100)?.session.length).toBe(60)
    expect(app.store.message.s?.length).toBe(20)
    online = true
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([60, 40, 20])
    expect(app.store.message.s?.some((message) => message.id === "m50")).toBe(false)
    expect(cache.read("/work", "s", 100)?.session.some((message) => message.id === "m20" || message.id === "m50")).toBe(
      false,
    )
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.some((message) => message.id === "m20")).toBe(false)
    expect(boundaries).toHaveLength(3)
    app.dispose()
    cache.dispose()
  })

  test("a changed session timestamp rechecks retained history even without a reconnect event", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 60), { validated: true, updated: 1 })
    const boundaries: number[] = []
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json({ ...title, time: { created: 0, updated: 2 } })
      const before = new URL(request.url).searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : 60
      boundaries.push(end)
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session.filter((info) => info.id !== "m20").map((info) => ({ info, parts: [text(info.time.created)] })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([60, 40, 20])
    expect(cache.read("/work", "s", 100)?.session.some((message) => message.id === "m20")).toBe(false)
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([60, 40, 20, 60])
    await app.sync.session.history.loadMore("s")
    expect(boundaries).toHaveLength(4)
    app.dispose()
    cache.dispose()
  })

  test("deleting the whole loaded history anchor shows surviving messages without confirming an unsent draft", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 60), { validated: true, updated: 1 })
    let end = 60
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s"))
        return Response.json({ ...title, time: { created: 0, updated: end === 60 ? 1 : 2 } })
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session.map((info) => ({ info, parts: [text(info.time.created)] })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    await app.sync.session.sync("s", { force: true })
    await app.sync.session.history.loadMore("s")
    app.sync.session.optimistic.add({ sessionID: "s", message: message(99), parts: [text(99)] })
    end = 10
    await app.sync.session.sync("s", { force: true })
    expect(app.store.message.s?.map((message) => message.id)).toEqual([
      ...page(0, 10).session.map((message) => message.id),
      "m99",
    ])
    expect(cache.read("/work", "s", 100)?.session.map((message) => message.id)).toEqual(
      page(0, 10).session.map((message) => message.id),
    )
    expect(app.store.part.m20).toBeUndefined()
    expect(app.store.part.m99?.[0]).toEqual(text(99))
    app.dispose()
    cache.dispose()
  })
  test("history fetches only the missing page after the local range is exhausted", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(20, 40))
    let requests = 0
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return new Response("offline", { status: 503 })
      requests++
      expect(new URL(request.url).searchParams.get("before")).toBe(transcriptCursor(message(20)))
      return Response.json(page(0, 20).session.map((info) => ({ info, parts: [text(info.time.created)] })))
    })
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    await app.sync.session.history.loadMore("s")
    expect(requests).toBe(1)
    expect(app.store.message.s?.length).toBe(40)
    expect(app.sync.session.history.more("s")).toBe(false)
    app.dispose()
    cache.dispose()
  })

  test("a server 404 removes the persisted session instead of reopening a deleted transcript", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 1))
    const app = context(cache, async () => new Response("deleted", { status: 404 }))
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    expect(cache.read("/work", "s")).toBeUndefined()
    expect(app.store.message.s).toBeUndefined()
    app.dispose()
    cache.dispose()
  })

  test("a new connection compares unloaded ranges for missed edits and retains unchanged pages on normal refresh", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 60))
    let requests = 0
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json(title)
      requests++
      const before = new URL(request.url).searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : 60
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session.map((info) => ({
          info,
          parts: [{ ...text(info.time.created), text: before ? "historical edit" : `body ${info.time.created}` }],
        })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    await app.sync.session.sync("s", { force: true })
    expect(requests).toBe(3)
    expect(app.store.message.s?.length).toBe(20)
    await app.sync.session.sync("s", { force: true })
    expect(requests).toBe(4)
    await app.sync.session.history.loadMore("s")
    expect(requests).toBe(4)
    expect(app.store.part.m20?.[0]).toMatchObject({ text: "historical edit" })
    app.dispose()
    cache.dispose()
  })
  test("an obsolete renderer cache cannot resurrect data after a newer owner deletes it", async () => {
    const source = disk()
    const old = createTranscriptCache(source.storage, "sidecar.v1")
    await old.ready
    old.write("/work", "s", page(0, 1))
    await old.flush()
    const current = createTranscriptCache(source.storage, "sidecar.v1")
    await current.ready
    current.remove("/work", "s")
    await current.flush()
    old.dispose()
    await old.flush()
    const restarted = createTranscriptCache(source.storage, "sidecar.v1")
    await restarted.ready
    expect(restarted.read("/work", "s")).toBeUndefined()
    current.dispose()
    restarted.dispose()
  })
  test("restart hydrates recent 20 before network resolves and cached history needs no network", async () => {
    const storage = disk().storage
    const original = createTranscriptCache(storage, "sidecar.v1")
    await original.ready
    original.write("/work", "s", page(40, 60))
    original.write("/work", "s", page(20, 40), { before: transcriptCursor(message(40)) })
    original.write("/work", "s", page(0, 20), { before: transcriptCursor(message(20)) })
    await original.flush()
    original.dispose()
    const restarted = createTranscriptCache(storage, "sidecar.v1")
    await restarted.ready
    let requests = 0
    let finish!: (response: Response) => void
    const app = context(restarted, async () => {
      requests++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.store.message.s?.map((m) => m.id)).toEqual(page(40, 60).session.map((m) => m.id))
    expect(app.store.part.m59?.[0]).toEqual(text(59))
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.length).toBe(40)
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.length).toBe(60)
    expect(requests).toBe(1)
    expect(app.sync.session.history.more("s")).toBe(false)
    // Finish the pending session request with an error so this test remains an offline restart.
    finish(new Response("offline", { status: 503 }))
    await pending.catch(() => undefined)
    app.dispose()
    restarted.dispose()
  })

  test("catch-up walks past >20 new messages to overlap but renders only the recent window", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 20))
    const boundaries: number[] = []
    const app = context(cache, async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/message")) return Response.json(title)
      const before = url.searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : 75
      boundaries.push(end)
      const result = page(Math.max(0, end - 20), end)
      return Response.json(
        result.session.map((info) => ({ info, parts: result.part.find((item) => item.id === info.id)!.part })),
        { headers: result.cursor ? { "x-next-cursor": result.cursor } : {} },
      )
    })
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([75, 55, 35, 15])
    expect(app.store.message.s?.map((m) => m.id)).toEqual(page(55, 75).session.map((m) => m.id))
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.map((m) => m.id)).toEqual(page(35, 75).session.map((m) => m.id))
    expect(boundaries).toHaveLength(4)
    app.dispose()
    cache.dispose()
  })

  test("live parts replace, stream and remove; deleted messages and sessions stay deleted after restart", async () => {
    const storage = disk().storage
    const cache = createTranscriptCache(storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 3))
    const before = cache.revision("/work", "s")
    cache.event("/work", { type: "message.part.updated", properties: { part: { ...text(2), text: "new" } } })
    cache.event("/work", {
      type: "message.part.delta",
      properties: { messageID: "m2", partID: "p2", field: "text", delta: " delta" },
    })
    expect(cache.read("/work", "s")?.part.find((p) => p.id === "m2")?.part[0]).toMatchObject({ text: "new delta" })
    cache.event("/work", { type: "message.part.removed", properties: { messageID: "m2", partID: "p2" } })
    cache.event("/work", { type: "message.removed", properties: { sessionID: "s", messageID: "m1" } })
    expect(cache.revision("/work", "s")).toBeGreaterThan(before)
    await cache.flush()
    const next = createTranscriptCache(storage, "sidecar.v1")
    await next.ready
    expect(next.read("/work", "s")?.session.map((m) => m.id)).toEqual(["m0", "m2"])
    expect(next.read("/work", "s")?.part.find((p) => p.id === "m2")?.part).toEqual([])
    next.event("/work", { type: "session.deleted", properties: { info: title } })
    await next.flush()
    const final = createTranscriptCache(storage, "sidecar.v1")
    await final.ready
    expect(final.read("/work", "s")).toBeUndefined()
    cache.dispose()
    next.dispose()
    final.dispose()
  })

  test("isolates directories and server identities, clears restore ranges and rejects malformed associations", async () => {
    const { storage, data } = disk()
    const a = createTranscriptCache(storage, `tunnel.v1.${"a".repeat(64)}`)
    await a.ready
    a.write("/work", "s", page(0, 20))
    a.write("/other", "s", page(20, 40))
    a.write("/invalid", "s", { ...page(0, 1), part: [{ id: "m0", part: [{ ...text(0), sessionID: "wrong" }] }] })
    expect(a.read("/invalid", "s")).toBeUndefined()
    a.clearDirectory("/work")
    await a.flush()
    const b = createTranscriptCache(storage, `tunnel.v1.${"b".repeat(64)}`)
    const local = createTranscriptCache(storage, "sidecar.v1")
    await Promise.all([b.ready, local.ready])
    expect(b.read("/other", "s")).toBeUndefined()
    expect(local.read("/other", "s")).toBeUndefined()
    expect(a.read("/other", "s")?.session.length).toBe(20)
    expect(a.read("/work", "s")).toBeUndefined()
    const invalid = createTranscriptCache(storage, "../scope")
    await invalid.ready
    invalid.write("/work", "s", page(0, 1))
    await invalid.flush()
    expect(data.size).toBe(1)
    a.dispose()
    b.dispose()
    local.dispose()
    invalid.dispose()
  })

  test("bounded LRU evicts cold transcripts rather than drafts or server metadata", async () => {
    const { storage, data } = disk()
    const cache = createTranscriptCache(storage, "sidecar.v1", 700)
    await cache.ready
    cache.write("/cold", "s", page(0, 1))
    cache.write("/warm", "s", page(0, 1))
    cache.read("/cold", "s")
    cache.write("/new", "s", page(0, 1))
    await cache.flush()
    expect(new TextEncoder().encode(data.get("sidecar.v1")!).length).toBeLessThanOrEqual(700)
    expect(cache.read("/warm", "s")).toBeUndefined()
    expect(cache.read("/cold", "s")).toBeDefined()
    expect(cache.read("/new", "s")).toBeDefined()
    cache.dispose()
  })

  test("startup deletion and restore cannot be resurrected by a late disk read", async () => {
    const source = disk()
    const cache = createTranscriptCache(source.storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 1))
    cache.write("/restored", "s", page(0, 1))
    await cache.flush()
    const late = createTranscriptCache(source.storage, "sidecar.v1")
    late.remove("/work", "s")
    late.clearDirectory("/restored")
    await late.ready
    expect(late.read("/work", "s")).toBeUndefined()
    expect(late.read("/restored", "s")).toBeUndefined()
    cache.dispose()
    late.dispose()
  })

  test("stale fetched parts cannot overwrite a newer stream", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 2))
    let finish!: (response: Response) => void
    let requests = 0
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return Response.json(title)
      requests++
      if (requests === 1)
        return new Promise((resolve) => {
          finish = resolve
        })
      return Response.json(
        page(0, 2).session.map((info) => ({ info, parts: [{ ...text(info.time.created), text: "streamed" }] })),
      )
    })
    const pending = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    cache.event("/work", { type: "message.part.updated", properties: { part: { ...text(1), text: "streamed" } } })
    app.setStore("part", "m1", [{ ...text(1), text: "streamed" }])
    finish(Response.json(page(0, 2).session.map((info) => ({ info, parts: [text(info.time.created)] }))))
    await pending
    expect(app.store.part.m1?.[0]).toMatchObject({ text: "streamed" })
    expect(requests).toBe(2)
    expect(cache.read("/work", "s")?.part.find((item) => item.id === "m1")?.part[0]).toMatchObject({ text: "streamed" })
    app.dispose()
    cache.dispose()
  })

  test("online refresh removes deleted messages and empty parts, excludes unsent optimistic messages", async () => {
    const cache = createTranscriptCache(disk().storage, "sidecar.v1")
    await cache.ready
    cache.write("/work", "s", page(0, 3))
    const app = context(cache, async (request) =>
      request.url.endsWith("/s")
        ? Response.json(title)
        : Response.json([
            { info: message(0), parts: [] },
            { info: message(2), parts: [] },
          ]),
    )
    app.sync.session.optimistic.add({ sessionID: "s", message: message(3), parts: [text(3)] })
    await app.sync.session.sync("s", { force: true })
    expect(app.store.message.s?.map((m) => m.id)).toEqual(["m0", "m2", "m3"])
    expect(app.store.part.m2).toEqual([])
    expect(cache.read("/work", "s")?.session.map((m) => m.id)).toEqual(["m0", "m2"])
    expect(cache.read("/work", "s")?.part.every((item) => item.part.length === 0)).toBe(true)
    app.dispose()
    cache.dispose()
  })
})
