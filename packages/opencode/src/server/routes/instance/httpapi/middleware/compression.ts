import { deflateSync, gzipSync } from "node:zlib"
import { Effect } from "effect"
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// Keep the server's compressible content-type set stable across HTTP backend changes.
const COMPRESSIBLE_CONTENT_TYPE_REGEX =
  /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i

const NO_TRANSFORM_REGEX = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i

const STREAMING_PATHS = new Set(["/event", "/global/event"])
const STREAMING_POST_REGEX = /^\/session\/[^/]+\/(?:message|prompt_async)$/
const TRANSCRIPT_FEED_REGEX = /^\/session\/[^/]+\/transcript\/(?:snapshot|changes)$/

const THRESHOLD_BYTES = 1024

type Encoding = "gzip" | "deflate"

function pickEncoding(acceptEncoding: string | undefined): Encoding | undefined {
  if (!acceptEncoding) return undefined
  const lower = acceptEncoding.toLowerCase()
  if (lower.includes("gzip")) return "gzip"
  if (lower.includes("deflate")) return "deflate"
  return undefined
}

function pathOf(url: string): string {
  const queryIndex = url.indexOf("?")
  return queryIndex === -1 ? url : url.slice(0, queryIndex)
}

function acceptsFeedGzip(header: string | undefined) {
  if (!header) return false
  const codings = header.split(",").map((value) => {
    const name = value.split(";", 1)[0].trim().toLowerCase()
    const match = /^(?:gzip|identity|\*)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(value.trim())
    return { name, quality: match ? Number(match[1] ?? 1) : 0 }
  })
  const gzip = codings.filter((coding) => coding.name === "gzip")
  const wildcard = codings.filter((coding) => coding.name === "*")
  // Explicit exclusions (including malformed qualities) must override a wildcard.
  const quality = Math.min(...(gzip.length ? gzip : wildcard).map((coding) => coding.quality), 1)
  if (!gzip.length && !wildcard.length) return false
  return (
    quality > 0 &&
    quality >= Math.max(...codings.filter((coding) => coding.name === "identity").map((coding) => coding.quality), 0)
  )
}

export const compressionLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest

    if (request.method === "GET" && TRANSCRIPT_FEED_REGEX.test(pathOf(request.url))) {
      const vary = response.headers["vary"]
      const tokens = vary?.split(",").map((token) => token.trim().toLowerCase())
      const noTransform = NO_TRANSFORM_REGEX.test(response.headers["cache-control"] ?? "")
      const feed = HttpServerResponse.setHeaders(response, {
        "cache-control": noTransform ? "no-store, no-transform" : "no-store",
        vary:
          tokens?.includes("*") || tokens?.includes("accept-encoding")
            ? vary
            : vary
              ? `${vary}, Accept-Encoding`
              : "Accept-Encoding",
      })
      const body = feed.body
      if (feed.status < 200 || feed.status >= 300 || feed.status === 204 || feed.status === 205) return feed
      if (feed.headers["content-encoding"] || feed.headers["transfer-encoding"] || noTransform) return feed
      if (body._tag !== "Uint8Array" || body.body.byteLength < THRESHOLD_BYTES) return feed
      if (!/^\s*application\/(?:json|[^;\s]+\+json)(?:[;\s]|$)/i.test(body.contentType)) return feed
      if (!acceptsFeedGzip(request.headers["accept-encoding"])) return feed

      // The feed's 256 KiB target is soft; oversized records must still make progress.
      const compressed = gzipSync(body.body)
      if (compressed.byteLength >= body.body.byteLength) return feed
      return HttpServerResponse.setHeader(
        HttpServerResponse.setBody(feed, HttpBody.uint8Array(compressed, body.contentType)),
        "content-encoding",
        "gzip",
      )
    }

    if (request.method === "HEAD") return response
    if (response.headers["content-encoding"]) return response
    if (response.headers["transfer-encoding"]) return response

    const body = response.body
    if (body._tag !== "Uint8Array") return response
    if (body.body.byteLength < THRESHOLD_BYTES) return response

    const cacheControl = response.headers["cache-control"]
    if (cacheControl && NO_TRANSFORM_REGEX.test(cacheControl)) return response

    const path = pathOf(request.url)
    if (STREAMING_PATHS.has(path)) return response
    if (request.method === "POST" && STREAMING_POST_REGEX.test(path)) return response

    const contentType = body.contentType
    if (!COMPRESSIBLE_CONTENT_TYPE_REGEX.test(contentType)) return response

    const encoding = pickEncoding(request.headers["accept-encoding"])
    if (!encoding) return response

    const compressed = encoding === "gzip" ? gzipSync(body.body) : deflateSync(body.body)
    return HttpServerResponse.setHeader(
      HttpServerResponse.setBody(response, HttpBody.uint8Array(compressed, contentType)),
      "content-encoding",
      encoding,
    )
  }),
).layer
