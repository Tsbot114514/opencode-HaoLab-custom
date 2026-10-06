import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import http from "node:http"
import { randomBytes } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { compressionLayer } from "../../src/server/routes/instance/httpapi/middleware/compression"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeHttpServer.layerTest)
const path = "/session/ses_fixture/transcript/changes"
const authorization = `Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`
const payload = { output: "tool stdout: completed successfully\n".repeat(8_000) }

const serve = (handler: (request: HttpServerRequest.HttpServerRequest) => HttpServerResponse.HttpServerResponse) =>
  HttpRouter.add(
    "*",
    "/*",
    HttpServerRequest.HttpServerRequest.use((request) => Effect.succeed(handler(request))),
  ).pipe(
    Layer.provide([
      compressionLayer,
      authorizationRouterMiddleware.layer.pipe(
        Layer.provide(
          Layer.succeed(ServerAuth.Config)({ username: "fixture", password: Option.some("fixture-password") }),
        ),
      ),
    ]),
    HttpRouter.serve,
    Layer.build,
  )

// Node's raw client leaves content coding intact, unlike fetch's automatic decoding.
const request = (pathname: string, encoding?: string, options?: { method?: string; unauthorized?: boolean }) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const url = new URL(HttpServer.formatAddress(server.address))
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
    return yield* Effect.promise(
      () =>
        new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
          const req = http.request(
            new URL(pathname, url),
            {
              method: options?.method ?? "GET",
              headers: {
                ...(options?.unauthorized ? {} : { authorization }),
                ...(encoding === undefined ? {} : { "accept-encoding": encoding }),
              },
            },
            (response) => {
              const chunks: Buffer[] = []
              response.on("data", (chunk: Buffer) => chunks.push(chunk))
              response.on("error", reject)
              response.on("end", () =>
                resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
              )
            },
          )
          req.on("error", reject)
          req.end()
        }),
    )
  })

describe("transcript feed compression over HTTP", () => {
  it.live("round trips changing snapshots and deltas with gzip and preserves headers", () =>
    Effect.gen(function* () {
      const cursor = yield* Ref.make(0)
      yield* HttpRouter.add(
        "GET",
        "/*",
        Effect.gen(function* () {
          return HttpServerResponse.jsonUnsafe(
            { ...payload, cursor: yield* Ref.updateAndGet(cursor, (value) => value + 1) },
            {
              headers: { vary: "Origin", "x-opencode-fixture": "preserved" },
            },
          )
        }),
      ).pipe(Layer.provide(compressionLayer), HttpRouter.serve, Layer.build)

      for (const endpoint of ["snapshot", "changes"]) {
        for (const encoding of ["identity", "gzip"]) {
          const response = yield* request(`/session/ses_fixture/transcript/${endpoint}?after=previous`, encoding)
          expect(response.status).toBe(200)
          expect(response.headers["cache-control"]).toBe("no-store")
          expect(response.headers.vary).toBe("Origin, Accept-Encoding")
          expect(response.headers["x-opencode-fixture"]).toBe("preserved")
          expect(Number(response.headers["content-length"])).toBe(response.body.byteLength)
          const decoded = encoding === "gzip" ? gunzipSync(response.body) : response.body
          expect(JSON.parse(decoded.toString())).toEqual({ ...payload, cursor: yield* Ref.get(cursor) })
          expect(response.headers["content-encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined)
        }
      }
      expect(yield* Ref.get(cursor)).toBe(4)
    }),
  )

  const negotiation = [
    [undefined, false],
    ["", false],
    ["gzip", true],
    ["GZIP ; Q=0.5", true],
    ["gzip;q=0", false],
    ["gzip;q=0.000", false],
    ["gzip;q=0, *;q=1", false],
    ["*;q=0.5", true],
    ["*;q=0", false],
    ["gzip;q=0.5, identity;q=1", false],
    ["identity;q=0.2, gzip;q=0.5", true],
    ["identity;q=0, gzip;q=1", true],
    ["identity", false],
    ["br, deflate", false],
    ["xgzip, gzip-extra", false],
    ["gzip;q=bogus, *;q=1", false],
    ["gzip;q=1.001", false],
    ["gzip;q=-1", false],
    ["gzip;q=.5", false],
    ["gzip;q=0.1234", false],
    ["gzip;q=1;invalid=1", false],
    ["gzip;q=1, gzip;q=0", false],
  ] as const

  for (const [encoding, gzip] of negotiation) {
    it.live(`negotiates ${encoding ?? "absent"} without generic fallthrough`, () =>
      Effect.gen(function* () {
        yield* serve(() => HttpServerResponse.jsonUnsafe(payload))
        const response = yield* request(path, encoding)
        expect(response.status).toBe(200)
        expect(response.headers["content-encoding"]).toBe(gzip ? "gzip" : undefined)
        expect(response.headers.vary).toBe("Accept-Encoding")
        expect(response.headers["cache-control"]).toBe("no-store")
        expect(JSON.parse((gzip ? gunzipSync(response.body) : response.body).toString())).toEqual(payload)
      }),
    )
  }

  it.live("merges Vary case insensitively and preserves wildcard", () =>
    Effect.gen(function* () {
      yield* serve((r) =>
        HttpServerResponse.jsonUnsafe(payload, {
          headers: { vary: new URL(r.url, "http://fixture").searchParams.get("vary") ?? "Origin" },
        }),
      )
      for (const vary of ["Origin", "Origin, ACCEPT-ENCODING", "*"]) {
        const response = yield* request(`${path}?vary=${encodeURIComponent(vary)}`, "gzip")
        expect(response.headers.vary).toBe(vary === "Origin" ? "Origin, Accept-Encoding" : vary)
      }
    }),
  )

  it.live("keeps small cursor responses and nonshrinking byte bodies as complete identity", () =>
    Effect.gen(function* () {
      // The middleware treats JSON bytes opaquely; random bytes exercise its nonshrinking guard.
      const bodies = [Buffer.from('{"cursor":"next","events":[]}'), randomBytes(1024)]
      yield* serve((r) =>
        HttpServerResponse.uint8Array(bodies[r.url.includes("random") ? 1 : 0], { contentType: "application/json" }),
      )
      const small = yield* request(path, "gzip")
      expect(small.headers["content-encoding"]).toBeUndefined()
      expect(small.headers["cache-control"]).toBe("no-store")
      expect(small.body).toEqual(bodies[0])
      const response = yield* request(`${path}?random`, "gzip")
      expect(response.headers["content-encoding"]).toBeUndefined()
      expect(response.body).toEqual(bodies[1])
    }),
  )

  it.live("uses serialized byte threshold and keeps oversized record progress intact", () =>
    Effect.gen(function* () {
      yield* serve((r) =>
        HttpServerResponse.text(
          `"${"x".repeat(Number(new URL(r.url, "http://fixture").searchParams.get("bytes")) - 2)}"`,
          { contentType: "application/json" },
        ),
      )
      for (const bytes of [1023, 1024, 300_000]) {
        const response = yield* request(`${path}?bytes=${bytes}`, "gzip")
        expect(response.status).toBe(200)
        expect(response.headers["content-encoding"]).toBe(bytes >= 1024 ? "gzip" : undefined)
        const decoded = bytes >= 1024 ? gunzipSync(response.body) : response.body
        expect(decoded.byteLength).toBe(bytes)
        expect(JSON.parse(decoded.toString())).toBe("x".repeat(bytes - 2))
      }
    }),
  )

  it.live("never transforms errors, pre-encoded bodies, no-transform, streams, or SSE", () =>
    Effect.gen(function* () {
      yield* serve((r) => {
        const mode = new URL(r.url, "http://fixture").searchParams.get("mode")
        if (mode === "stream")
          return HttpServerResponse.stream(Stream.fromIterable([Buffer.from(JSON.stringify(payload))]), {
            contentType: "application/json",
          })
        if (mode === "sse")
          return HttpServerResponse.text(`data: ${JSON.stringify(payload)}\n\n`, { contentType: "text/event-stream" })
        if (mode === "empty") return HttpServerResponse.empty({ status: 204 })
        if (mode === "reset") return HttpServerResponse.empty({ status: 205 })
        if (mode === "not-modified") return HttpServerResponse.empty({ status: 304 })
        return HttpServerResponse.jsonUnsafe(payload, {
          status: mode === "error" ? 500 : 200,
          headers:
            mode === "encoded"
              ? { "content-encoding": "br" }
              : mode === "no-transform"
                ? { "cache-control": "private, no-transform" }
                : {},
        })
      })
      for (const mode of ["stream", "sse", "empty", "reset", "not-modified", "error", "encoded", "no-transform"]) {
        const response = yield* request(`${path}?mode=${mode}`, "gzip")
        expect(response.headers["content-encoding"]).toBe(mode === "encoded" ? "br" : undefined)
        expect(response.headers["cache-control"]).toBe(mode === "no-transform" ? "no-store, no-transform" : "no-store")
        if (["empty", "reset", "not-modified"].includes(mode)) expect(response.body.byteLength).toBe(0)
        if (!["empty", "reset", "not-modified", "sse"].includes(mode))
          expect(JSON.parse(response.body.toString())).toEqual(payload)
      }
      const head = yield* request(path, "gzip", { method: "HEAD" })
      expect(head.headers["content-encoding"]).toBeUndefined()
      expect(head.body.byteLength).toBe(0)
    }),
  )

  it.live("never double compresses existing gzip and limits compression to JSON media types", () =>
    Effect.gen(function* () {
      const compressed = gzipSync(Buffer.from(JSON.stringify(payload)))
      yield* serve((r) => {
        const type = new URL(r.url, "http://fixture").searchParams.get("type")
        if (type === "encoded")
          return HttpServerResponse.uint8Array(compressed, {
            contentType: "application/json",
            headers: { "content-encoding": "gzip" },
          })
        return HttpServerResponse.jsonUnsafe(payload, { contentType: type ?? "application/json" })
      })
      for (const type of [
        "encoded",
        "application/problem+json",
        "application/json; charset=utf-8",
        "application/jsonp",
        "text/plain",
      ]) {
        const response = yield* request(`${path}?type=${encodeURIComponent(type)}`, "gzip")
        const gzip =
          type === "encoded" || type.startsWith("application/problem+json") || type.startsWith("application/json;")
        expect(response.headers["content-encoding"]).toBe(gzip ? "gzip" : undefined)
        expect(JSON.parse((gzip ? gunzipSync(response.body) : response.body).toString())).toEqual(payload)
        if (type === "encoded") expect(response.body).toEqual(compressed)
      }
    }),
  )

  it.live("preserves auth rejection and challenges without compressing", () =>
    Effect.gen(function* () {
      yield* serve(() => HttpServerResponse.jsonUnsafe(payload))
      const response = yield* request(path, "gzip", { unauthorized: true })
      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"]).toBe('Basic realm="Secure Area"')
      expect(response.headers["content-encoding"]).toBeUndefined()
      expect(response.body.byteLength).toBe(0)
    }),
  )

  it.live("leaves generic routes and other methods unchanged", () =>
    Effect.gen(function* () {
      yield* serve(() => HttpServerResponse.jsonUnsafe(payload))
      for (const outside of [
        "/config",
        `${path}/extra`,
        "/session/a/b/transcript/changes",
        "/session/transcript/changes",
      ]) {
        const response = yield* request(outside, "gzip;q=0")
        expect(response.headers["content-encoding"]).toBe("gzip")
        expect(response.headers["cache-control"]).toBeUndefined()
        expect(response.headers.vary).toBeUndefined()
      }
      const response = yield* request(path, "gzip;q=0", { method: "POST" })
      expect(response.headers["content-encoding"]).toBe("gzip")
      expect(response.headers["cache-control"]).toBeUndefined()
    }),
  )
})
