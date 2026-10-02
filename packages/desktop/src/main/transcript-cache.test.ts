import { describe, expect, test } from "bun:test"
import {
  createTranscriptCache,
  transcriptCursor,
  type TranscriptEntry,
  type TranscriptMutation,
} from "../../../app/src/context/global-sync/transcript-cache"
import { createTranscriptAuthority } from "./transcript-cache"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

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
  const storage = (client: number) => ({
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
