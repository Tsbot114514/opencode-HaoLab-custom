import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalBus } from "@/bus/global"
import { Bark } from "@/server/bark"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Project } from "@/project/project"
import { ProviderID, ModelID } from "@/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import fs from "node:fs/promises"
import path from "node:path"
import { withTimeout } from "@/util/timeout"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Project.defaultLayer))

describe("Bark", () => {
  test("persists a private key and sends only to the fixed HTTPS endpoint", async () => {
    await using dir = await tmpdir()
    const original = Global.Path.data
    Global.Path.data = dir.path
    try {
      expect(await Bark.configured()).toEqual({ configured: false })
      expect(await Bark.setKey("invalid/token")).toBe(false)
      expect(await Bark.setKey("test_device_123")).toBe(true)
      expect((await fs.stat(path.join(dir.path, "bark-key"))).mode & 0o777).toBe(0o600)
      expect(await Bark.configured()).toEqual({ configured: true })
      const requests: { url: string; options?: RequestInit }[] = []
      const fake = (async (url: string | URL | Request, options?: RequestInit) => {
        requests.push({ url: String(url), options })
        return Response.json({ code: 200 })
      })
      expect(await Bark.test(fake)).toEqual({ success: true })
      expect(requests[0].url).toBe("https://api.day.app/push")
      expect(requests[0].options?.method).toBe("POST")
      expect(JSON.parse(String(requests[0].options?.body))).toEqual({
        device_key: "test_device_123", title: "OpenCode test", body: "Bark notifications are working.", group: "OpenCode",
      })
      expect(await Bark.test(async () => Response.json({ code: 400 }))).toEqual({ success: false })
      await Bark.clearKey()
      expect(await Bark.configured()).toEqual({ configured: false })
    } finally {
      Global.Path.data = original
    }
  })

  it.instance("sends generic asks and only successful root transitions once", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create()
      const child = yield* session.create({ parentID: root.id })
      const sent: string[] = []
      const unsubscribe = Bark.subscribe(async (title, body) => {
        sent.push(`${title}:${body}`)
        return true
      })
      try {
        const emit = (type: string, sessionID: string, properties: Record<string, unknown>) =>
          GlobalBus.emit("event", { payload: { type, properties: { sessionID, ...properties } } })
        emit("permission.asked", root.id, { id: "ask1", prompt: "SECRET" })
        emit("permission.asked", root.id, { id: "ask1", prompt: "SECRET" })
        emit("question.asked", root.id, { id: "ask2", questions: ["SECRET"] })
        emit("session.status", root.id, { status: { type: "idle" } })
        emit("session.status", child.id, { status: { type: "busy" } })
        emit("session.status", child.id, { status: { type: "idle" } })
        const msg = {
          id: MessageID.ascending(), sessionID: root.id, role: "assistant" as const,
          parentID: MessageID.ascending(), modelID: ModelID.make("test"), providerID: ProviderID.make("test"),
          mode: "build", agent: "build", path: { cwd: root.directory, root: root.directory },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() }, finish: "end_turn",
        }
        yield* session.updateMessage(msg)
        emit("session.status", root.id, { status: { type: "busy" } })
        emit("session.status", root.id, { status: { type: "retry" } })
        emit("session.status", root.id, { status: { type: "idle" } })
        emit("session.status", root.id, { status: { type: "idle" } })
        expect(sent).toEqual([
          "Permission needed:OpenCode needs your attention.",
          "Question waiting:OpenCode needs your attention.",
          "Task completed:OpenCode needs your attention.",
        ])
        expect(JSON.stringify(sent)).not.toContain("SECRET")
        yield* session.updateMessage({ ...msg, error: { name: "MessageAbortedError", data: { message: "Aborted" } } })
        emit("session.status", root.id, { status: { type: "busy" } })
        emit("session.status", root.id, { status: { type: "idle" } })
        expect(sent).toHaveLength(3)
      } finally {
        unsubscribe()
      }
    }),
  )

  test("authenticated global routes expose status, not credentials", async () => {
    await using dir = await tmpdir()
    const original = Global.Path.data
    const password = Flag.OPENCODE_SERVER_PASSWORD
    const envPassword = process.env.OPENCODE_SERVER_PASSWORD
    const originalFetch = globalThis.fetch
    Global.Path.data = dir.path
    Flag.OPENCODE_SERVER_PASSWORD = "bark-test-password"
    process.env.OPENCODE_SERVER_PASSWORD = "bark-test-password"
    const before = GlobalBus.listeners("event")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      // Other API tests may already hold the process-wide Bark layer open.
      const registered = GlobalBus.listeners("event")
      expect(registered.filter((handler) => !before.includes(handler)).length).toBeLessThanOrEqual(1)
      const second = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        expect(GlobalBus.listeners("event")).toEqual(registered)
      } finally {
        await second.stop()
      }
      expect(GlobalBus.listeners("event")).toEqual(registered)
      const url = new URL("/global/notifications/bark", listener.url)
      const request = (method: string, body?: object, authorized = true) => fetch(url, {
        method,
        headers: {
          ...(authorized ? { authorization: `Basic ${btoa("opencode:bark-test-password")}` } : {}),
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect((await request("GET", undefined, false)).status).toBe(401)
      expect(await (await request("GET")).json()).toEqual({ configured: false })
      expect((await request("PUT", { key: "bad/key" })).status).toBe(400)
      expect(await (await request("PUT", { key: "test_device_123" })).json()).toEqual({ configured: true })
      expect(await (await request("GET")).json()).toEqual({ configured: true })
      const delivered = Promise.withResolvers<void>()
      const pushes: string[] = []
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input) !== "https://api.day.app/push") return originalFetch(input, init)
          expect(init?.method).toBe("POST")
          expect(JSON.parse(String(init?.body)).device_key).toBe("test_device_123")
          pushes.push(JSON.parse(String(init?.body)).title)
          delivered.resolve()
          return Response.json({ code: 200 })
        },
        { preconnect: originalFetch.preconnect },
      )
      // A real event proves that accepting a reused listener does not conceal
      // a missing subscription when this test runs alone or after another suite.
      GlobalBus.emit("event", { payload: {
        type: "permission.asked",
        properties: { sessionID: SessionID.descending(), id: "bark-route-lifecycle" },
      } })
      await withTimeout(delivered.promise, 5_000, "Bark event was not delivered")
      expect(pushes).toEqual(["Permission needed"])
      expect(await (await originalFetch(new URL("/global/notifications/bark/test", listener.url), {
        method: "POST", headers: { authorization: `Basic ${btoa("opencode:bark-test-password")}` },
      })).json()).toEqual({ success: true })
      expect(await (await request("DELETE")).json()).toEqual({ configured: false })
    } finally {
      globalThis.fetch = originalFetch
      await listener.stop()
      Global.Path.data = original
      Flag.OPENCODE_SERVER_PASSWORD = password
      if (envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = envPassword
      expect(GlobalBus.listeners("event")).toEqual(before)
    }
  })
})
