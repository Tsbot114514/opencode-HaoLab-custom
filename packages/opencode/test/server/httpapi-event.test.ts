import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "../../src/bus"
import { Event as ServerEvent } from "../../src/server/event"
import { Server } from "../../src/server/server"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import {
  SessionPaths,
  TranscriptSnapshotResult,
  TranscriptChangesResult,
} from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect, testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => reader.read()).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    if (result.done || !result.value) return yield* Effect.fail(new Error("event stream closed"))
    return Schema.decodeUnknownSync(EventData)(
      JSON.parse(new TextDecoder().decode(result.value).replace(/^data: /, "")),
    )
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(async () =>
      Server.Default().app.request(EventPaths.event, { headers: { "x-opencode-directory": directory } }),
    )
    if (!response.body) return yield* Effect.die("missing SSE response body")
    const reader = response.body.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffectShared(Bus.defaultLayer)
const transcriptIt = testEffect(Layer.empty)

describe("event HttpApi", () => {
  transcriptIt.instance(
    "delivers the delta stamp already represented by an HTTP transcript replacement",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const memoMap = yield* Layer.makeMemoMap
        const services = yield* Layer.buildWithMemoMap(Session.defaultLayer, memoMap, yield* Scope.Scope)
        const service = Context.get(services, Session.Service)
        const server = HttpRouter.toWebHandler(HttpApiApp.routes, { memoMap, disableLogger: true })
        yield* Effect.addFinalizer(() => Effect.promise(() => server.dispose()))
        const request = (url: string) =>
          server.handler(
            new Request(new URL(url, "http://localhost"), {
              headers: { "x-opencode-directory": directory },
            }),
            HttpApiApp.context,
          )
        const session = yield* service.create()
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
          text: "a",
        })
        const start = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(TranscriptSnapshotResult)(
            await (await request(SessionPaths.transcriptSnapshot.replace(":sessionID", session.id))).json(),
          ),
        )
        const response = yield* Effect.promise(() => request(EventPaths.event))
        if (!response.body) return yield* Effect.die("Missing SSE response body")
        const reader = response.body.getReader()
        yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected" })
        yield* service.updatePartDelta({
          sessionID: session.id,
          messageID: info.id,
          partID: part.id,
          field: "text",
          delta: "b",
        })
        const current = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(TranscriptChangesResult)(
            await (
              await request(
                `${SessionPaths.transcriptChanges.replace(":sessionID", session.id)}?cursor=${start.cursor}`,
              )
            ).json(),
          ),
        )
        const replacement = current.changes.find((item) => item.type === "part.upsert")
        if (!replacement || replacement.type !== "part.upsert")
          return yield* Effect.die("Missing HTTP part replacement")
        expect(replacement.part).toMatchObject({ text: "ab" })
        expect(current.generation).toBe(start.generation)
        for (let index = 0; index < 10; index++) {
          const event = yield* readEvent(reader)
          if (event.type !== MessageV2.Event.PartDelta.type) continue
          const properties = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.properties)(event.properties)
          expect(properties).toMatchObject({
            delta: "b",
            transcript: { generation: current.generation, seq: replacement.seq },
          })
          return
        }
        return yield* Effect.die("Missing stamped live delta")
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
        expect(response.headers.get("x-accel-buffering")).toBe("no")
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Effect.promise(() => reader.read()).pipe(
          Effect.map((result) => (result.done ? ("closed" as const) : ("event" as const))),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance bus events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        yield* Bus.use.publish(ServerEvent.Connected, {})
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
