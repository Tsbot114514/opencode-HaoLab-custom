import { describe, expect, test } from "bun:test"
import {
  createTranscriptCache,
  transcriptCursor,
  type TranscriptEntry,
  type TranscriptMutation,
} from "../../../app/src/context/global-sync/transcript-cache"
import { createTranscriptAuthority } from "./transcript-cache"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createDirSyncContext } from "../../../app/src/context/directory-sync"
import type { State } from "../../../app/src/context/global-sync/types"

const entry = (directory: string, text = "body"): TranscriptEntry => ({
  directory,
  sessionID: "s",
  complete: true,
  session: [
    {
      id: "m",
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
  ],
  part: [{ id: "m", part: [{ id: "p", sessionID: "s", messageID: "m", type: "text", text }] }],
})
const setup = (budget?: number, limit?: number) => {
  const data = new Map<string, string>()
  const authority = createTranscriptAuthority(
    {
      get: (scope) => data.get(scope),
      set: (scope, value) => {
        data.set(scope, value)
      },
    },
    budget,
    limit,
  )
  const storage = (client: number, paged = false) => ({
    ...(paged ? {
      transcriptOpen: async (scope: string) => authority.open(scope, client),
      transcriptReadPage: async (scope: string, owner: string, directory: string, sessionID: string, before?: string) => authority.readPage(scope, client, owner, directory, sessionID, before),
    } : {}),
    getItem: async (scope: string) => authority.read(scope, client),
    setItem: async () => {
      throw new Error("Renderer must not serialize the whole cache")
    },
    removeItem: async (scope: string) => authority.delete(scope),
    transcriptMutate: async (scope: string, owner: string, operations: TranscriptMutation[]) =>
      authority.mutate(scope, client, owner, operations),
    transcriptAcquire: async (scope: string, owner: string, directory: string, sessionID: string) =>
      authority.acquire(scope, client, owner, directory, sessionID),
  })
  return { data, authority, storage }
}

describe("main transcript authority", () => {
  test("a held same-session touch cannot grant a pre-deletion parallel HTTP body after another wrapper deletes", async () => {
    const source = setup()
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [entry("/work")] }))
    const storage = source.storage(1, true)
    const held = Promise.withResolvers<void>()
    const epochs: (number | undefined)[] = []
    let touching = false
    const a = createTranscriptCache({ ...storage, transcriptAcquire: async (scope, owner, directory, sessionID) => {
      const grant = await storage.transcriptAcquire(scope, owner, directory, sessionID)
      epochs.push(grant?.epoch)
      return grant
    }, transcriptMutate: async (scope, owner, operations) => {
      if (operations.some((operation) => operation.type === "touch")) {
        touching = true
        await held.promise
      }
      await storage.transcriptMutate(scope, owner, operations)
    } }, "sidecar.v1")
    await a.ensureSelected("/work", "s")
    a.read("/work", "s")
    const flushing = a.flush()
    while (!touching) await Bun.sleep(0)
    const b = createTranscriptCache(source.storage(2, true), "sidecar.v1")
    await b.ready
    const title = { id: "s", directory: "/work", projectID: "fixture", slug: "fixture", title: "Fixture", version: "1", time: { created: 0, updated: 1 } }
    let messages = 0
    let metadata = 0
    const client = createOpencodeClient({ baseUrl: "http://race.test", throwOnError: true, fetch: Object.assign(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      if (new URL(request.url).pathname.endsWith("/message")) {
        messages++
        if (messages === 1) return Response.json([{ info: entry("/work").session[0], parts: entry("/work").part[0].part }])
        return Response.json({ message: "deleted" }, { status: 404 })
      }
      metadata++
      return Response.json(title)
    }, { preconnect: fetch.preconnect }) })
    const app = createRoot((dispose) => {
      const [store, setStore] = createStore({ session: [title], message: {}, part: {}, part_text_accum_delta: {}, path: { directory: "/work" }, status: "complete" } as unknown as State)
      const sync = createDirSyncContext(client, "/work", { child: () => [store, setStore], data: { project: [], session_todo: {} }, todo: { set() {} }, transcript: a })
      return { sync, dispose }
    })
    const fetching = app.sync.session.sync("s", { force: true }).catch((error: unknown) => error)
    while (!messages) await Bun.sleep(0)
    expect(messages).toBe(1)
    expect(metadata).toBe(1)
    expect(epochs).toEqual([0])
    b.remove("/work", "s")
    await b.flush()
    held.resolve()
    await flushing
    expect(await fetching).toBeDefined()
    expect(messages).toBe(2)
    expect(epochs).toEqual([0, 1])
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    expect(a.validatedPage("/work", "s", entry("/work"))).toBe(false)
    app.dispose()
    a.dispose()
    b.dispose()
  })

  test("a fresh tail followed by streaming deltas never promotes sparse historical parts over another wrapper's edit", async () => {
    const source = setup()
    const base = entry("/work")
    const session = Array.from({ length: 80 }, (_, index) => ({ ...base.session[0], id: `m${index}`, time: { created: index } }))
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ ...base, session, part: session.map((message) => ({ id: message.id, part: [{ ...base.part[0].part[0], messageID: message.id }] })) }] }))
    const operations: TranscriptMutation[] = []
    const storage = source.storage(1, true)
    const a = createTranscriptCache({ ...storage, transcriptMutate: async (scope, owner, batch) => {
      operations.push(...batch)
      await storage.transcriptMutate(scope, owner, batch)
    } }, "sidecar.v1")
    await a.ensureSelected("/work", "s")
    await a.ensureSelected("/work", "s", transcriptCursor(session[20]))
    const b = createTranscriptCache(source.storage(2, true), "sidecar.v1")
    await b.ensureSelected("/work", "s", transcriptCursor(session[20]))
    b.event("/work", { type: "message.part.updated", properties: { part: { ...base.part[0].part[0], messageID: "m10", text: "B historical edit" } } })
    await b.flush()
    const fresh = await a.beginFetch("/work", "s")
    const tail = a.read("/work", "s", 20, undefined, true)!
    a.write("/work", "s", tail, { fresh, range: {} })
    a.event("/work", { type: "message.part.delta", properties: { sessionID: "s", messageID: "m79", partID: "p", field: "text", delta: "!" } })
    a.event("/work", { type: "message.part.delta", properties: { sessionID: "s", messageID: "m79", partID: "p", field: "text", delta: "?" } })
    await a.flush()
    const saved: TranscriptEntry = JSON.parse(source.data.get("sidecar.v1")!).entries[0]
    expect(saved.part.find((part) => part.id === "m10")?.part[0]).toMatchObject({ text: "B historical edit" })
    expect(saved.part.find((part) => part.id === "m79")?.part[0]).toMatchObject({ text: "body!?" })
    expect(saved.session).toHaveLength(80)
    expect(operations.filter((operation) => operation.type === "write")).toHaveLength(1)
    expect(operations.filter((operation) => operation.type === "event")).toHaveLength(2)
    expect(operations.find((operation) => operation.type === "write" && operation.page)?.page?.session).toHaveLength(20)
    a.dispose()
    b.dispose()
  })

  test("unloaded message removal edits canonical disk history and rejects another wrapper's pre-removal grant", async () => {
    const source = setup()
    const base = entry("/work")
    const session = Array.from({ length: 80 }, (_, index) => ({ ...base.session[0], id: `m${index}`, time: { created: index } }))
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ ...base, session, part: session.map((message) => ({ id: message.id, part: [{ ...base.part[0].part[0], messageID: message.id }] })) }] }))
    const a = createTranscriptCache(source.storage(1, true), "sidecar.v1")
    await a.ensureSelected("/work", "s")
    const b = createTranscriptCache(source.storage(2, true), "sidecar.v1")
    await b.ensureSelected("/work", "s", transcriptCursor(session[60]))
    const history = b.read("/work", "s", 20, undefined, true)!
    const fresh = await b.beginFetch("/work", "s")
    a.event("/work", { type: "message.removed", properties: { sessionID: "s", messageID: "m40" } })
    await a.flush()
    b.write("/work", "s", history, { fresh, before: transcriptCursor(session[60]), range: { before: session[60] } })
    await b.flush()
    const saved: TranscriptEntry = JSON.parse(source.data.get("sidecar.v1")!).entries[0]
    expect(saved.session).toHaveLength(79)
    expect(saved.session.some((message) => message.id === "m40")).toBe(false)
    expect(saved.part.some((part) => part.id === "m40")).toBe(false)
    expect(saved.complete).toBe(true)
    expect(a.read("/work", "s")?.complete).toBe(false)
    const restarted = createTranscriptCache(source.storage(3, true), "sidecar.v1")
    await restarted.ensureSelected("/work", "s", transcriptCursor(session[60]))
    expect(restarted.read("/work", "s")?.session.some((message) => message.id === "m40")).toBe(false)
    a.dispose()
    b.dispose()
    restarted.dispose()
  })
  test("selected pages retain full megabyte message content rather than imposing a body cap", () => {
    const source = setup()
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [entry("/large", "x".repeat(1024 * 1024))] }))
    const opened = source.authority.open("sidecar.v1", 1)
    const page = source.authority.readPage("sidecar.v1", 1, opened.owner, "/large", "s")!
    expect(page.part[0].part[0]).toMatchObject({ text: "x".repeat(1024 * 1024) })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(1024 * 1024)
  })

  test("a same-owner history commit retains the pending tail grant without crossing a later tombstone", () => {
    const source = setup()
    const base = entry("/work")
    const session = Array.from({ length: 80 }, (_, index) => ({ ...base.session[0], id: `m${index}`, time: { created: index } }))
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ ...base, session, part: session.map((message) => ({ id: message.id, part: [{ ...base.part[0].part[0], messageID: message.id }] })) }] }))
    const opened = source.authority.open("sidecar.v1", 1)
    const tail = source.authority.readPage("sidecar.v1", 1, opened.owner, "/work", "s")!
    const history = source.authority.readPage("sidecar.v1", 1, opened.owner, "/work", "s", tail.cursor)!
    const tailGrant = source.authority.acquire("sidecar.v1", 1, opened.owner, "/work", "s")!
    const historyGrant = source.authority.acquire("sidecar.v1", 1, opened.owner, "/work", "s")!
    const page = ({ session, part, cursor, complete }: TranscriptEntry) => ({ session, part, cursor, complete })
    source.authority.mutate("sidecar.v1", 1, opened.owner, [{ type: "write", entry: history, page: page(history), range: { before: tail.session[0] }, fresh: historyGrant.token }])
    const edited = { ...tail, part: tail.part.map((part) => ({ ...part, part: part.part.map((item) => ({ ...item, text: "fresh tail" })) })) }
    source.authority.mutate("sidecar.v1", 1, opened.owner, [{ type: "write", entry: edited, page: page(edited), range: {}, fresh: tailGrant.token }])
    const saved = JSON.parse(source.data.get("sidecar.v1")!).entries[0]
    expect(saved.session).toHaveLength(80)
    expect(saved.part.at(-1).part[0].text).toBe("fresh tail")
    const stale = source.authority.acquire("sidecar.v1", 1, opened.owner, "/work", "s")!
    source.authority.mutate("sidecar.v1", 1, opened.owner, [{ type: "remove", directory: "/work", sessionID: "s" }])
    source.authority.mutate("sidecar.v1", 1, opened.owner, [{ type: "write", entry: edited, page: page(edited), range: {}, fresh: stale.token }])
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
  })
  test("100 persisted sessions with 400 messages open with owner metadata and only the selected 20 bodies", async () => {
    const source = setup()
    const entries = Array.from({ length: 100 }, (_, index) => {
      const base = entry(`/work/${index}`)
      const session = Array.from({ length: 400 }, (_, index) => ({ ...base.session[0], id: `m${index}`, time: { created: index } }))
      return { ...base, session, part: session.map((message) => ({ id: message.id, part: [{ ...base.part[0].part[0], id: `p${message.id}`, messageID: message.id }] })) }
    })
    const raw = JSON.stringify({ version: 1, entries })
    expect(Buffer.byteLength(raw)).toBeLessThan(16 * 1024 * 1024)
    source.data.set("sidecar.v1", raw)
    const opened = source.authority.open("sidecar.v1", 1)
    expect(Object.keys(opened)).toEqual(["owner"])
    expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThan(100)
    const page = source.authority.readPage("sidecar.v1", 1, opened.owner, "/work/50", "s")!
    expect(page.session).toHaveLength(20)
    expect(page.part).toHaveLength(20)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10000)
    expect(source.authority.readPage("sidecar.v1", 2, opened.owner, "/work/50", "s")).toBeUndefined()
    const cache = createTranscriptCache(source.storage(3, true), "sidecar.v1")
    await cache.ready
    expect(cache.directories()).toEqual([])
    await cache.ensureSelected("/work/50", "s")
    expect(cache.read("/work/50", "s", 1000)?.session).toHaveLength(20)
    await cache.ensureSelected("/work/50", "s", page.cursor)
    expect(cache.read("/work/50", "s", 1000)?.session).toHaveLength(40)
    const fresh = await cache.beginFetch("/work/50", "s")
    cache.write("/work/50", "s", { ...page, session: page.session.slice(1), part: page.part.slice(1), cursor: transcriptCursor(page.session[1]) }, { fresh, range: {} })
    await cache.flush()
    const saved: TranscriptEntry[] = JSON.parse(source.data.get("sidecar.v1")!).entries
    expect(saved.find((item) => item.directory === "/work/50")?.session).toHaveLength(400)
    // The omitted first message lies before the authoritative range, so remains provisional.
    expect(saved.find((item) => item.directory === "/work/49")?.session).toHaveLength(400)
    cache.dispose()
  })

  test("page-scoped live updates preserve unseen history and stale owners cannot revive tombstones", async () => {
    const source = setup()
    const base = entry("/work")
    const session = Array.from({ length: 80 }, (_, index) => ({ ...base.session[0], id: `m${index}`, time: { created: index } }))
    source.data.set("sidecar.v1", JSON.stringify({ version: 1, entries: [{ ...base, session, part: session.map((message) => ({ id: message.id, part: [{ ...base.part[0].part[0], messageID: message.id }] })) }] }))
    const cache = createTranscriptCache(source.storage(1, true), "sidecar.v1")
    await cache.ensureSelected("/work", "s")
    await cache.ensureSelected("/work", "s", transcriptCursor(session[20]))
    expect(cache.available("/work", "s", transcriptCursor(session[60]))).toBe(false)
    cache.event("/work", { type: "message.part.delta", properties: { sessionID: "s", messageID: "m79", partID: "p", field: "text", delta: "!" } })
    await cache.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].session).toHaveLength(80)
    const other = createTranscriptCache(source.storage(2, true), "sidecar.v1")
    await other.ready
    other.remove("/work", "s")
    await other.flush()
    cache.event("/work", { type: "message.part.delta", properties: { sessionID: "s", messageID: "m79", partID: "p", field: "text", delta: "stale" } })
    await cache.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    cache.dispose()
    other.dispose()
  })
  for (const deleted of [false, true])
    test(`a queued fresh grant survives prepend coalescing${deleted ? " but not deletion during history fetch" : ""}`, async () => {
      const source = setup()
      const a = createTranscriptCache(source.storage(1), "sidecar.v1")
      await a.ready
      a.write("/a", "s", entry("/a"))
      await a.flush()
      const b = createTranscriptCache(source.storage(2), "sidecar.v1")
      await b.ready
      b.write("/a", "s", entry("/a", "B newer"))
      await b.flush()
      const fresh = await a.beginFetch("/a", "s")
      const cursor = transcriptCursor(entry("/a").session[0])
      a.write(
        "/a",
        "s",
        { ...entry("/a", "A refreshed"), cursor, complete: false },
        { fresh, validated: true, reset: true },
      )
      const response = Promise.withResolvers<Response>()
      const client = createOpencodeClient({
        baseUrl: "http://history.test",
        fetch: Object.assign(async () => response.promise, { preconnect: fetch.preconnect }),
      })
      const history = client.session.messages({ sessionID: "s", limit: 20, before: cursor })
      if (deleted) {
        b.remove("/a", "s")
        await b.flush()
      }
      response.resolve(
        Response.json([
          {
            info: { ...entry("/a").session[0], id: "m0", time: { created: 0 } },
            parts: [{ id: "p0", sessionID: "s", messageID: "m0", type: "text", text: "older history" }],
          },
        ]),
      )
      const fetched = await history
      a.write(
        "/a",
        "s",
        {
          session: fetched.data!.map((message) => message.info),
          part: fetched.data!.map((message) => ({ id: message.info.id, part: message.parts })),
          complete: true,
        },
        { before: cursor },
      )
      await a.flush()
      const entries: TranscriptEntry[] = JSON.parse(source.data.get("sidecar.v1")!).entries
      if (deleted) expect(entries).toEqual([])
      if (!deleted) {
        expect(entries[0].session.map((message) => message.id)).toEqual(["m0", "m"])
        expect(entries[0].part.find((part) => part.id === "m")?.part[0]).toMatchObject({ text: "A refreshed" })
        expect(entries[0].part.find((part) => part.id === "m0")?.part[0]).toMatchObject({ text: "older history" })
        expect(entries[0].complete).toBe(true)
      }
      a.dispose()
      b.dispose()
    })

  for (const boundary of ["remove", "clearDirectory", "reset", "unrelated"] as const)
    test(`prepend grants do not cross ${boundary}`, async () => {
      const source = setup()
      const storage = source.storage(1)
      const writes: Extract<TranscriptMutation, { type: "write" }>[] = []
      const a = createTranscriptCache(
        {
          ...storage,
          transcriptMutate: async (scope, owner, operations) => {
            writes.push(
              ...operations.filter(
                (operation): operation is Extract<TranscriptMutation, { type: "write" }> => operation.type === "write",
              ),
            )
            await storage.transcriptMutate(scope, owner, operations)
          },
        },
        "sidecar.v1",
      )
      await a.ready
      a.write("/a", "s", entry("/a"))
      await a.flush()
      const b = createTranscriptCache(source.storage(2), "sidecar.v1")
      await b.ready
      b.write("/a", "s", entry("/a", "B newer"))
      await b.flush()
      const fresh = await a.beginFetch("/a", "s")
      a.write("/a", "s", entry("/a", "granted"), { fresh, validated: true })
      if (boundary === "remove") a.remove("/a", "s")
      if (boundary === "clearDirectory") a.clearDirectory("/a")
      a.write(
        boundary === "unrelated" ? "/other" : "/a",
        "s",
        entry(boundary === "unrelated" ? "/other" : "/a", "ungranted"),
        { before: "cursor", reset: boundary === "reset" },
      )
      await a.flush()
      const entries: TranscriptEntry[] = JSON.parse(source.data.get("sidecar.v1")!).entries
      const ungranted = writes.findLast(
        (operation) =>
          operation.entry.part[0].part[0].type === "text" && operation.entry.part[0].part[0].text === "ungranted",
      )
      expect(ungranted).toBeDefined()
      expect(ungranted?.fresh).toBeUndefined()
      if (boundary === "reset") expect(entries[0].part[0].part[0]).toMatchObject({ text: "B newer" })
      if (boundary === "unrelated") {
        expect(entries.find((entry) => entry.directory === "/a")?.part[0].part[0]).toMatchObject({ text: "granted" })
        expect(entries.find((entry) => entry.directory === "/other")?.part[0].part[0]).toMatchObject({
          text: "ungranted",
        })
      }
      a.dispose()
      b.dispose()
    })
  test("fresh reads rebase only their session after another wrapper updates or clears it", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    b.write("/a", "s", entry("/a", "B"))
    await b.flush()
    const fresh = await a.beginFetch("/a", "s")
    const client = createOpencodeClient({
      baseUrl: "http://fresh.test",
      fetch: Object.assign(
        async () => Response.json([{ info: entry("/a").session[0], parts: entry("/a", "A fetched").part[0].part }]),
        { preconnect: fetch.preconnect },
      ),
    })
    const fetched = await client.session.messages({ sessionID: "s", limit: 20 })
    a.write(
      "/a",
      "s",
      {
        session: fetched.data!.map((message) => message.info),
        part: fetched.data!.map((message) => ({ id: message.info.id, part: message.parts })),
        complete: true,
      },
      { fresh, validated: true },
    )
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].part[0].part[0].text).toBe("A fetched")
    b.clearDirectory("/a")
    await b.flush()
    const recreated = await a.beginFetch("/a", "s")
    a.write("/a", "s", entry("/a", "Recreated"), { fresh: recreated, validated: true })
    await a.flush()
    a.event("/a", {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: " live" },
    })
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].part[0].part[0].text).toBe("Recreated live")
    a.dispose()
    b.dispose()
  })

  test("rebasing a fresh session cannot revive a stale sibling after a directory clear", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    const sibling = {
      ...entry("/a"),
      sessionID: "other",
      session: entry("/a").session.map((message) => ({ ...message, sessionID: "other" })),
      part: entry("/a").part.map((part) => ({
        ...part,
        part: part.part.map((item) => ({ ...item, sessionID: "other" })),
      })),
    }
    a.write("/a", "s", entry("/a"))
    a.write("/a", "other", sibling)
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    b.clearDirectory("/a")
    await b.flush()
    const fresh = await a.beginFetch("/a", "s")
    a.write("/a", "s", entry("/a", "fresh"), { fresh, validated: true })
    a.write("/a", "other", sibling)
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries.map((entry: TranscriptEntry) => entry.sessionID)).toEqual(
      ["s"],
    )
    a.dispose()
    b.dispose()
  })

  test("a pre-request grant cannot resurrect a session deleted while the fetch was pending", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    const fresh = await a.beginFetch("/a", "s")
    b.remove("/a", "s")
    await b.flush()
    a.write("/a", "s", entry("/a", "stale response"), { fresh, validated: true })
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    a.dispose()
    b.dispose()
  })

  test("a newly fetched page restores an LRU-evicted session without admitting its old snapshot", async () => {
    const source = setup(undefined, 1)
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    b.write("/b", "s", entry("/b"))
    await b.flush()
    a.write("/a", "s", entry("/a", "old"))
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].directory).toBe("/b")
    const fresh = await a.beginFetch("/a", "s")
    a.write("/a", "s", entry("/a", "fetched"), { fresh, validated: true })
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries[0].part[0].part[0].text).toBe("fetched")
    a.dispose()
    b.dispose()
  })

  test("two 9 MiB writes cannot swallow removals or exceed renderer and disk retention", async () => {
    const source = setup()
    const storage = source.storage(1)
    const batches: number[] = []
    const cache = createTranscriptCache(
      {
        ...storage,
        transcriptMutate: async (scope, owner, operations) => {
          batches.push(Buffer.byteLength(JSON.stringify(operations)))
          await storage.transcriptMutate(scope, owner, operations)
        },
      },
      "sidecar.v1",
    )
    await cache.ready
    cache.write("/deleted", "s", entry("/deleted"))
    await cache.flush()
    cache.write("/a", "s", entry("/a", "x".repeat(9 * 1024 * 1024)))
    cache.write("/b", "s", entry("/b", "x".repeat(9 * 1024 * 1024)))
    cache.remove("/deleted", "s")
    await cache.flush()
    const raw = source.data.get("sidecar.v1")!
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(batches.every((size) => size <= 16 * 1024 * 1024)).toBe(true)
    expect(JSON.parse(raw).entries.some((entry: TranscriptEntry) => entry.directory === "/deleted")).toBe(false)
    expect(cache.directories()).toEqual(["/b"])
    cache.write("/oversized", "s", entry("/oversized", "x".repeat(17 * 1024 * 1024)))
    cache.clearDirectory("/b")
    await cache.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    for (let i = 0; i < 110; i++) cache.write(`/s${i}`, "s", entry(`/s${i}`))
    expect(cache.directories().length).toBeLessThanOrEqual(100)
    await cache.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries.length).toBeLessThanOrEqual(100)
    cache.dispose()
  })
  test("independent renderer wrappers merge sessions, not whole snapshots", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await Promise.all([a.ready, b.ready])
    a.write("/a", "s", entry("/a"))
    b.write("/b", "s", entry("/b"))
    await Promise.all([a.flush(), b.flush()])
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries.map((item: TranscriptEntry) => item.directory)).toEqual([
      "/a",
      "/b",
    ])
    a.dispose()
    b.dispose()
  })

  test("another window cannot resurrect a deleted session through reads, updates, or dispose", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    b.remove("/a", "s")
    await b.flush()
    a.read("/a", "s")
    a.event("/a", {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: " stale" },
    })
    a.dispose()
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    b.dispose()
  })

  test("directory clears reject stale writes even for entries missing at clear time", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await Promise.all([a.ready, b.ready])
    a.write("/a", "s", entry("/a"))
    b.clearDirectory("/a")
    await b.flush()
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    a.dispose()
    b.dispose()
  })

  test("stale updates cannot overwrite newer parts; independent sessions still update", async () => {
    const source = setup()
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    b.write("/a", "s", entry("/a", "new"))
    await b.flush()
    a.write("/a", "s", entry("/a", "stale"))
    a.write("/b", "s", entry("/b"))
    await a.flush()
    const entries = JSON.parse(source.data.get("sidecar.v1")!).entries
    expect(entries[0].part[0].part[0].text).toBe("new")
    expect(entries.length).toBe(2)
    a.dispose()
    b.dispose()
  })

  test("global LRU includes live updates and tombstones evictions", async () => {
    const source = setup(undefined, 2)
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    a.write("/b", "s", entry("/b"))
    await a.flush()
    const b = createTranscriptCache(source.storage(2), "sidecar.v1")
    await b.ready
    a.event("/a", {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: " update" },
    })
    await a.flush()
    b.write("/c", "s", entry("/c"))
    await b.flush()
    b.write("/b", "s", entry("/b", "stale"))
    await b.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries.map((item: TranscriptEntry) => item.directory)).toEqual([
      "/a",
      "/c",
    ])
    a.dispose()
    b.dispose()
  })

  test("coalesced writes retain read LRU order and only the final streamed value", async () => {
    const source = setup(undefined, 2)
    const a = createTranscriptCache(source.storage(1), "sidecar.v1")
    await a.ready
    a.write("/a", "s", entry("/a"))
    a.write("/b", "s", entry("/b"))
    for (let index = 0; index < 1100; index++)
      a.event("/a", {
        type: "message.part.delta",
        properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "x" },
      })
    a.read("/b", "s")
    a.write("/c", "s", entry("/c"))
    await a.flush()
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries.map((item: TranscriptEntry) => item.directory)).toEqual([
      "/b",
      "/c",
    ])
    a.dispose()
  })

  test("validates client, scope, shape and budget; external pairing cleanup invalidates owners", () => {
    const source = setup(600)
    const owner = JSON.parse(source.authority.read("sidecar.v1", 1)).owner
    source.authority.mutate("sidecar.v1", 2, owner, [{ type: "write", entry: entry("/a") }])
    source.authority.mutate("tunnel.v1.other", 1, owner, [{ type: "write", entry: entry("/a") }])
    source.authority.mutate("sidecar.v1", 1, owner, [{ type: "write", entry: { ...entry("/a"), sessionID: "wrong" } }])
    source.authority.mutate("sidecar.v1", 1, owner, [
      { type: "remove", directory: "/a", sessionID: "s", password: "not persisted" },
    ])
    source.authority.mutate("sidecar.v1", 1, owner, [
      { type: "write", entry: { ...entry("/a"), password: "not persisted" } },
    ])
    source.authority.mutate("sidecar.v1", 1, owner, [
      { type: "write", entry: entry("/a", "x".repeat(16 * 1024 * 1024)) },
    ])
    expect(source.data.size).toBe(0)
    source.authority.mutate("sidecar.v1", 1, owner, [{ type: "write", entry: entry("/a", "x".repeat(1000)) }])
    expect(Buffer.byteLength(source.data.get("sidecar.v1")!)).toBeLessThanOrEqual(600)
    expect(JSON.parse(source.data.get("sidecar.v1")!).entries).toEqual([])
    source.data.delete("sidecar.v1")
    source.authority.mutate("sidecar.v1", 1, owner, [{ type: "write", entry: entry("/a") }])
    expect(source.data.has("sidecar.v1")).toBe(false)
  })
})
