import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import http from "node:http"
import { gunzipSync } from "node:zlib"
import { eq, sql } from "drizzle-orm"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionTranscriptFeed } from "../../src/session/transcript-feed"
import { MessageTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { createTranscriptCache } from "../../../app/src/context/global-sync/transcript-cache"
import type { TranscriptEntry } from "../../../app/src/context/global-sync/transcript-cache"
import { decodeTranscriptChanges, decodeTranscriptSnapshot } from "../../../app/src/utils/transcript-feed"
import { createMobileReadTransport } from "../../../app/src/utils/mobile-request"

const it = testEffect(Layer.empty)
const authorization = `Basic ${Buffer.from("transfer:isolated-test-only").toString("base64")}`
const TranscriptEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message.updated"), properties: MessageV2.Event.Updated.properties }),
  Schema.Struct({ type: Schema.Literal("message.part.updated"), properties: MessageV2.Event.PartUpdated.properties }),
  Schema.Struct({ type: Schema.Literal("message.part.delta"), properties: MessageV2.Event.PartDelta.properties }),
])

// A is the production route tree on an ephemeral loopback socket. B uses the
// generated SDK, real mobile body reader, decoder, and shared persisted cache.
const fixture = Effect.fn("TranscriptTransfer.fixture")(function* () {
  expect(process.env.OPENCODE_DB).toBe(":memory:")
  const directory = (yield* TestInstance).directory
  yield* Effect.addFinalizer(() => Effect.promise(resetDatabase))
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    Layer.mergeAll(
      Bus.layer,
      Session.defaultLayer,
      HttpRouter.serve(HttpApiApp.routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(http.createServer, { host: "127.0.0.1", port: 0 })),
      ),
    ).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_USERNAME: "transfer",
            OPENCODE_SERVER_PASSWORD: "isolated-test-only",
          }),
        ),
      ),
    ),
    memoMap,
    yield* Scope.Scope,
  ).pipe(Effect.provide(HttpApiApp.context))
  const service = Context.get(context, Session.Service)
  const baseUrl = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)
  const requests: {
    path: string
    cursor: string | null
    status: number
    wire: number
    decoded: number
    encoding?: string
    elapsed: number
  }[] = []
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const start = performance.now()
      // A deliberate RTT, not a scheduler-readiness delay.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return new Promise<Response>((resolve, reject) => {
        const req = http.request(
          url,
          { method: request.method, headers: Object.fromEntries(request.headers) },
          (response) => {
            const chunks: Buffer[] = []
            response.on("data", (chunk: Buffer) => chunks.push(chunk))
            response.on("error", reject)
            response.on("end", () => {
              const wire = Buffer.concat(chunks)
              const encoding = response.headers["content-encoding"]
              const body = encoding === "gzip" ? gunzipSync(wire) : wire
              requests.push({
                path: url.pathname,
                cursor: url.searchParams.get("cursor"),
                status: response.statusCode ?? 0,
                wire: wire.byteLength,
                decoded: body.byteLength,
                encoding: typeof encoding === "string" ? encoding : undefined,
                elapsed: performance.now() - start,
              })
              const headers = new Headers()
              for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
              }
              resolve(new Response(new Uint8Array(body), { status: response.statusCode, headers }))
            })
          },
        )
        req.on("error", reject)
        req.end()
      })
    },
    { preconnect: fetch.preconnect },
  )
  const transport = createMobileReadTransport(fetcher)
  const client = createOpencodeClient({
    baseUrl,
    directory,
    fetch: transport.fetch,
    headers: { authorization, "accept-encoding": "gzip" },
    throwOnError: true,
  })
  const disk = new Map<string, string>()
  const storage = {
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    },
  }
  const caches: ReturnType<typeof createTranscriptCache>[] = []
  const cache = () => {
    const value = createTranscriptCache(storage, "sidecar.v1")
    caches.push(value)
    return value
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => caches.forEach((value) => value.dispose())))
  const session = yield* service.create({ title: "Actual A to B transfer" })
  const messages = yield* Effect.forEach(
    Array.from({ length: 25 }, (_, index) => index),
    (index) =>
      service.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "build",
        time: { created: 100 + index },
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      }),
  )
  const info = yield* service.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: messages[24]!.id,
    time: { created: 200 },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const part = yield* service.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: info.id,
    type: "text",
    text: "a",
  })
  const tool = yield* service.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: info.id,
    type: "tool",
    tool: "bash",
    callID: "isolated-call",
    state: {
      status: "completed",
      input: {},
      output: "unchanged tool output\n".repeat(5000),
      title: "unchanged",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  })
  const snapshot = async (b: ReturnType<typeof cache>) => {
    await b.ready
    const token = b.beginFeed(directory, session.id)
    const result = await client.session.transcriptSnapshot({ sessionID: session.id, limit: "20" })
    const decoded = decodeTranscriptSnapshot(result.data, directory, session.id)
    expect(b.applyFeed(directory, session.id, token, decoded)?.checkpointed).toBe(true)
    return { ...decoded, dto: result.data }
  }
  const changes = async (b: ReturnType<typeof cache>, limit = "100") => {
    await b.ready
    const token = b.beginFeed(directory, session.id)
    if (!token.cursor) throw new Error("Missing persisted cursor")
    const result = await client.session.transcriptChanges({ sessionID: session.id, cursor: token.cursor, limit })
    const decoded = decodeTranscriptChanges(result.data, directory, session.id)
    expect(b.applyFeed(directory, session.id, token, decoded)?.checkpointed).toBe(true)
    return decoded
  }
  return {
    directory,
    service,
    session,
    messages,
    info,
    part,
    tool,
    baseUrl,
    client,
    requests,
    disk,
    cache,
    snapshot,
    changes,
    bus: Context.get(context, Bus.Service),
  }
})

const browser = Effect.fn("TranscriptTransfer.browser")(function* (input: {
  baseUrl: string
  directory: string
  sessionID: string
  event?: { type: "message.part.delta"; properties: typeof MessageV2.Event.PartDelta.properties.Type }
  text?: string
  replay?: { snapshot: unknown; events: (typeof TranscriptEvent.Type)[]; text: string; partID: string }
  ui?: { entry: TranscriptEntry; partID: string; text: string }
}) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          "--preload",
          "./happydom.ts",
          "--preload",
          "./browser-test.ts",
          "./e2e/mobile-transcript-transfer.fixture.ts",
        ],
        {
          cwd: new URL("../../../app", import.meta.url).pathname,
          env: { ...process.env, OPENCODE_TRANSFER_FIXTURE: JSON.stringify({ ...input, authorization }) },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    ),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode === null) child.kill()
      }),
  )
  const result = yield* Effect.promise(async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  })
  expect(result.code, result.stdout + result.stderr).toBe(0)
  console.info(result.stdout.trim())
})

describe("actual backend to shared B transcript transfer", () => {
  it.instance(
    "renders the actual mobile session page's inline feed error and retries changes without reload or toast",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        yield* Effect.forEach(a.messages.slice(0, -1), (info) =>
          a.service.removeMessage({ sessionID: a.session.id, messageID: info.id }),
        )
        yield* a.service.updatePart({
          id: PartID.ascending(),
          sessionID: a.session.id,
          messageID: a.info.parentID,
          type: "text",
          text: "Visible retry question",
        })
        const b = a.cache()
        yield* Effect.promise(() => a.snapshot(b))
        const entry = b.feedEntry(a.directory, a.session.id)
        if (!entry) return yield* Effect.die("Missing actual cached B entry")
        yield* a.service.updatePart({ ...a.part, text: "retry fresh content" })
        yield* browser({
          baseUrl: a.baseUrl,
          directory: a.directory,
          sessionID: a.session.id,
          ui: { entry, partID: a.part.id, text: "retry fresh content" },
        })
      }),
    { config: { formatter: false, lsp: false } },
    40_000,
  )

  it.instance(
    "keeps owner authority and current full part replacements across partial mixed-update pages",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const b = a.cache()
        const start = yield* Effect.promise(() => a.snapshot(b))
        yield* a.service.updatePart({ ...a.part, text: "abc" })
        yield* a.service.updateMessage({ ...a.info, agent: "owner-after-part" })
        const sibling = yield* a.service.updatePart({ ...a.part, id: PartID.ascending(), text: "mixed sibling" })
        const first = yield* Effect.promise(() => a.changes(b, "1"))
        expect(first.more).toBe(true)
        expect(first.changes).toHaveLength(1)
        expect(first.changes[0]).toMatchObject({
          type: "part.upsert",
          info: { id: a.info.id, agent: "owner-after-part" },
          part: { id: a.part.id, text: "abc" },
        })
        expect(first.cursor).not.toBe(first.highwater)
        expect(first.cursor).not.toBe(start.cursor)
        yield* Effect.promise(() => b.flush())
        b.dispose()
        const restarted = a.cache()
        const owner = yield* Effect.promise(() => a.changes(restarted, "1"))
        expect(a.requests.at(-1)?.cursor).toBe(first.cursor)
        expect(owner.more).toBe(true)
        expect(owner.changes[0]).toMatchObject({ type: "message.upsert", info: { agent: "owner-after-part" } })
        expect(first.changes[0]?.seq).toBe(owner.changes[0]?.seq)
        const tail = yield* Effect.promise(() => a.changes(restarted, "1"))
        expect(tail.more).toBe(false)
        expect(tail.changes[0]).toMatchObject({ type: "part.upsert", part: { id: sibling.id, text: "mixed sibling" } })
        expect(
          restarted.feedEntry(a.directory, a.session.id)?.session.find((info) => info.id === a.info.id)?.agent,
        ).toBe("owner-after-part")
        expect(
          restarted
            .feedEntry(a.directory, a.session.id)
            ?.part.flatMap((item) => item.part)
            .find((part) => part.id === a.part.id),
        ).toMatchObject({ text: "abc" })
        expect(a.requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )
  it.instance(
    "commits full ab then additive c in FIFO order and reconciles/persists abc across actual B restart",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const b = a.cache()
        const start = yield* Effect.promise(() => a.snapshot(b))
        const events: (typeof TranscriptEvent.Type)[] = []
        const unsubscribe = yield* a.bus.subscribeAllCallback((event: unknown) => {
          const decoded = Schema.decodeUnknownOption(TranscriptEvent)(event)
          if (Option.isSome(decoded)) events.push(decoded.value)
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        const context = yield* Effect.context()
        Database.transaction(() => {
          Effect.runSync(a.service.updatePart({ ...a.part, text: "ab" }).pipe(Effect.provide(context)))
          Effect.runSync(
            a.service
              .updatePartDelta({
                sessionID: a.session.id,
                messageID: a.info.id,
                partID: a.part.id,
                field: "text",
                delta: "c",
              })
              .pipe(Effect.provide(context)),
          )
          expect(events).toEqual([])
          expect(
            b
              .feedEntry(a.directory, a.session.id)
              ?.part.flatMap((item) => item.part)
              .find((part) => part.id === a.part.id),
          ).toMatchObject({ text: "a" })
        })
        yield* pollWithTimeout(
          Effect.sync(() => (events.length === 2 ? true : undefined)),
          "Missing committed FIFO events",
        )
        expect(events.map((event) => event.type)).toEqual(["message.part.updated", "message.part.delta"])
        const full = events[0]
        const delta = events[1]
        if (full?.type !== "message.part.updated" || delta?.type !== "message.part.delta")
          return yield* Effect.die("Wrong committed event order")
        expect(full.properties.part).toMatchObject({ text: "ab" })
        expect(delta.properties).toMatchObject({ field: "text", delta: "c" })
        expect(full.properties.transcript?.generation).toBe(start.generation)
        expect(delta.properties.transcript?.generation).toBe(start.generation)
        expect(delta.properties.transcript?.seq).toBeGreaterThan(full.properties.transcript!.seq)
        for (const event of events) expect(b.event(a.directory, event)).not.toBe(false)
        expect(
          b
            .feedEntry(a.directory, a.session.id)
            ?.part.flatMap((item) => item.part)
            .find((part) => part.id === a.part.id),
        ).toMatchObject({ text: "abc" })
        // Seen additive sequence is not a certificate for a full replacement group.
        expect(
          b.feedEntry(a.directory, a.session.id)?.feed?.versions.find((version) => version.partID === a.part.id)?.full,
        ).toBe(full.properties.transcript!.seq)
        expect(
          b.feedEntry(a.directory, a.session.id)?.feed?.versions.find((version) => version.partID === a.part.id)?.seq,
        ).toBe(delta.properties.transcript!.seq)
        const changed = yield* Effect.promise(() => a.changes(b))
        expect(changed.changes).toHaveLength(1)
        expect(changed.changes[0]).toMatchObject({
          type: "part.upsert",
          part: { id: a.part.id, text: "abc" },
          seq: delta.properties.transcript!.seq,
        })
        const certified = b
          .feedEntry(a.directory, a.session.id)
          ?.feed?.versions.find((version) => version.partID === a.part.id)
        expect(certified?.full ?? certified?.seq).toBe(delta.properties.transcript!.seq)
        expect(b.event(a.directory, delta)).toBe(false)
        yield* Effect.promise(() => b.flush())
        b.dispose()
        const restarted = a.cache()
        yield* Effect.promise(() => restarted.ready)
        expect(
          restarted
            .feedEntry(a.directory, a.session.id)
            ?.part.flatMap((item) => item.part)
            .find((part) => part.id === a.part.id),
        ).toMatchObject({ text: "abc" })
        expect((yield* Effect.promise(() => a.changes(restarted))).changes).toEqual([])
        yield* browser({
          baseUrl: a.baseUrl,
          directory: a.directory,
          sessionID: a.session.id,
          replay: { snapshot: start.dto, events, text: "abc", partID: a.part.id },
        })
        console.info(
          "committed FIFO transfer bytes",
          JSON.stringify(a.requests.map((request) => ({ ...request, cursor: !!request.cursor }))),
        )
      }),
    { config: { formatter: false, lsp: false } },
    40_000,
  )

  it.instance(
    "rolls back an outer delta without publishing, appending in B, or advancing a feed certificate",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const b = a.cache()
        const start = yield* Effect.promise(() => a.snapshot(b))
        const original = b.feedEntry(a.directory, a.session.id)
        const events: (typeof TranscriptEvent.Type)[] = []
        const unsubscribe = yield* a.bus.subscribeAllCallback((event: unknown) => {
          const decoded = Schema.decodeUnknownOption(TranscriptEvent)(event)
          if (Option.isSome(decoded)) events.push(decoded.value)
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        const context = yield* Effect.context()
        expect(() =>
          Database.transaction(() => {
            Effect.runSync(
              a.service
                .updatePartDelta({
                  sessionID: a.session.id,
                  messageID: a.info.id,
                  partID: a.part.id,
                  field: "text",
                  delta: "b",
                })
                .pipe(Effect.provide(context)),
            )
            expect(events).toEqual([])
            throw new Error("outer delta rollback")
          }),
        ).toThrow("outer delta rollback")
        const unchanged = yield* Effect.promise(() => a.changes(b))
        expect(events).toEqual([])
        expect(unchanged.changes).toEqual([])
        expect(unchanged.cursor).toBe(start.cursor)
        expect(b.feedEntry(a.directory, a.session.id)?.feed?.versions).toEqual(original?.feed?.versions)
        expect(b.feedEntry(a.directory, a.session.id)?.part).toEqual(original?.part)
        yield* Effect.promise(() => b.flush())
        b.dispose()
        const restarted = a.cache()
        yield* Effect.promise(() => restarted.ready)
        expect(restarted.feedEntry(a.directory, a.session.id)?.syncCursor).toBe(start.cursor)
        expect(restarted.feedEntry(a.directory, a.session.id)?.part).toEqual(original?.part)
        yield* browser({
          baseUrl: a.baseUrl,
          directory: a.directory,
          sessionID: a.session.id,
          replay: { snapshot: start.dto, events, text: "a", partID: a.part.id },
        })
      }),
    { config: { formatter: false, lsp: false } },
    40_000,
  )
  it.instance(
    "runs actual B directory-sync with isolated browser globals against the scoped A socket",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        yield* browser({ baseUrl: a.baseUrl, directory: a.directory, sessionID: a.session.id })
      }),
    { config: { formatter: false, lsp: false } },
    40_000,
  )

  it.instance(
    "cold snapshots once, persists a real cursor, and transfers only an offline incomplete-assistant edit",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const first = a.cache()
        const initial = yield* Effect.promise(() => a.snapshot(first))
        expect(initial.page.session).toHaveLength(20)
        expect(initial.next).not.toBeNull()
        expect(initial.session.title).toBe("Actual A to B transfer")
        expect(initial.generation).toHaveLength(65)
        expect(a.requests).toHaveLength(1)
        expect(a.requests[0]).toMatchObject({ encoding: "gzip", status: 200 })
        expect(a.requests[0]!.decoded).toBeGreaterThan(100_000)
        expect(a.requests[0]!.wire).toBeLessThan(a.requests[0]!.decoded / 10)
        // Baseline is the actual current latest-20 page, not a legacy fallback request.
        const baseline = yield* MessageV2.page({ sessionID: a.session.id, limit: 20 })
        expect(baseline.items.map((item) => String(item.info.id))).toEqual(initial.page.session.map((info) => info.id))
        const baselineBytes = Buffer.byteLength(JSON.stringify(baseline.items))
        yield* Effect.promise(() => first.flush())
        expect(JSON.parse(a.disk.get("sidecar.v1")!).entries[0].syncCursor).toBe(initial.cursor)
        first.dispose()
        const cold = a.cache()
        const empty = yield* Effect.promise(() => a.changes(cold))
        expect(empty.changes).toEqual([])
        expect(empty.cursor).toBe(initial.cursor)
        expect(a.requests[1]).toMatchObject({ cursor: initial.cursor, status: 200 })
        expect(a.requests[1]!.decoded).toBeLessThan(1024)
        expect(a.requests[1]!.elapsed).toBeGreaterThanOrEqual(295)
        yield* Effect.promise(() => cold.flush())
        cold.dispose()
        yield* a.service.updatePartDelta({
          sessionID: a.session.id,
          messageID: a.info.id,
          partID: a.part.id,
          field: "text",
          delta: "b",
        })
        const edited = a.cache()
        const changed = yield* Effect.promise(() => a.changes(edited))
        expect(changed.changes).toHaveLength(1)
        expect(changed.changes[0]).toMatchObject({
          type: "part.upsert",
          info: { id: a.info.id, role: "assistant" },
          part: { id: a.part.id, text: "ab" },
        })
        expect(JSON.stringify(changed)).not.toContain(a.tool.id)
        expect(a.requests[2]!.decoded).toBeLessThan(2500)
        expect(a.requests[2]!.encoding).toBe("gzip")
        expect(a.requests[2]!.wire).toBeLessThan(a.requests[2]!.decoded)
        expect(edited.feedEntry(a.directory, a.session.id)?.part.find((group) => group.id === a.info.id)?.part).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: a.tool.id, state: a.tool.state }),
            expect.objectContaining({ id: a.part.id, text: "ab" }),
          ]),
        )
        expect(a.requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
        console.info(
          "actual A-to-B bytes",
          JSON.stringify({
            baselineLatest20: baselineBytes,
            requests: a.requests.map((request) => ({ ...request, cursor: !!request.cursor })),
          }),
        )
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "resumes paged checkpoints after disposal, reconciles older cached edits and removals, and rolls back SQL",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const b = a.cache()
        const start = yield* Effect.promise(() => a.snapshot(b))
        // This is pre-existing B history, loaded from actual A before going offline.
        // Catch-up below must not issue a history request to find its edit.
        const history = yield* MessageV2.page({ sessionID: a.session.id, limit: 20, before: start.next ?? undefined })
        b.write(
          a.directory,
          a.session.id,
          {
            session: history.items.map((item) => item.info),
            part: history.items.map((item) => ({ id: item.info.id, part: item.parts })),
            cursor: history.cursor,
            complete: !history.more,
          },
          { before: start.next ?? undefined },
        )
        expect(b.feedEntry(a.directory, a.session.id)?.session).toHaveLength(26)
        const older = history.items[0]!.info
        expect(start.page.session.some((message) => message.id === older.id)).toBe(false)
        yield* Effect.promise(() => b.flush())
        b.dispose()
        yield* a.service.updateMessage({
          ...a.messages.find((message) => message.id === older.id)!,
          agent: "offline-edited",
        })
        const extra = yield* a.service.updatePart({ ...a.part, id: PartID.ascending(), text: "remove me" })
        const offline = a.cache()
        const first = yield* Effect.promise(() => a.changes(offline, "1"))
        expect(first.more).toBe(true)
        expect(first.cursor).not.toBe(start.cursor)
        yield* Effect.promise(() => offline.flush())
        offline.dispose()
        const resumed = a.cache()
        const second = yield* Effect.promise(() => a.changes(resumed, "1"))
        expect(a.requests.at(-1)?.cursor).toBe(first.cursor)
        expect(second.more).toBe(false)
        expect(resumed.feedEntry(a.directory, a.session.id)?.session.find((info) => info.id === older.id)?.agent).toBe(
          "offline-edited",
        )
        yield* a.service.removePart({ sessionID: a.session.id, messageID: a.info.id, partID: extra.id })
        yield* a.service.removeMessage({ sessionID: a.session.id, messageID: a.messages[24]!.id })
        const removed = yield* Effect.promise(() => a.changes(resumed))
        expect(removed.changes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "part.remove", partID: extra.id }),
            expect.objectContaining({ type: "message.remove", messageID: a.messages[24]!.id }),
          ]),
        )
        const entry = resumed.feedEntry(a.directory, a.session.id)
        expect(entry?.session.some((info) => info.id === a.messages[24]!.id)).toBe(false)
        expect(entry?.part.flatMap((group) => group.part).some((part) => part.id === extra.id)).toBe(false)
        expect(() =>
          Database.transaction((db) => {
            db.delete(MessageTable).where(eq(MessageTable.id, a.info.id)).run()
            db.run(sql`UPDATE part SET data=json_set(data,'$.text','rolled back') WHERE id=${a.part.id}`)
            throw new Error("deliberate isolated rollback")
          }),
        ).toThrow("deliberate isolated rollback")
        const unchanged = yield* Effect.promise(() => a.changes(resumed))
        expect(unchanged.changes).toEqual([])
        expect(unchanged.cursor).toBe(removed.cursor)
        expect(a.requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "rejects a delayed real stamped SSE delta already represented by HTTP and resets expired generations atomically",
    () =>
      Effect.gen(function* () {
        const a = yield* fixture()
        const b = a.cache()
        const start = yield* Effect.promise(() => a.snapshot(b))
        const response = yield* Effect.promise(() =>
          fetch(new URL(`/event?directory=${encodeURIComponent(a.directory)}`, a.baseUrl), {
            headers: { authorization },
          }),
        )
        if (!response.body) return yield* Effect.die("Missing live event body")
        const reader = response.body.getReader()
        yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
        const decoder = new TextDecoder()
        let pending = ""
        const event = async () => {
          while (!pending.includes("\n\n")) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error("SSE closed")
            pending += decoder.decode(chunk.value, { stream: true })
          }
          const end = pending.indexOf("\n\n")
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          return JSON.parse(frame.replace(/^data: /, "")) as { type: string; properties: unknown }
        }
        expect(yield* Effect.promise(event)).toMatchObject({ type: "server.connected" })
        const context = yield* Effect.context()
        Database.transaction(() => {
          Effect.runSync(a.service.updatePart({ ...a.part, text: "ab" }).pipe(Effect.provide(context)))
          Effect.runSync(
            a.service
              .updatePartDelta({
                sessionID: a.session.id,
                messageID: a.info.id,
                partID: a.part.id,
                field: "text",
                delta: "c",
              })
              .pipe(Effect.provide(context)),
          )
        })
        const http = yield* Effect.promise(() => a.changes(b))
        const replacement = http.changes.find((change) => change.type === "part.upsert")
        if (!replacement) return yield* Effect.die("Missing replacement")
        let received = false
        let fullReceived = false
        for (let index = 0; index < 10; index++) {
          const live = yield* Effect.promise(event).pipe(Effect.timeout("5 seconds"))
          if (live.type === MessageV2.Event.PartUpdated.type) {
            const properties = Schema.decodeUnknownSync(MessageV2.Event.PartUpdated.properties)(live.properties)
            expect(properties.part).toMatchObject({ text: "ab" })
            expect(properties.transcript?.seq).toBeLessThan(replacement.seq)
            expect(b.event(a.directory, { type: "message.part.updated", properties })).toBe(false)
            fullReceived = true
            continue
          }
          if (live.type !== MessageV2.Event.PartDelta.type) continue
          const properties = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.properties)(live.properties)
          expect(properties.transcript).toEqual({ generation: http.generation, seq: replacement.seq })
          // Full replacement coverage rejects both the earlier full frame and the additive frame at its own seq.
          expect(b.event(a.directory, { type: "message.part.delta", properties })).toBe(false)
          expect(
            b
              .feedEntry(a.directory, a.session.id)
              ?.part.find((group) => group.id === a.info.id)
              ?.part.find((part) => part.id === a.part.id),
          ).toMatchObject({ text: "abc" })
          yield* browser({
            baseUrl: a.baseUrl,
            directory: a.directory,
            sessionID: a.session.id,
            event: { type: "message.part.delta", properties },
            text: "abc",
          })
          received = true
          break
        }
        expect(received).toBe(true)
        expect(fullReceived).toBe(true)
        SessionTranscriptFeed.reset({ projectID: a.session.projectID, directory: a.directory, sessionID: a.session.id })
        const expired = yield* Effect.promise(() =>
          a.client.session.transcriptChanges({ sessionID: a.session.id, cursor: http.cursor }, { throwOnError: false }),
        )
        expect(expired.response.status).toBe(410)
        expect(b.feedEntry(a.directory, a.session.id)?.syncCursor).toBe(http.cursor)
        b.resetFeed(a.directory, a.session.id)
        expect(b.feedEntry(a.directory, a.session.id)?.session).toHaveLength(20)
        expect(b.feedEntry(a.directory, a.session.id)?.syncCursor).toBeUndefined()
        const reset = yield* Effect.promise(() => a.snapshot(b))
        expect(reset.generation).not.toBe(start.generation)
        expect(b.feedEntry(a.directory, a.session.id)?.syncGeneration).toBe(reset.generation)
        yield* a.service.remove(a.session.id)
        const missing = yield* Effect.promise(() =>
          a.client.session.transcriptChanges(
            { sessionID: a.session.id, cursor: reset.cursor },
            { throwOnError: false },
          ),
        )
        expect(missing.response.status).toBe(404)
        expect(missing.response.headers.get("x-opencode-transcript-feed")).toBe("1")
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )
})
