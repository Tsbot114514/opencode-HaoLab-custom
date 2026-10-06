import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createComponent, createResource, createRoot, Suspense } from "solid-js"
import { insert, isServer, render } from "solid-js/web"
import { createStore, reconcile } from "solid-js/store"
import { createDirSyncContext } from "../directory-sync"
import { createTranscriptCache, transcriptCursor, validEntry, type TranscriptPage } from "./transcript-cache"
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
const assistant = (index: number, parentID = "m0"): Message => ({
  id: `m${index}`, sessionID: "s", role: "assistant", parentID, time: { created: index },
  modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/work", root: "/work" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
        (input: RequestInfo | URL) => {
          const request = input instanceof Request ? input : new Request(input)
          // This suite exercises the shipped bounded-page fallback against an old A.
          if (new URL(request.url).pathname.includes("/transcript/")) return Promise.resolve(new Response("Unknown route", { status: 404 }))
          return fetcher(request)
        },
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

describe("mobile recent-page authority", () => {
  const host = window as Window & { __HAOLAB_MOBILE__?: boolean }
  let previous: boolean | undefined
  beforeEach(() => { previous = host.__HAOLAB_MOBILE__; host.__HAOLAB_MOBILE__ = true })
  afterEach(() => { host.__HAOLAB_MOBILE__ = previous })

  function fixtureFor(count: number) {
    const source = disk()
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...page(0, count), updated: 1 }] }))
    const cache = createTranscriptCache(source.storage, "sidecar.v1")
    const server = { page: page(0, count + 1), offline: false }
    const requests: URL[] = []
    const respond = async (request: Request) => {
      const url = new URL(request.url)
      requests.push(url)
      if (server.offline) throw new Error("fixture offline")
      if (!url.pathname.endsWith("/message")) return Response.json(title)
      const before = url.searchParams.get("before")
      const end = before ? JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))).time : Infinity
      const items = server.page.session.filter((message) => message.time.created < end)
      const session = items.slice(-Number(url.searchParams.get("limit")))
      const cursor = items.length > session.length ? transcriptCursor(session[0]) : undefined
      return Response.json(session.map((info) => ({ info, parts: server.page.part.find((part) => part.id === info.id)?.part ?? [] })), { headers: cursor ? { "x-next-cursor": cursor } : {} })
    }
    return { cache, source, server, requests, respond }
  }

  for (const count of [20, 100, 300]) test(`reopening ${count} cached messages publishes only the recent page`, async () => {
    const fixture = fixtureFor(count)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(app.store.message.s).toHaveLength(20)
    expect(app.store.message.s.at(-1)?.id).toBe(`m${count}`)
    expect(fixture.requests.filter((url) => url.pathname.endsWith("/message"))).toHaveLength(1)
    expect(fixture.cache.validationBoundary("/work", "s")?.id).toBe("m0")
    expect(fixture.cache.validatedPage("/work", "s", fixture.cache.read("/work", "s")!)).toBe(true)
    expect(fixture.cache.validatedPage("/work", "s", page(0, 20), message(20))).toBe(false)
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(count + 10)))).toBe(true)
    expect(fixture.cache.read("/work", "s", 1000)?.session).toHaveLength(count + 1)
    app.dispose(); fixture.cache.dispose()
  })

  test("a huge offline gap validates the tail without confirming or downloading old history", async () => {
    const fixture = fixtureFor(300)
    fixture.server.page = page(0, 1000)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(app.store.message.s.at(-1)?.id).toBe("m999")
    expect(fixture.requests.filter((url) => url.pathname.endsWith("/message"))).toHaveLength(1)
    expect(fixture.cache.read("/work", "s", 1000)?.session).toHaveLength(20)
    await fixture.cache.flush()
    expect(JSON.parse(fixture.source.data.get("sidecar.v1")!).entries[0].session).toHaveLength(320)
    expect(fixture.cache.validatedPage("/work", "s", page(280, 300), message(300))).toBe(false)
    app.emit({ type: "message.updated", properties: { info: message(1000) } })
    app.emit({ type: "message.part.updated", properties: { part: text(1000) } })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m1000")
    expect(fixture.cache.read("/work", "s")?.part.at(-1)?.part[0]).toMatchObject({ text: "body 1000" })
    fixture.cache.revalidate()
    app.emit({ type: "message.updated", properties: { info: message(1001) } })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m1000")
    app.dispose(); fixture.cache.dispose()
  })

  test("requested history renders locally, then reconciles edits and absence with one bounded page", async () => {
    const fixture = fixtureFor(100)
    fixture.server.page.session = fixture.server.page.session.filter((message) => message.id !== "m70")
    fixture.server.page.part.find((part) => part.id === "m71")!.part = [{ ...text(71), text: "edited online" }]
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(fixture.cache.read("/work", "s", 1000)?.session.some((message) => message.id === "m70")).toBe(true)
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(81)))).toBe(true)
    let release!: (response: Response) => void
    const held = context(fixture.cache, async (request) => {
      if (new URL(request.url).searchParams.has("before")) return new Promise((resolve) => { release = resolve })
      return fixture.respond(request)
    })
    await held.sync.session.sync("s", { force: true })
    const more = held.sync.session.history.loadMore("s")
    while (!release) await Bun.sleep(0)
    expect(held.store.message.s.some((message) => message.id === "m70")).toBe(true)
    expect(held.store.part.m71[0]).toMatchObject({ text: "body 71" })
    release(await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=20&before=${transcriptCursor(message(81))}`)))
    await more
    expect(held.store.message.s.some((message) => message.id === "m70")).toBe(false)
    expect(held.store.part.m70).toBeUndefined()
    expect(held.store.part.m71[0]).toMatchObject({ text: "edited online" })
    expect(held.store.message.s.at(-1)?.id).toBe("m100")
    expect(fixture.cache.validatedPage("/work", "s", page(0, 20), message(20))).toBe(false)
    expect(held.sync.session.history.provisional("s", transcriptCursor(message(81)))).toBe(false)
    expect(fixture.requests.filter((url) => url.searchParams.has("before"))).toHaveLength(1)
    app.dispose(); held.dispose(); fixture.cache.dispose()
  })

  test("failed historical validation retains provisional local history and the latest tail", async () => {
    const fixture = fixtureFor(100)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    fixture.server.offline = true
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s).toHaveLength(40)
    expect(app.store.message.s.at(-1)?.id).toBe("m100")
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(81)))).toBe(true)
    app.dispose(); fixture.cache.dispose()
  })

  test("the oldest deleted and edited messages remain provisional until their requested range is checked", async () => {
    const fixture = fixtureFor(300)
    fixture.server.page.session = fixture.server.page.session.filter((message) => message.id !== "m0")
    fixture.server.page.part.find((part) => part.id === "m1")!.part = [{ ...text(1), text: "oldest edit" }]
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(fixture.cache.read("/work", "s", 1000)?.session[0].id).toBe("m0")
    expect(fixture.cache.validatedPage("/work", "s", page(0, 20), message(20))).toBe(false)
    app.setStore("message", "s", [...page(0, 21).session, ...app.store.message.s])
    await app.sync.session.history.validate("s", transcriptCursor(message(20)))
    expect(app.store.message.s.some((message) => message.id === "m0")).toBe(false)
    expect(app.store.part.m1[0]).toMatchObject({ text: "oldest edit" })
    expect(fixture.cache.read("/work", "s", 1000)?.session[0].id).toBe("m1")
    expect(fixture.requests.filter((url) => url.searchParams.has("before"))).toHaveLength(1)
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(20)))).toBe(false)
    expect(fixture.cache.validatedPage("/work", "s", page(100, 120), message(120))).toBe(false)
    app.dispose(); fixture.cache.dispose()
  })

  test("metadata failure leaves cached visibility intact while an already completed parallel body stays unconfirmed", async () => {
    const fixture = fixtureFor(100)
    let release!: (response: Response) => void
    const app = context(fixture.cache, async (request) => {
      if (!new URL(request.url).pathname.endsWith("/message")) return new Promise((resolve) => { release = resolve })
      return fixture.respond(request)
    })
    const sync = app.sync.session.sync("s", { force: true }).catch(() => undefined)
    while (!release || !fixture.requests.length) await Bun.sleep(0)
    expect(app.store.message.s.at(-1)?.id).toBe("m99")
    release(Response.json({ message: "unavailable" }, { status: 503 }))
    await sync
    expect(app.store.message.s.at(-1)?.id).toBe("m99")
    expect(fixture.cache.validatedPage("/work", "s", fixture.cache.read("/work", "s")!)).toBe(false)
    app.dispose(); fixture.cache.dispose()
  })

  test("confirmed optimistic user and live assistant reply persist with dirty historical ranges", async () => {
    const fixture = fixtureFor(100)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    app.sync.session.optimistic.add({ sessionID: "s", message: message(101), parts: [text(101)] })
    fixture.server.page = page(0, 102)
    await app.sync.session.sync("s", { force: true })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m101")
    expect(app.store.message.s.some((message) => message.id === "m101")).toBe(true)
    const reply: Message = {
      id: "m102", sessionID: "s", role: "assistant", parentID: "m101", time: { created: 102 },
      modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/work", root: "/work" },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    fixture.cache.event("/work", { type: "message.updated", properties: { info: reply } })
    fixture.cache.event("/work", { type: "message.part.updated", properties: { part: text(102) } })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m102")
    expect(fixture.cache.validatedPage("/work", "s", page(0, 20), message(20))).toBe(false)
    app.dispose(); fixture.cache.dispose()
  })

  for (const deletion of ["event", "404", "restore"] as const) test(`${deletion} blocks parallel latest-message publication`, async () => {
    const fixture = fixtureFor(100)
    let release!: (response: Response) => void
    const app = context(fixture.cache, async (request) => {
      if (!new URL(request.url).pathname.endsWith("/message")) return new Promise((resolve) => { release = resolve })
      return fixture.respond(request)
    })
    const sync = app.sync.session.sync("s", { force: true }).catch(() => undefined)
    while (!release || fixture.requests.length === 0) await Bun.sleep(0)
    expect(app.store.message.s.at(-1)?.id).toBe("m99")
    if (deletion === "event") app.emit({ type: "session.deleted", properties: { info: title } })
    if (deletion === "restore") { fixture.cache.clearDirectory("/work"); app.sync.invalidate(); app.setStore("message", reconcile({})) }
    release(Response.json(title, { status: deletion === "404" ? 404 : 200 }))
    await sync
    expect(fixture.cache.read("/work", "s")).toBeUndefined()
    expect(app.store.message.s).toBeUndefined()
    app.dispose(); fixture.cache.dispose()
  })

  test("late historical parts cannot overwrite a newer SSE edit or confirm an unsent optimistic message", async () => {
    const fixture = fixtureFor(100)
    let release!: (response: Response) => void
    let hold = true
    const app = context(fixture.cache, async (request) => {
      if (hold && new URL(request.url).searchParams.has("before")) {
        hold = false
        return new Promise((resolve) => { release = resolve })
      }
      return fixture.respond(request)
    })
    await app.sync.session.sync("s", { force: true })
    app.sync.session.optimistic.add({ sessionID: "s", message: message(101), parts: [text(101)] })
    const history = app.sync.session.history.loadMore("s")
    while (!release) await Bun.sleep(0)
    const stale = await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=20&before=${transcriptCursor(message(81))}`))
    fixture.server.page.part.find((part) => part.id === "m71")!.part = [{ ...text(71), text: "new SSE" }]
    app.emit({ type: "message.part.updated", properties: { part: { ...text(71), text: "new SSE" } } })
    release(stale)
    await history
    expect(app.store.part.m71[0]).toMatchObject({ text: "new SSE" })
    expect(app.store.message.s.at(-1)?.id).toBe("m101")
    expect(fixture.cache.read("/work", "s", 1000)?.session.some((message) => message.id === "m101")).toBe(false)
    app.dispose(); fixture.cache.dispose()
  })

  test("a late history response cannot overwrite a newer authoritative HTTP tail without SSE", async () => {
    const fixture = fixtureFor(100)
    let release!: (response: Response) => void
    let hold = true
    const app = context(fixture.cache, async (request) => {
      if (hold && new URL(request.url).searchParams.has("before")) {
        hold = false
        return new Promise((resolve) => { release = resolve })
      }
      return fixture.respond(request)
    })
    await app.sync.session.sync("s", { force: true })
    const more = app.sync.session.history.loadMore("s")
    while (!release) await Bun.sleep(0)
    const stale = await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=20&before=${transcriptCursor(message(81))}`))
    fixture.server.page = page(0, 81)
    fixture.server.page.session = fixture.server.page.session.filter((message) => message.id !== "m70")
    fixture.server.page.part.find((part) => part.id === "m71")!.part = [{ ...text(71), text: "new HTTP tail" }]
    await app.sync.session.sync("s", { force: true })
    expect(app.store.message.s.some((message) => message.id === "m70")).toBe(false)
    expect(app.store.part.m71[0]).toMatchObject({ text: "new HTTP tail" })
    release(stale)
    await more
    expect(app.store.message.s.some((message) => message.id === "m70")).toBe(false)
    expect(app.store.part.m71[0]).toMatchObject({ text: "new HTTP tail" })
    expect(fixture.cache.read("/work", "s")?.session.some((message) => message.id === "m70")).toBe(false)
    expect(fixture.cache.read("/work", "s")?.part.find((part) => part.id === "m71")?.part[0]).toMatchObject({ text: "new HTTP tail" })
    app.dispose(); fixture.cache.dispose()
  })

  for (const restart of [false, true]) test(`a persisted offline gap keeps server paging contiguous (restart=${restart})`, async () => {
    const fixture = fixtureFor(300)
    fixture.server.page = page(0, 1000)
    const initial = context(fixture.cache, fixture.respond)
    await initial.sync.session.sync("s", { force: true })
    expect(fixture.cache.available("/work", "s", transcriptCursor(message(980)))).toBe(false)
    expect(fixture.cache.read("/work", "s", 20, transcriptCursor(message(980)))).toBeUndefined()
    await fixture.cache.flush()
    const persisted = JSON.parse(fixture.source.data.get("sidecar.v1")!).entries[0]
    expect(persisted.session).toHaveLength(320)
    expect(persisted.gaps).toEqual(["m980"])
    initial.dispose()
    const cache = restart ? createTranscriptCache(fixture.source.storage, "sidecar.v1") : fixture.cache
    const app = context(cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    fixture.server.offline = true
    await app.sync.session.history.loadMore("s").catch(() => undefined)
    expect(app.store.message.s[0].id).toBe("m980")
    expect(app.store.message.s).toHaveLength(20)
    fixture.server.offline = false
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s[0].id).toBe("m960")
    expect(app.store.message.s).toHaveLength(40)
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s[0].id).toBe("m940")
    expect(app.store.message.s).toHaveLength(60)
    expect(fixture.requests.filter((url) => url.searchParams.has("before")).map((url) => url.searchParams.get("before"))).toEqual(
      [980, 980, 960].map((index) => transcriptCursor(message(index))),
    )
    expect(cache.read("/work", "s", 1000)?.session).toHaveLength(60)
    expect(cache.available("/work", "s", transcriptCursor(message(940)))).toBe(false)
    expect(cache.read("/work", "s", 20, transcriptCursor(message(299)))?.session).toHaveLength(20)
    await cache.flush()
    const next = JSON.parse(fixture.source.data.get("sidecar.v1")!).entries[0]
    expect(next.session).toHaveLength(360)
    expect(next.gaps).toEqual(["m940"])
    const hydrated = createTranscriptCache(fixture.source.storage, "sidecar.v1")
    await hydrated.ready
    expect(hydrated.read("/work", "s", 1000)?.session[0].id).toBe("m940")
    expect(hydrated.read("/work", "s", 20, transcriptCursor(message(940)))).toBeUndefined()
    app.dispose(); cache.dispose(); fixture.cache.dispose(); hydrated.dispose()
  })

  test("a targeted history page bridges a conservative gap without discarding retained data", async () => {
    const fixture = fixtureFor(300)
    fixture.server.page = page(0, 320)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(fixture.cache.available("/work", "s", transcriptCursor(message(300)))).toBe(false)
    await app.sync.session.history.loadMore("s")
    expect(fixture.requests.filter((url) => url.searchParams.has("before"))).toHaveLength(1)
    expect(fixture.cache.read("/work", "s", 1000)?.session).toHaveLength(320)
    expect(fixture.cache.available("/work", "s", transcriptCursor(message(300)))).toBe(true)
    await fixture.cache.flush()
    expect(JSON.parse(fixture.source.data.get("sidecar.v1")!).entries[0].gaps).toBeUndefined()
    app.dispose(); fixture.cache.dispose()
  })

  test("removing a segment boundary keeps the unknown gap attached to its surviving successor", async () => {
    const fixture = fixtureFor(300)
    fixture.server.page = page(0, 1000)
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    app.emit({ type: "message.removed", properties: { sessionID: "s", messageID: "m980" } })
    expect(fixture.cache.available("/work", "s", transcriptCursor(message(981)))).toBe(false)
    expect(fixture.cache.read("/work", "s", 1000)?.session).toHaveLength(19)
    await fixture.cache.flush()
    expect(JSON.parse(fixture.source.data.get("sidecar.v1")!).entries[0].gaps).toEqual(["m981"])
    app.dispose(); fixture.cache.dispose()
  })

  test("three disjoint older completions cannot starve a held fresh tail", async () => {
    const fixture = fixtureFor(100)
    const history = new Map<string, (response: Response) => void>()
    let releaseTail!: (response: Response) => void
    let hold = false
    const reads: (string | null)[] = []
    const app = context(fixture.cache, async (request) => {
      const before = new URL(request.url).searchParams.get("before")
      if (new URL(request.url).pathname.endsWith("/message")) reads.push(before)
      if (hold && new URL(request.url).pathname.endsWith("/message")) return new Promise((resolve) => {
        if (before) history.set(before, resolve)
        if (!before) releaseTail = resolve
      })
      return fixture.respond(request)
    })
    await app.sync.session.sync("s", { force: true })
    fixture.server.page = page(0, 121)
    hold = true
    const tail = app.sync.session.sync("s", { force: true })
    while (!releaseTail) await Bun.sleep(0)
    const pending: Promise<void>[] = []
    for (const index of [81, 61, 41]) {
      pending.push(app.sync.session.history.loadMore("s"))
      while (!history.has(transcriptCursor(message(index)))) await Bun.sleep(0)
    }
    const captured = fixture.cache.tailRevision("/work", "s")
    for (const [offset, index] of [81, 61, 41].entries()) {
      history.get(transcriptCursor(message(index)))!(await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=20&before=${transcriptCursor(message(index))}`)))
      await pending[offset]
      expect(fixture.cache.tailRevision("/work", "s")).toBe(captured)
    }
    hold = false
    releaseTail(await fixture.respond(new Request("http://transcripts.test/session/s/message?limit=20")))
    await tail
    expect(app.store.message.s.at(-1)?.id).toBe("m120")
    expect(app.store.part.m120[0]).toMatchObject({ text: "body 120" })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m120")
    expect(fixture.requests.filter((url) => url.pathname.endsWith("/message") && !url.searchParams.has("before"))).toHaveLength(2)
    expect(fixture.requests.filter((url) => url.searchParams.has("before"))).toHaveLength(3)
    expect(reads).toEqual([null, null, ...[81, 61, 41].map((index) => transcriptCursor(message(index)))])
    // A retained visible range stays rendered, but paging must bridge the new tail boundary first.
    await app.sync.session.history.loadMore("s")
    expect(fixture.requests.filter((url) => url.searchParams.has("before")).at(-1)?.searchParams.get("before")).toBe(transcriptCursor(message(101)))
    app.dispose(); fixture.cache.dispose()
  })

  test("a later overlapping historical commit survives stream revalidation without invalidating tail reads", async () => {
    const fixture = fixtureFor(100)
    let release!: (response: Response) => void
    let hold = true
    const retry = Promise.withResolvers<void>()
    const fresh = Promise.withResolvers<Response>()
    let rechecking = false
    const app = context(fixture.cache, async (request) => {
      if (rechecking && new URL(request.url).searchParams.get("before") === transcriptCursor(message(81))) {
        retry.resolve()
        return fresh.promise
      }
      if (hold && new URL(request.url).searchParams.get("before") === transcriptCursor(message(81))) {
        hold = false
        return new Promise((resolve) => { release = resolve })
      }
      return fixture.respond(request)
    })
    await app.sync.session.sync("s", { force: true })
    const more = app.sync.session.history.loadMore("s", 40)
    while (!release) await Bun.sleep(0)
    const stale = await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=40&before=${transcriptCursor(message(81))}`))
    fixture.server.page.part.find((part) => part.id === "m50")!.part = [{ ...text(50), text: "new historical HTTP part" }]
    const tail = fixture.cache.tailRevision("/work", "s")
    await app.sync.session.history.validate("s", transcriptCursor(message(61)))
    expect(fixture.cache.tailRevision("/work", "s")).toBe(tail)
    expect(app.store.part.m50[0]).toMatchObject({ text: "new historical HTTP part" })
    fixture.cache.revalidate()
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(61)))).toBe(true)
    rechecking = true
    release(stale)
    expect(await Promise.race([retry.promise.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
    expect(app.store.part.m50[0]).toMatchObject({ text: "new historical HTTP part" })
    expect(fixture.cache.read("/work", "s", 1000)?.part.find((part) => part.id === "m50")?.part[0]).toMatchObject({ text: "new historical HTTP part" })
    expect(app.sync.session.history.provisional("s", transcriptCursor(message(61)))).toBe(true)
    fresh.resolve(await fixture.respond(new Request(`http://transcripts.test/session/s/message?limit=40&before=${transcriptCursor(message(81))}`)))
    await more
    expect(app.store.part.m50[0]).toMatchObject({ text: "new historical HTTP part" })
    expect(fixture.cache.read("/work", "s", 1000)?.part.find((part) => part.id === "m50")?.part[0]).toMatchObject({ text: "new historical HTTP part" })
    expect(fixture.cache.tailRevision("/work", "s")).toBe(tail)
    expect(fixture.cache.validatedPage("/work", "s", fixture.cache.read("/work", "s")!)).toBe(false)
    expect(fixture.cache.validatedPage("/work", "s", page(0, 20), message(20))).toBe(false)
    expect(fixture.requests.filter((url) => url.searchParams.has("before"))).toHaveLength(3)
    app.dispose(); fixture.cache.dispose()
  })

  test("an ordered assistant reply with an uncached parent extends a confirmed live tail and persists parts", async () => {
    const fixture = fixtureFor(40)
    const cached = { ...page(21, 41), session: page(21, 41).session.map((message) => assistant(message.time.created)) }
    fixture.source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...cached, updated: 1 }] }))
    fixture.server.page.session = fixture.server.page.session.map((message) => message.id === "m0" ? message : assistant(message.time.created))
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    expect(fixture.cache.read("/work", "s", 1000)?.session.some((message) => message.id === "m0")).toBe(false)
    app.emit({ type: "message.updated", properties: { info: assistant(41) } })
    app.emit({ type: "message.part.updated", properties: { part: text(41) } })
    app.emit({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m41", partID: "p41", field: "text", delta: " streamed" } })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m41")
    expect(fixture.cache.read("/work", "s")?.part.at(-1)?.part[0]).toMatchObject({ text: "body 41 streamed" })
    await fixture.cache.flush()
    const hydrated = createTranscriptCache(fixture.source.storage, "sidecar.v1")
    await hydrated.ready
    expect(hydrated.read("/work", "s")?.session.at(-1)?.id).toBe("m41")
    expect(hydrated.read("/work", "s")?.part.at(-1)?.part[0]).toMatchObject({ text: "body 41 streamed" })
    hydrated.activate("/work", "s")
    hydrated.event("/work", { type: "message.updated", properties: { info: assistant(42) } })
    expect(hydrated.read("/work", "s")?.session.at(-1)?.id).toBe("m41")
    app.emit({ type: "message.updated", properties: { info: assistant(20) } })
    expect(fixture.cache.read("/work", "s")?.session.some((message) => message.id === "m20")).toBe(false)
    fixture.cache.remove("/work", "s")
    fixture.cache.event("/work", { type: "message.updated", properties: { info: assistant(43) } })
    expect(fixture.cache.read("/work", "s")).toBeUndefined()
    app.dispose(); fixture.cache.dispose(); hydrated.dispose()
  })

  for (const state of ["unopened", "unvalidated", "older", "other-parent"] as const) test(`an uncached-parent assistant does not bypass ${state} guards`, async () => {
    const fixture = fixtureFor(40)
    const cached = { ...page(21, 41), session: page(21, 41).session.map((message) => assistant(message.time.created)) }
    fixture.source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...cached, updated: 1 }] }))
    fixture.server.page.session = fixture.server.page.session.map((message) => message.id === "m0" ? message : assistant(message.time.created))
    const app = context(fixture.cache, fixture.respond)
    await app.sync.session.sync("s", { force: true })
    if (state === "unopened") app.sync.session.deactivate()
    if (state === "unvalidated") fixture.cache.revalidate()
    app.emit({ type: "message.updated", properties: { info: assistant(state === "older" ? 20 : 41, state === "other-parent" ? "missing" : "m0") } })
    expect(fixture.cache.read("/work", "s")?.session.at(-1)?.id).toBe("m40")
    expect(fixture.cache.read("/work", "s", 1000)?.session.some((message) => message.id === "m20" || message.id === "m41")).toBe(false)
    app.dispose(); fixture.cache.dispose()
  })

  test("persisted gap metadata rejects unknown, duplicate, first-message and out-of-order boundaries", () => {
    const entry = { directory: "/work", sessionID: "s", ...page(0, 40) }
    expect(validEntry(entry)).toBe(true)
    expect(validEntry({ ...entry, gaps: [] })).toBe(true)
    expect(validEntry({ ...entry, gaps: ["m10", "m20"] })).toBe(true)
    for (const gaps of [null, "m20", [1], ["missing"], ["m0"], ["m20", "m20"], ["m20", "m10"], Array(41).fill("m20")]) {
      expect(validEntry({ ...entry, gaps })).toBe(false)
    }
  })

  test("commit ownership is retained while dirty but released with entry eviction or invalidation generations", async () => {
    for (const action of ["evict", "remove", "clear", "invalidate"] as const) {
      const source = disk()
      const budget = new TextEncoder().encode(JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...page(0, 1), updated: 1 }] })).length + 16
      const cache = createTranscriptCache(source.storage, "sidecar.v1", budget)
      await cache.ready
      cache.write("/work", "s", page(0, 1), { range: {}, updated: 1 })
      const captured = cache.revision("/work", "s")
      cache.revalidate()
      expect(cache.changedPage("/work", "s", 0, page(0, 1), message(1))).toBe(true)
      expect(cache.validatedPage("/work", "s", page(0, 1))).toBe(false)
      if (action === "evict") cache.write("/other", "s", page(0, 1), { range: {}, updated: 1 })
      if (action === "remove") cache.remove("/work", "s")
      if (action === "clear") cache.clearDirectory("/work")
      if (action === "invalidate") cache.invalidate("/work")
      expect(cache.revision("/work", "s")).toBeGreaterThan(captured)
      expect(cache.changedPage("/work", "s", 0, page(0, 1), message(1))).toBe(false)
      expect(cache.rangeRevision("/work", "s")).toBe(0)
      expect(cache.tailRevision("/work", "s")).toBe(0)
      cache.dispose()
      await cache.flush()
    }
  })
})

describe("persistent transcript pages", () => {
  test("cold messages dispatch while metadata, grant acquisition and an unrelated disk write are held", async () => {
    let releaseWrite!: () => void
    let releaseGrant!: () => void
    const cache = createTranscriptCache({
      getItem: async () => JSON.stringify({ version: 1, entries: [], owner: "fixture-owner" }),
      setItem: async () => {},
      removeItem: async () => {},
      transcriptMutate: async (_scope, _owner, operations) => {
        if (operations.some((operation) => operation.type === "write" && operation.entry.directory === "/other"))
          await new Promise<void>((resolve) => { releaseWrite = resolve })
      },
      transcriptAcquire: async () => {
        await new Promise<void>((resolve) => { releaseGrant = resolve })
        return { token: "fixture-grant", revalidate: false }
      },
    }, "sidecar.v1")
    await cache.ready
    cache.write("/other", "s", page(0, 1))
    const flushing = cache.flush()
    while (!releaseWrite) await Bun.sleep(0)
    let releaseMetadata!: (response: Response) => void
    let messages = 0
    const app = context(cache, async (request) => {
      if (request.url.endsWith("/s")) return new Promise((resolve) => { releaseMetadata = resolve })
      messages++
      return Response.json([{ info: message(0), parts: [text(0)] }])
    })
    const syncing = app.sync.session.sync("s", { force: true })
    while (!releaseMetadata || !releaseGrant || !messages) await Bun.sleep(0)
    expect(messages).toBe(1)
    expect(app.store.message.s).toBeUndefined()
    releaseMetadata(Response.json(title))
    releaseGrant()
    await syncing
    expect(app.store.message.s?.[0].id).toBe("m0")
    releaseWrite()
    await flushing
    app.dispose()
    cache.dispose()
  })
  test("an unavailable fallback does not turn failed storage into an uncaught error", async () => {
    let failing = true
    const source = disk()
    const cache = createTranscriptCache({
      ...source.storage,
      setItem: async (key, value) => {
        if (failing) throw new Error("storage unavailable")
        await source.storage.setItem(key, value)
      },
    }, "sidecar.v1", undefined, () => { throw new Error("fallback unavailable") })
    await cache.ready
    cache.write("/work", "s", page(0, 1))
    await cache.flush()
    expect(cache.persistenceError()?.operation).toBe("write")
    expect(cache.read("/work", "s")?.session).toHaveLength(1)
    failing = false
    cache.dispose()
    await cache.flush()
  })

  test("missing storage is healthy, but rejected hydration defers writes and preserves existing disk entries", async () => {
    const source = disk()
    const saved = JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...page(0, 2) }] })
    source.data.set("sidecar.v1", saved)
    let unavailable = true
    let writes = 0
    const cache = createTranscriptCache(
      {
        ...source.storage,
        getItem: async (key) => {
          if (unavailable) throw new Error("read unavailable")
          return source.storage.getItem(key)
        },
        setItem: async (key, value) => {
          writes++
          await source.storage.setItem(key, value)
        },
      },
      "sidecar.v1",
    )
    await cache.ready
    expect(cache.enabled).toBe(true)
    expect(cache.persistenceError()?.operation).toBe("read")
    expect(cache.persistenceError()?.error.message).toBe("read unavailable")
    expect(cache.read("/work", "s")).toBeUndefined()
    await cache.flush()
    expect(writes).toBe(0)
    expect(source.data.get("sidecar.v1")).toBe(saved)
    cache.write("/other", "s", page(0, 1))
    await cache.flush()
    expect(writes).toBe(0)
    unavailable = false
    await cache.flush()
    expect(cache.persistenceError()).toBeUndefined()
    expect(cache.read("/work", "s")?.session).toEqual(page(0, 2).session)
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toHaveLength(2)
    cache.dispose()
    await cache.flush()

    const missing = createTranscriptCache(disk().storage, "sidecar.v1")
    await missing.ready
    expect(missing.persistenceError()).toBeUndefined()
    missing.dispose()
    await missing.flush()
  })

  test("basic writes retry only twice, retain disk on failure, and clear status after recovery", async () => {
    const source = disk()
    const saved = JSON.stringify({ version: 1, entries: [{ directory: "/work", sessionID: "s", ...page(0, 1) }] })
    source.data.set("sidecar.v1", saved)
    let failures = 2
    const attempts: number[] = []
    const failedTranscripts: string[][] = []
    const cache = createTranscriptCache(
      {
        ...source.storage,
        setItem: async (key, value) => {
          attempts.push(Date.now())
          if (failures-- > 0) throw new Error("write unavailable")
          await source.storage.setItem(key, value)
        },
      },
      "sidecar.v1",
      undefined,
      (entries) => failedTranscripts.push(entries.flatMap((entry) => entry.session.map((message) => message.id))),
    )
    await cache.ready
    cache.write("/work", "s", page(0, 2))
    const flushing = cache.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cache.persistenceError()?.operation).toBe("write")
    expect(source.data.get("sidecar.v1")).toBe(saved)
    await flushing
    expect(attempts).toHaveLength(2)
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(450)
    expect(cache.persistenceError()?.error.message).toBe("write unavailable")
    expect(failedTranscripts).toEqual([["m0", "m1"]])
    expect(source.data.get("sidecar.v1")).toBe(saved)
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(attempts).toHaveLength(2)
    await cache.flush()
    expect(cache.persistenceError()).toBeUndefined()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].session).toEqual(page(0, 2).session)
    failures = 1
    cache.write("/work", "s", page(0, 3))
    await cache.flush()
    expect(attempts).toHaveLength(5)
    expect(cache.persistenceError()).toBeUndefined()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].session).toEqual(page(0, 3).session)
    expect(failedTranscripts).toHaveLength(1)
    cache.dispose()
    await cache.flush()
  })
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
  test("cold SSE cannot bridge an offline gap; only scrolling fetches the missing range", async () => {
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
    expect(boundaries).toEqual([61])
    expect(cache.read("/work", "s", 100)?.session.map((message) => message.id)).toEqual(page(41, 61).session.map((message) => message.id))
    expect(app.store.message.s?.length).toBe(20)
    await app.sync.session.history.loadMore("s")
    expect(boundaries).toEqual([61, 41])
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
    expect(boundaries).toEqual([70])
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(20, 70).session.map((message) => message.id))
    await app.sync.session.history.loadMore("s")
    await app.sync.session.history.validate("s", transcriptCursor(message(20)))
    expect(app.store.message.s?.map((message) => message.id)).toEqual(page(0, 70).session.map((message) => message.id))
    expect(boundaries).toEqual([70, 20])
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
    expect(messages).toBe(1)
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    expect(metadata).toBe(2)
    app.emit({ type: "session.created", properties: { info: { ...title, title: "Recreated" } } })
    await app.sync.session.sync("s", { force: true })
    expect(app.store.session[0].title).toBe("Recreated")
    expect(metadata).toBe(3)
    expect(messages).toBe(3)
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
    expect(messages).toBe(2)
    expect(app.store.session[0].title).toBe("Newest")
    const fresh = app.sync.session.sync("s", { force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    releases[2](Response.json({ ...title, title: "Newest" }))
    await fresh
    expect(messages).toBe(3)
    expect(app.store.session[0].title).toBe("Newest")
    app.dispose()
    cache.dispose()
  })

  test("reconnect checks the tail and checks historical deletions only on access", async () => {
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
    expect(boundaries).toEqual([60])
    expect(app.store.message.s?.some((message) => message.id === "m50")).toBe(false)
    expect(cache.read("/work", "s", 100)?.session.some((message) => message.id === "m20")).toBe(true)
    await app.sync.session.history.loadMore("s")
    await app.sync.session.history.validate("s", transcriptCursor(message(40)))
    // A missing first message is outside an incomplete response's confirmed interval.
    expect(app.store.message.s?.some((message) => message.id === "m20")).toBe(true)
    expect(boundaries).toEqual([60, 40])
    await app.sync.session.history.validate("s", transcriptCursor(message(21)))
    expect(app.store.message.s?.some((message) => message.id === "m20")).toBe(false)
    expect(boundaries).toEqual([60, 40, 21])
    app.dispose()
    cache.dispose()
  })

  test("a changed timestamp dirties history without sweeping it", async () => {
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
    expect(boundaries).toEqual([60])
    expect(cache.read("/work", "s", 100)?.session.some((message) => message.id === "m20")).toBe(true)
    await app.sync.session.sync("s", { force: true })
    expect(boundaries).toEqual([60, 60])
    await app.sync.session.history.loadMore("s")
    await app.sync.session.history.validate("s", transcriptCursor(message(40)))
    expect(boundaries).toEqual([60, 60, 40])
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
      if (!new URL(request.url).searchParams.has("before")) return new Response("offline", { status: 503 })
      expect(new URL(request.url).searchParams.get("before")).toBe(transcriptCursor(message(20)))
      return Response.json(page(0, 20).session.map((info) => ({ info, parts: [text(info.time.created)] })))
    })
    await app.sync.session.sync("s", { force: true }).catch(() => undefined)
    await app.sync.session.history.loadMore("s")
    expect(requests).toBe(2)
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

  test("a new connection checks unloaded edits lazily without history-wide refresh", async () => {
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
    expect(requests).toBe(1)
    expect(app.store.message.s?.length).toBe(20)
    await app.sync.session.sync("s", { force: true })
    expect(requests).toBe(2)
    await app.sync.session.history.loadMore("s")
    await app.sync.session.history.validate("s", transcriptCursor(message(40)))
    expect(requests).toBe(3)
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
  test("restart publishes cached pages while metadata, tail and lazy range checks are held", async () => {
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
    const releases: Array<(response: Response) => void> = []
    const app = context(restarted, async () => {
      requests++
      return new Promise((resolve) => {
        releases.push(resolve)
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
    await Bun.sleep(0)
    expect(requests).toBe(4)
    expect(app.sync.session.history.more("s")).toBe(false)
    // Finish the pending session request with an error so this test remains an offline restart.
    releases.forEach((finish) => finish(new Response("offline", { status: 503 })))
    await pending.catch(() => undefined)
    app.dispose()
    restarted.dispose()
  })

  test("catch-up is capped at the recent page and missing intervals are fetched on scroll", async () => {
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
    expect(boundaries).toEqual([75])
    expect(app.store.message.s?.map((m) => m.id)).toEqual(page(55, 75).session.map((m) => m.id))
    await app.sync.session.history.loadMore("s")
    expect(app.store.message.s?.map((m) => m.id)).toEqual(page(35, 75).session.map((m) => m.id))
    expect(boundaries).toEqual([75, 55])
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

  test("online refresh excludes optimistic messages even when persistence fails and later recovers", async () => {
    const source = disk()
    let unavailable = true
    const cache = createTranscriptCache(
      {
        ...source.storage,
        setItem: async (key, value) => {
          if (unavailable) throw new Error("write unavailable")
          await source.storage.setItem(key, value)
        },
      },
      "sidecar.v1",
    )
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
    await cache.flush()
    expect(cache.persistenceError()?.operation).toBe("write")
    expect(source.data.get("sidecar.v1")).toBeUndefined()
    unavailable = false
    await cache.flush()
    expect(cache.persistenceError()).toBeUndefined()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].session.map((m: Message) => m.id)).toEqual(["m0", "m2"])
    app.dispose()
    cache.dispose()
    await cache.flush()
  })
})
