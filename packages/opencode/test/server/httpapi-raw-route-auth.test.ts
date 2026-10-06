import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionID } from "../../src/session/schema"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { PtyID } from "../../src/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

function app(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi raw route authorization", () => {
  test("requires configured auth before accessing transcript endpoints", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-opencode-directory": tmp.path }
    const id = SessionID.descending()
    for (const route of [
      SessionPaths.transcriptSnapshot.replace(":sessionID", id),
      SessionPaths.transcriptChanges.replace(":sessionID", id) + "?cursor=invalid",
    ]) {
      expect((await server.request(route, { headers })).status).toBe(401)
      expect(
        (await server.request(route, { headers: { ...headers, authorization: basic("opencode", "wrong") } })).status,
      ).toBe(401)
      const authed = await server.request(route, {
        headers: { ...headers, authorization: basic("opencode", "secret") },
      })
      expect([400, 404]).toContain(authed.status)
      expect(authed.headers.get("x-opencode-transcript-feed")).toBe("1")
    }
  })

  test("requires configured auth before opening the raw instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the raw PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})
