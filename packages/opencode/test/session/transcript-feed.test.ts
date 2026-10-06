import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { Worker } from "node:worker_threads"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { and, eq, gt, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Bus } from "@/bus"
import { EventTable } from "@/sync/event.sql"
import { SyncEvent } from "@/sync"
import { SessionTranscript } from "@/session/transcript"
import { Session } from "@/session/session"
import { SessionTranscriptFeed as Feed } from "@/session/transcript-feed"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProjectID } from "@/project/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import {
  MessageTable,
  PartTable,
  SessionTable,
  SessionTranscriptChangeTable,
  SessionTranscriptMetaTable,
  SessionTranscriptStateTable,
} from "@/session/session.sql"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { pollWithTimeout } from "../lib/effect"

const it = testEffect(
  Session.defaultLayer.pipe(Layer.provideMerge(SyncEvent.defaultLayer), Layer.provideMerge(Bus.layer)),
)
afterEach(resetDatabase)

const setup = Effect.fn("TranscriptTest.setup")(function* () {
  const service = yield* Session.Service
  const session = yield* service.create({ title: "transcript" })
  const info = yield* service.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    time: { created: 100 },
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  })
  const part = yield* service.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: info.id,
    type: "text",
    text: "initial",
  })
  const scope: Feed.Scope = { sessionID: session.id, projectID: session.projectID, directory: session.directory }
  return { service, session, info, part, scope }
})

function snapshot(scope: Feed.Scope, limit = 20) {
  const result = Feed.snapshot(scope, { limit })
  if ("error" in result) throw new Error(result.error)
  return result
}

function changes(scope: Feed.Scope, cursor: string, limit = 100) {
  const result = Feed.changes(scope, { cursor, limit })
  if ("error" in result) throw new Error(`${result.error}: ${result.reason ?? ""}`)
  return result
}

function position(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString()) as { position: number }
}

function partMutation(event: { type: string; properties: unknown }) {
  if (event.type === MessageV2.Event.PartUpdated.type) {
    const properties = Schema.decodeUnknownSync(MessageV2.Event.PartUpdated.properties)(event.properties)
    return {
      type: event.type,
      partID: properties.part.id,
      value: properties.part.type === "text" ? properties.part.text : undefined,
      transcript: properties.transcript,
    }
  }
  if (event.type === MessageV2.Event.PartDelta.type) {
    const properties = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.properties)(event.properties)
    return { type: event.type, partID: properties.partID, value: properties.delta, transcript: properties.transcript }
  }
}

describe("durable transcript feed", () => {
  it.instance("snapshots latest messages with metadata, parts and an atomic watermark", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const ids = [f.info.id]
      for (let index = 1; index <= 24; index++) {
        const message = yield* f.service.updateMessage({
          ...f.info,
          id: MessageID.ascending(),
          time: { created: 100 + index },
        })
        ids.push(message.id)
      }
      const page = snapshot(f.scope)
      expect(page.items.map((item) => item.info.id)).toEqual(ids.slice(-20))
      expect(page.session.id).toBe(f.session.id)
      expect(position(page.cursor).position).toBe(page.version)
      expect(page.next).not.toBeNull()
      const older = yield* MessageV2.page({ sessionID: f.session.id, limit: 20, before: page.next ?? undefined })
      expect(older.items.map((item) => item.info.id)).toEqual(ids.slice(0, 5))
      expect(older.items[0]?.parts[0]?.id).toBe(f.part.id)
      expect(changes(f.scope, page.cursor).changes).toEqual([])

      // An older cached message is tracked by mutation ID, not by history position.
      yield* f.service.updateMessage({ ...f.info, agent: "offline-edit" })
      const delta = changes(f.scope, page.cursor)
      expect(delta.changes).toHaveLength(1)
      expect(delta.changes[0]).toMatchObject({ type: "message.upsert", info: { id: f.info.id, agent: "offline-edit" } })
    }),
  )

  it.instance("persists text and reasoning deltas before stream completion without sibling payloads", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const sibling = yield* f.service.updatePart({
        id: PartID.ascending(),
        sessionID: f.session.id,
        messageID: f.info.id,
        type: "tool",
        callID: "tool-call",
        tool: "bash",
        state: {
          status: "completed",
          input: {},
          title: "large",
          metadata: {},
          output: "x".repeat(100_000),
          time: { start: 1, end: 2 },
        },
      })
      const reasoning = yield* f.service.updatePart({
        id: PartID.ascending(),
        sessionID: f.session.id,
        messageID: f.info.id,
        type: "reasoning",
        text: "",
        time: { start: 1 },
      })
      const start = snapshot(f.scope)
      for (let index = 0; index < 50; index++)
        yield* f.service.updatePartDelta({
          sessionID: f.session.id,
          messageID: f.info.id,
          partID: f.part.id,
          field: "text",
          delta: ".",
        })
      yield* f.service.updatePartDelta({
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: reasoning.id,
        field: "text",
        delta: "thinking",
      })
      const delta = changes(f.scope, start.cursor)
      expect(delta.changes).toHaveLength(2)
      expect(delta.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "part.upsert",
            info: expect.objectContaining({ id: f.info.id }),
            part: expect.objectContaining({ id: f.part.id, text: "initial" + ".".repeat(50) }),
          }),
          expect.objectContaining({
            type: "part.upsert",
            part: expect.objectContaining({ id: reasoning.id, text: "thinking" }),
          }),
        ]),
      )
      expect(JSON.stringify(delta)).not.toContain(sibling.id)
      expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThan(4000)
      const columns = Database.use((db) => db.all<{ name: string }>(sql`PRAGMA table_info(session_transcript_change)`))
      expect(columns.map((column) => column.name)).toEqual([
        "seq",
        "session_id",
        "generation",
        "kind",
        "message_id",
        "part_id",
      ])
      yield* f.service.updatePart({ ...f.part, text: "plugin-authoritative" })
      expect(changes(f.scope, delta.cursor).changes[0]).toMatchObject({
        type: "part.upsert",
        part: { text: "plugin-authoritative" },
      })
    }),
  )

  it.instance("ignores invalid delta fields and foreign session/message/part identities", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      for (const input of [
        { sessionID: SessionID.descending(), messageID: f.info.id, partID: f.part.id, field: "text" },
        { sessionID: f.session.id, messageID: MessageID.ascending(), partID: f.part.id, field: "text" },
        { sessionID: f.session.id, messageID: f.info.id, partID: PartID.ascending(), field: "text" },
        { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id, field: "output" },
      ])
        yield* f.service.updatePartDelta({ ...input, delta: "wrong" })
      expect(changes(f.scope, start.cursor).changes).toEqual([])
      expect(snapshot(f.scope).items[0]?.parts[0]).toMatchObject({ text: "initial" })
    }),
  )

  it.instance("makes persisted text visible to live delta subscribers without full-part sync events", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const observed: unknown[] = []
      const unsubscribe = yield* bus.subscribeCallback(MessageV2.Event.PartDelta, () => {
        observed.push(snapshot(f.scope).items[0]?.parts[0])
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      const before = Database.use(
        (db) =>
          db
            .select({ total: sql<number>`count(*)` })
            .from(EventTable)
            .get()?.total,
      )
      yield* f.service.updatePartDelta({
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: f.part.id,
        field: "text",
        delta: " visible",
      })
      const received = yield* pollWithTimeout(
        Effect.sync(() => observed[0]),
        "Delta subscriber did not receive text",
      )
      expect(received).toMatchObject({ text: "initial visible" })
      expect(
        Database.use(
          (db) =>
            db
              .select({ total: sql<number>`count(*)` })
              .from(EventTable)
              .get()?.total,
        ),
      ).toBe(before)
    }),
  )

  it.instance("stamps live deltas with the committed part revision already visible in the feed", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.service.updatePart({ ...f.part, text: "a" })
      const start = snapshot(f.scope)
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribe(MessageV2.Event.PartDelta)
      yield* f.service.updatePartDelta({
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: f.part.id,
        field: "text",
        delta: "b",
      })
      const current = snapshot(f.scope)
      const delta = changes(f.scope, start.cursor)
      const events = yield* subscription.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(current.items[0]?.parts[0]).toMatchObject({ text: "ab" })
      expect(delta.generation).toBe(current.generation)
      expect(events[0]?.properties).toMatchObject({
        delta: "b",
        transcript: { generation: current.generation, seq: delta.changes[0]?.seq },
      })
      expect(events[0]?.properties.transcript?.seq).toBeLessThanOrEqual(current.version)
      // A client that has applied this feed revision can reject the late delta
      // by generation + seq instead of appending b again to its stored ab.
    }),
  )

  it.instance("publishes a full part followed by its delta in the outer transaction's FIFO", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.service.updatePart({ ...f.part, text: "a" })
      const start = snapshot(f.scope)
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribeAll()
      const context = yield* Effect.context()
      const input = { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id, field: "text", delta: "c" }
      Database.transaction(() => {
        Effect.runSync(f.service.updatePart({ ...f.part, text: "ab" }).pipe(Effect.provide(context)))
        Effect.runSync(f.service.updatePartDelta(input).pipe(Effect.provide(context)))
      })
      input.delta = "never-persisted"
      const events = yield* subscription.pipe(
        Stream.map(partMutation),
        Stream.filter((event) => event !== undefined),
        Stream.filter((event) => event.partID === f.part.id && (event.transcript?.seq ?? 0) > start.version),
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      expect(events.map((event) => event.type)).toEqual([
        MessageV2.Event.PartUpdated.type,
        MessageV2.Event.PartDelta.type,
      ])
      expect(events.map((event) => event.value)).toEqual(["ab", "c"])
      expect(events.map((event) => event.transcript)).toEqual([
        { generation: start.generation, seq: start.version + 1 },
        { generation: start.generation, seq: start.version + 2 },
      ])
      expect(snapshot(f.scope).items[0]?.parts[0]).toMatchObject({ text: "abc" })
    }),
  )

  it.instance("discards nested delta publication on rollback without exposing a reusable sequence", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.service.updatePart({ ...f.part, text: "a" })
      const start = snapshot(f.scope)
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribe(MessageV2.Event.PartDelta)
      const context = yield* Effect.context()
      const input = { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id, field: "text", delta: "b" }
      expect(() =>
        Database.transaction(() => {
          Effect.runSync(f.service.updatePartDelta(input).pipe(Effect.provide(context)))
          throw new Error("rollback-delta")
        }),
      ).toThrow("rollback-delta")
      const after = snapshot(f.scope)
      expect(after.items[0]?.parts[0]).toMatchObject({ text: "a" })
      expect(after.cursor).toBe(start.cursor)
      expect(after.version).toBe(start.version)
      expect(changes(f.scope, start.cursor)).toMatchObject({
        cursor: start.cursor,
        highwater: start.cursor,
        changes: [],
        more: false,
      })
      // A bus barrier drains earlier events without relying on a timed absence.
      yield* bus.publish(MessageV2.Event.PartDelta, { ...input, delta: "barrier" })
      const events = yield* subscription.pipe(
        Stream.takeUntil((event) => event.properties.delta === "barrier"),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      expect(events.map((event) => event.properties.delta)).toEqual(["barrier"])
      const committed = yield* bus.subscribe(MessageV2.Event.PartDelta)
      yield* f.service.updatePartDelta({ ...input, delta: "c" })
      const next = yield* committed.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(next[0]?.properties).toMatchObject({
        delta: "c",
        transcript: { generation: start.generation, seq: start.version + 1 },
      })
      expect(snapshot(f.scope).items[0]?.parts[0]).toMatchObject({ text: "ac" })
    }),
  )

  it.instance("orders two nested appends before a later full update without borrowing its payload", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.service.updatePart({ ...f.part, text: "a" })
      const start = snapshot(f.scope)
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribeAll()
      const context = yield* Effect.context()
      const input = { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id, field: "text", delta: "b" }
      Database.transaction(() => {
        Effect.runSync(f.service.updatePartDelta(input).pipe(Effect.provide(context)))
        input.delta = "c"
        Effect.runSync(f.service.updatePartDelta(input).pipe(Effect.provide(context)))
        Effect.runSync(f.service.updatePart({ ...f.part, text: "plugin-final" }).pipe(Effect.provide(context)))
      })
      input.delta = "never-persisted"
      const events = yield* subscription.pipe(
        Stream.map(partMutation),
        Stream.filter((event) => event !== undefined),
        Stream.filter((event) => event.partID === f.part.id && (event.transcript?.seq ?? 0) > start.version),
        Stream.take(3),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      expect(events.map((event) => event.type)).toEqual([
        MessageV2.Event.PartDelta.type,
        MessageV2.Event.PartDelta.type,
        MessageV2.Event.PartUpdated.type,
      ])
      expect(events.map((event) => event.value)).toEqual(["b", "c", "plugin-final"])
      expect(events.map((event) => event.transcript?.seq)).toEqual([
        start.version + 1,
        start.version + 2,
        start.version + 3,
      ])
      expect(events.every((event) => event.transcript?.generation === start.generation)).toBe(true)
      expect(snapshot(f.scope).items[0]?.parts[0]).toMatchObject({ text: "plugin-final" })
    }),
  )

  it.instance("keeps queued full-part payloads paired with their own mutation stamps", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribe(MessageV2.Event.PartUpdated)
      const context = yield* Effect.context()
      const start = snapshot(f.scope)
      const payload = { ...f.part, text: "queued-first" }
      Database.transaction(() => {
        Effect.runSync(f.service.updatePart(payload).pipe(Effect.provide(context)))
        payload.text = "queued-second"
        Effect.runSync(f.service.updatePart(payload).pipe(Effect.provide(context)))
      })
      payload.text = "never-persisted"
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionTranscriptChangeTable)
          .where(
            and(
              eq(SessionTranscriptChangeTable.part_id, f.part.id),
              gt(SessionTranscriptChangeTable.seq, start.version),
            ),
          )
          .all(),
      )
      const events = yield* subscription.pipe(Stream.take(2), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(events.map((event) => event.properties.part)).toEqual([
        expect.objectContaining({ text: "queued-first" }),
        expect.objectContaining({ text: "queued-second" }),
      ])
      expect(events.map((event) => event.properties.transcript?.seq)).toEqual(rows.map((row) => row.seq))
      expect(events.every((event) => event.properties.transcript?.generation === start.generation)).toBe(true)
      expect(snapshot(f.scope).items[0]?.parts[0]).toMatchObject({ text: "queued-second" })
    }),
  )

  it.instance("stamps queued message upserts without borrowing a later payload or revision", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribe(MessageV2.Event.Updated)
      const context = yield* Effect.context()
      const start = snapshot(f.scope)
      const payload = { ...f.info, agent: "first" }
      Database.transaction(() => {
        Effect.runSync(f.service.updateMessage(payload).pipe(Effect.provide(context)))
        payload.agent = "second"
        Effect.runSync(f.service.updateMessage(payload).pipe(Effect.provide(context)))
      })
      payload.agent = "never-persisted"
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionTranscriptChangeTable)
          .where(
            and(
              eq(SessionTranscriptChangeTable.kind, "message"),
              eq(SessionTranscriptChangeTable.message_id, f.info.id),
              gt(SessionTranscriptChangeTable.seq, start.version),
            ),
          )
          .all(),
      )
      const events = yield* subscription.pipe(Stream.take(2), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(events.map((event) => event.properties.info.agent)).toEqual(["first", "second"])
      expect(events.map((event) => event.properties.transcript?.seq)).toEqual(rows.map((row) => row.seq))
      expect(events.every((event) => event.properties.transcript?.generation === start.generation)).toBe(true)
    }),
  )

  it.instance("stamps removals and cascades and rejects supplied stamps on non-mutating writes", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const partRemoved = yield* bus.subscribe(MessageV2.Event.PartRemoved)
      const removed = yield* bus.subscribe(MessageV2.Event.Removed)
      const generation = snapshot(f.scope).generation
      yield* f.service.removePart({ sessionID: f.session.id, messageID: f.info.id, partID: f.part.id })
      const partEvents = yield* partRemoved.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(partEvents[0]?.properties.transcript).toEqual({ generation, seq: snapshot(f.scope).version })
      yield* f.service.updatePart(f.part)
      const before = snapshot(f.scope)
      yield* f.service.removeMessage({ sessionID: f.session.id, messageID: f.info.id })
      const messageEvents = yield* removed.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      const delta = changes(f.scope, before.cursor)
      const removal = delta.changes.find((item) => item.type === "message.remove")
      if (!removal) throw new Error("Missing message removal")
      expect(messageEvents[0]?.properties.transcript).toEqual({
        generation,
        seq: removal.seq,
      })
      expect(delta.changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "part.remove", partID: f.part.id })]),
      )
      const missing = yield* bus.subscribe(MessageV2.Event.PartRemoved)
      yield* SyncEvent.use.run(MessageV2.Event.PartRemoved, {
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: f.part.id,
        transcript: { generation: "untrusted", seq: 999 },
      })
      const missingEvents = yield* missing.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(missingEvents[0]?.properties.transcript).toBeUndefined()
    }),
  )

  it.instance("does not invent stamps for rejected writes or externally published events", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const updated = yield* bus.subscribe(MessageV2.Event.PartUpdated)
      const external = yield* bus.subscribe(MessageV2.Event.PartDelta)
      const before = snapshot(f.scope)
      const foreignMessage = MessageID.ascending()
      yield* SyncEvent.use.run(MessageV2.Event.PartUpdated, {
        sessionID: f.session.id,
        part: { ...f.part, messageID: foreignMessage, text: "rejected" },
        time: Date.now(),
        transcript: { generation: "untrusted", seq: 999 },
      })
      const rejected = yield* updated.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(rejected[0]?.properties.transcript).toBeUndefined()
      expect(snapshot(f.scope).items).toEqual(before.items)
      expect(changes(f.scope, before.cursor).changes).toEqual([])
      const foreign = yield* f.service.create()
      const messages = yield* bus.subscribe(MessageV2.Event.Updated)
      yield* SyncEvent.use.run(MessageV2.Event.Updated, {
        sessionID: foreign.id,
        info: { ...f.info, sessionID: foreign.id, agent: "foreign" },
        transcript: { generation: "untrusted", seq: 999 },
      })
      const foreignEvents = yield* messages.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(foreignEvents[0]?.properties.transcript).toBeUndefined()
      const removals = yield* bus.subscribe(MessageV2.Event.PartRemoved)
      yield* f.service.removePart({ sessionID: f.session.id, messageID: foreignMessage, partID: f.part.id })
      const wrongParentEvents = yield* removals.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(wrongParentEvents[0]?.properties.transcript).toBeUndefined()
      expect(snapshot(f.scope).items).toEqual(before.items)
      yield* bus.publish(MessageV2.Event.PartDelta, {
        sessionID: f.session.id,
        messageID: f.info.id,
        partID: f.part.id,
        field: "text",
        delta: "external",
      })
      const externalEvents = yield* external.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(externalEvents[0]?.properties.transcript).toBeUndefined()
      expect(
        Database.use((db) =>
          SessionTranscript.stamp(
            db,
            { sessionID: f.session.id, messageID: f.info.id, partID: f.part.id },
            before.version,
          ),
        ),
      ).toBeUndefined()
    }),
  )

  it.instance("preserves an old queued event generation across a session reset before publication", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const bus = yield* Bus.Service
      const subscription = yield* bus.subscribe(MessageV2.Event.PartUpdated)
      const context = yield* Effect.context()
      const before = snapshot(f.scope)
      Database.transaction(() => {
        Effect.runSync(f.service.updatePart({ ...f.part, text: "before-reset" }).pipe(Effect.provide(context)))
        Feed.reset(f.scope)
      })
      const events = yield* subscription.pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      const after = snapshot(f.scope)
      expect(events[0]?.properties.transcript?.generation).toBe(before.generation)
      expect(after.generation).not.toBe(before.generation)
      expect(after.generation).toHaveLength(65)
      expect(Feed.changes(f.scope, { cursor: before.cursor, limit: 1 })).toMatchObject({
        error: "expired",
        reason: "session-reset",
      })
    }),
  )

  it.instance("captures raw SQL edits, removals, cascades and transaction rollback", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      const previousTime = Database.use(
        (db) => db.select().from(SessionTable).where(eq(SessionTable.id, f.session.id)).get()?.time_updated,
      )
      Database.transaction((db) => {
        db.run(sql`UPDATE message SET data=json_set(data,'$.agent','raw') WHERE id=${f.info.id}`)
        db.run(sql`UPDATE part SET data=json_set(data,'$.text','raw-text') WHERE id=${f.part.id}`)
      })
      const delta = changes(f.scope, start.cursor)
      expect(delta.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message.upsert", info: expect.objectContaining({ agent: "raw" }) }),
          expect.objectContaining({ type: "part.upsert", part: expect.objectContaining({ text: "raw-text" }) }),
        ]),
      )
      expect(
        Database.use(
          (db) => db.select().from(SessionTable).where(eq(SessionTable.id, f.session.id)).get()?.time_updated,
        ),
      ).toBe(previousTime)
      expect(() =>
        Database.transaction((db) => {
          db.delete(MessageTable).where(eq(MessageTable.id, f.info.id)).run()
          throw new Error("rollback")
        }),
      ).toThrow("rollback")
      expect(changes(f.scope, delta.cursor).changes).toEqual([])
      Database.use((db) => db.delete(MessageTable).where(eq(MessageTable.id, f.info.id)).run())
      expect(changes(f.scope, delta.cursor).changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message.remove", messageID: f.info.id }),
          expect.objectContaining({ type: "part.remove", partID: f.part.id, messageID: f.info.id }),
        ]),
      )
    }),
  )

  it.instance("captures raw inserts and part reparenting without stranding the old key", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      const other = MessageID.ascending()
      Database.use((db) => {
        db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        SELECT ${other},session_id,200,200,data FROM message WHERE id=${f.info.id}`)
        db.run(sql`UPDATE part SET message_id=${other} WHERE id=${f.part.id}`)
      })
      expect(changes(f.scope, start.cursor).changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message.upsert", info: expect.objectContaining({ id: other }) }),
          expect.objectContaining({ type: "part.remove", messageID: f.info.id, partID: f.part.id }),
          expect.objectContaining({
            type: "part.upsert",
            info: expect.objectContaining({ id: other }),
            part: expect.objectContaining({ messageID: other }),
          }),
        ]),
      )
    }),
  )

  it.instance("never acknowledges deferred records across record and byte budgets", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const parts = yield* Effect.forEach([1, 2, 3], () =>
        f.service.updatePart({
          ...f.part,
          id: PartID.ascending(),
          text: "small",
        }),
      )
      const start = snapshot(f.scope)
      for (const p of parts) yield* f.service.updatePart({ ...p, text: "b".repeat(150_000) })
      const first = changes(f.scope, start.cursor)
      expect(first.changes).toHaveLength(1)
      expect(first.more).toBe(true)
      expect(position(first.cursor).position).toBeLessThan(position(first.highwater).position)
      yield* f.service.updatePart({ ...parts[0], text: "edited-between-pages" })
      const second = changes(f.scope, first.cursor, 1)
      const third = changes(f.scope, second.cursor, 1)
      const fourth = changes(f.scope, third.cursor, 1)
      expect(second.more).toBe(true)
      expect(fourth.more).toBe(false)
      expect(
        [...first.changes, ...second.changes, ...third.changes, ...fourth.changes]
          .filter((item) => item.type === "part.upsert")
          .map((item) => item.part.id),
      ).toEqual([...parts.map((p) => p.id), parts[0].id])
      const before = fourth.cursor
      yield* f.service.updatePart({ ...f.part, text: "z".repeat(Feed.byteTarget + 1000) })
      const oversized = changes(f.scope, before)
      expect(oversized.changes).toHaveLength(1)
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(Feed.byteTarget)
      expect(oversized.more).toBe(false)
    }),
  )

  it.instance("bounds raw work and versions hydrated entities beyond the consumed prefix", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      Database.transaction((db) => {
        for (let index = 0; index < Feed.rawLimit + 5; index++) {
          db.run(sql`UPDATE part SET data=json_set(data,'$.text',${String(index)}) WHERE id=${f.part.id}`)
        }
      })
      const first = changes(f.scope, start.cursor)
      expect(first.more).toBe(true)
      expect(first.changes).toHaveLength(1)
      expect(first.changes[0]?.seq).toBe(position(first.highwater).position)
      expect(first.changes[0]?.seq).toBeGreaterThan(position(first.cursor).position)
      expect(first.changes[0]).toMatchObject({ part: { text: String(Feed.rawLimit + 4) } })
      const second = changes(f.scope, first.cursor)
      expect(second.more).toBe(false)
      expect(second.changes).toEqual(first.changes)
      expect(changes(f.scope, second.cursor).changes).toEqual([])
    }),
  )

  it.instance("binds cursors to scope and generation, returns missing sessions and metadata", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      for (const scope of [
        { ...f.scope, sessionID: SessionID.descending() },
        { ...f.scope, projectID: ProjectID.make("foreign") },
        { ...f.scope, directory: f.scope.directory + "/foreign" },
        { ...f.scope, workspaceID: WorkspaceID.make("wrk_foreign") },
      ])
        expect(Feed.changes(scope, { cursor: start.cursor, limit: 1 })).toMatchObject({ error: "invalid" })
      expect(Feed.changes(f.scope, { cursor: "invalid", limit: 1 })).toMatchObject({ error: "invalid" })
      const future = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(start.cursor, "base64url").toString()),
          position: start.version + 1,
        }),
      ).toString("base64url")
      expect(Feed.changes(f.scope, { cursor: future, limit: 1 })).toMatchObject({ error: "invalid" })
      Database.use((db) =>
        db.update(SessionTable).set({ title: "new-metadata" }).where(eq(SessionTable.id, f.session.id)).run(),
      )
      expect(changes(f.scope, start.cursor).session?.title).toBe("new-metadata")
      const original = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, f.session.id)).get(),
      )
      if (!original) throw new Error("Missing test session")
      expect(() =>
        Database.transaction((db) => {
          db.delete(SessionTable).where(eq(SessionTable.id, f.session.id)).run()
          db.insert(SessionTable).values(original).run()
          throw new Error("rollback-reset")
        }),
      ).toThrow("rollback-reset")
      expect("error" in Feed.changes(f.scope, { cursor: start.cursor, limit: 1 })).toBe(false)
      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, f.session.id)).run())
      expect(Feed.snapshot(f.scope, { limit: 20 })).toEqual({ error: "not-found" })
      expect(Feed.changes(f.scope, { cursor: start.cursor, limit: 1 })).toMatchObject({ error: "not-found" })
      Database.use((db) => db.insert(SessionTable).values(original).run())
      expect(Feed.changes(f.scope, { cursor: start.cursor, limit: 1 })).toMatchObject({
        error: "expired",
        reason: "session-reset",
      })
      expect(snapshot(f.scope).items).toEqual([])
    }),
  )

  it.instance(
    "bounds retention, expires only below the floor and preserves the boundary",
    () =>
      Effect.gen(function* () {
        const f = yield* setup()
        const start = snapshot(f.scope)
        Database.transaction((db) => {
          for (let index = 0; index < 65540; index++)
            db.run(sql`UPDATE part SET data=json_set(data,'$.text',${String(index)}) WHERE id=${f.part.id}`)
        })
        const head = Database.use((db) => db.select().from(SessionTranscriptMetaTable).get())
        if (!head) throw new Error("Missing cursor metadata")
        expect(
          Database.use(
            (db) =>
              db
                .select({ total: sql<number>`count(*)` })
                .from(SessionTranscriptChangeTable)
                .get()?.total,
          ),
        ).toBe(65536)
        expect(head.floor).toBe(head.seq - 65536)
        expect(Feed.changes(f.scope, { cursor: start.cursor, limit: 1 })).toMatchObject({
          error: "expired",
          reason: "retention",
        })
        const boundary = Buffer.from(
          JSON.stringify({ ...JSON.parse(Buffer.from(start.cursor, "base64url").toString()), position: head.floor }),
        ).toString("base64url")
        expect(changes(f.scope, boundary).changes[0]).toMatchObject({ type: "part.upsert", part: { text: "65539" } })
        expect(snapshot(f.scope).version).toBe(head.seq)
        expect(Database.use((db) => db.select().from(SessionTranscriptStateTable).get()?.deleted)).toBe(0)
      }),
    { timeout: 60000 },
  )

  it.instance("invalidates explicit resets and directory moves transactionally", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const start = snapshot(f.scope)
      expect(Feed.reset({ ...f.scope, directory: f.scope.directory + "/wrong" })).toBe(false)
      expect(Feed.reset(f.scope)).toBe(true)
      expect(Feed.changes(f.scope, { cursor: start.cursor, limit: 1 })).toMatchObject({
        error: "expired",
        reason: "session-reset",
      })
      const fresh = snapshot(f.scope)
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ directory: f.scope.directory + "/moved" })
          .where(eq(SessionTable.id, f.session.id))
          .run(),
      )
      expect(Feed.snapshot(f.scope, { limit: 20 })).toMatchObject({ error: "not-found" })
      const moved = { ...f.scope, directory: f.scope.directory + "/moved" }
      expect(snapshot(moved).items[0]?.info.id).toBe(f.info.id)
      Database.use((db) =>
        db.update(SessionTable).set({ directory: f.scope.directory }).where(eq(SessionTable.id, f.session.id)).run(),
      )
      expect(Feed.changes(f.scope, { cursor: fresh.cursor, limit: 1 })).toMatchObject({
        error: "expired",
        reason: "session-reset",
      })
    }),
  )

  it.instance("keeps snapshots consistent with concurrent SQL writers and expires cursors on reopen", () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.service.updateMessage({ ...f.info, agent: "initial" })
      const test = yield* TestInstance
      const file = path.join(test.directory, "concurrent.sqlite")
      yield* Effect.promise(() => Bun.write(file, Database.Client().$client.serialize()))
      const previous = Flag.OPENCODE_DB
      Database.close()
      Flag.OPENCODE_DB = file
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Database.close()
          Flag.OPENCODE_DB = previous
        }),
      )
      const start = snapshot(f.scope)
      const signal = new Int32Array(new SharedArrayBuffer(4))
      const worker = new Worker(new URL("../fixture/transcript-writer.ts", import.meta.url), {
        workerData: { path: file, messageID: f.info.id, partID: f.part.id, signal: signal.buffer },
      })
      const lifecycle = { exited: false }
      const exited = new Promise<void>((resolve, reject) => {
        worker.once("exit", () => {
          lifecycle.exited = true
          resolve()
        })
        worker.once("error", reject)
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          Atomics.store(signal, 0, 2)
          Atomics.notify(signal, 0)
          if (!lifecycle.exited) await worker.terminate()
        }),
      )
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            worker.once("message", () => resolve())
            worker.once("error", reject)
          }),
      ).pipe(Effect.timeout("10 seconds"))
      Atomics.store(signal, 0, 1)
      Atomics.notify(signal, 0)
      for (let index = 0; index < 100; index++) {
        const page = snapshot(f.scope)
        const item = page.items[0]
        expect(item?.parts[0]).toMatchObject({ text: item?.info.agent })
        expect(position(page.cursor).position).toBe(page.version)
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      // The persistent journal survives reopening, but the cursor incarnation does not.
      Atomics.store(signal, 0, 2)
      yield* Effect.promise(() => exited).pipe(Effect.timeout("10 seconds"))
      const beforeClose = snapshot(f.scope)
      expect(beforeClose.version).toBeGreaterThan(start.version)
      Database.close()
      expect(Feed.changes(f.scope, { cursor: beforeClose.cursor, limit: 1 })).toMatchObject({
        error: "expired",
        reason: "database-reset",
      })
      const reopened = snapshot(f.scope)
      expect(reopened.version).toBe(beforeClose.version)
      expect(reopened.items).toEqual(beforeClose.items)
      expect(reopened.cursor).not.toBe(beforeClose.cursor)
      expect(reopened.generation).not.toBe(beforeClose.generation)
    }),
  )
})
