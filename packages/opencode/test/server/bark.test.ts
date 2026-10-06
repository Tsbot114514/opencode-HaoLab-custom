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
import { execFile as execFileCallback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { withTimeout } from "@/util/timeout"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Project.defaultLayer))

describe("Bark", () => {
  test("persists a private key and legacy push URL", async () => {
    await using dir = await tmpdir()
    const original = Global.Path.data
    Global.Path.data = dir.path
    try {
      expect(await Bark.configured()).toEqual({ configured: false, endpoint: "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" })
      expect(await Bark.setKey("invalid/token")).toBe(false)
      expect(await Bark.setKey("test_device_123")).toBe(true)
      if (process.platform === "win32") {
        const { stdout } = await promisify(execFileCallback)("icacls", [path.join(dir.path, "bark-key")])
        expect(stdout).not.toContain("(I)")
      } else {
        expect((await fs.stat(path.join(dir.path, "bark-key"))).mode & 0o777).toBe(0o600)
      }
      expect(await Bark.configured()).toEqual({ configured: true, endpoint: "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" })
      const requests: { url: string; options?: RequestInit }[] = []
      const fake = (async (url: string | URL | Request, options?: RequestInit) => {
        requests.push({ url: String(url), options })
        return Response.json({ code: "80000000" })
      })
      expect(await Bark.test(fake)).toEqual({ success: true })
      expect(requests[0].url).toBe("https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php")
      expect(requests[0].options?.method).toBe("POST")
      expect(requests[0].options?.redirect).toBe("manual")
      expect(JSON.parse(String(requests[0].options?.body))).toEqual({
        token: "test_device_123", title: "OpenCode test", msg: "Bark notifications are working.",
        url: "", issecure: 0, sender: "OpenCode",
      })
      expect(await Bark.test(async () => Response.json({ code: 80000000 }))).toEqual({ success: true })
      expect(await Bark.test(async () => Response.json({ code: 400 }))).toEqual({ success: false })
      expect(await Bark.test(async () => Response.json({ code: 300, message: "请求过于频繁，对方是普通用户1小时内最多接收3次推送" }))).toEqual({ success: false, reason: "rate_limit" })
      expect(await Bark.send("test", "test", async () => Response.json({ code: 300, message: "请求过于频繁" }))).toBe(false)
      for (const endpoint of ["https://push.example/send\n", "curl -X DELETE 'https://push.example/send'", "curl -X POST 'https://push.example/send' --unknown"]) {
        expect(await Bark.setEndpoint(endpoint)).toBe(false)
      }
      expect(await Bark.setEndpoint("https://push.example/send?group=example&ttl=600")).toBe(true)
      expect(await Bark.setEndpoint("http://push.example/send")).toBe(true)
      expect(await Bark.setEndpoint("https://push.example/send")).toBe(true)
      expect(await Bark.configured()).toEqual({ configured: true, endpoint: "https://push.example/send" })
      expect(await Bark.test(fake)).toEqual({ success: true })
      expect(requests[1].url).toBe("https://push.example/send")
      await Bark.clearKey()
      expect(await Bark.configured()).toEqual({ configured: false, endpoint: "https://push.example/send" })
      if (process.platform === "win32") {
        await fs.writeFile(path.join(dir.path, "bark-key"), "legacy_key")
        expect(await Bark.configured()).toEqual({ configured: true, endpoint: "https://push.example/send" })
        const { stdout } = await promisify(execFileCallback)("icacls", [path.join(dir.path, "bark-key")])
        expect(stdout).not.toContain("(I)")
        await Bark.clearKey()
      }
    } finally {
      Global.Path.data = original
    }
  })

  test("runs GET and POST curl templates without executing a shell", async () => {
    await using dir = await tmpdir()
    const original = Global.Path.data
    Global.Path.data = dir.path
    try {
      const get = "curl -X GET https://api.day.app/example-key/{{title}}/{{body}}?group=example&ttl=600"
      const example = "curl -X GET https://api.day.app/example-key/title/body?group=example&ttl=600"
      await fs.writeFile(path.join(dir.path, "bark-endpoint"), example)
      expect(await Bark.configured()).toEqual({ configured: true, endpoint: get })
      expect(await Bark.setEndpoint(example)).toBe(true)
      expect(await Bark.configured()).toEqual({ configured: true, endpoint: get })
      const requests: { url: string; options?: RequestInit }[] = []
      const fetcher = async (url: string, options?: RequestInit) => {
        requests.push({ url, options })
        return Response.json({ code: 200 })
      }
      expect(await Bark.send('任务 "完成"', "结果/包含 空格", fetcher)).toBe(true)
      expect(requests[0].url).toBe("https://api.day.app/example-key/%E4%BB%BB%E5%8A%A1%20%22%E5%AE%8C%E6%88%90%22/%E7%BB%93%E6%9E%9C%2F%E5%8C%85%E5%90%AB%20%E7%A9%BA%E6%A0%BC?group=example&ttl=600")
      expect(requests[0].options?.method).toBe("GET")
      expect(requests[0].options?.body).toBeUndefined()
      if (process.platform === "win32") {
        const { stdout } = await promisify(execFileCallback)("icacls", [path.join(dir.path, "bark-endpoint")])
        expect(stdout).not.toContain("(I)")
      } else {
        expect((await fs.stat(path.join(dir.path, "bark-endpoint"))).mode & 0o777).toBe(0o600)
      }

      expect(await Bark.setKey("saved_device_key")).toBe(true)
      expect(await Bark.setEndpoint("curl -X GET 'https://api.day.app/{{token}}/{{title}}/{{body}}?group=example&ttl=600'")).toBe(true)
      expect(await Bark.send("Completed", "Details", fetcher)).toBe(true)
      expect(requests[1].url).toBe("https://api.day.app/saved_device_key/Completed/Details?group=example&ttl=600")
      const post = `curl -L -X POST 'https://push.example/send?group=example' -H 'Content-Type: application/json' --data-raw '{"token":"{{token}}","title":"{{title}}","msg":"{{body}}"}'`
      expect(await Bark.setEndpoint(post)).toBe(true)
      expect(await Bark.configured()).toEqual({ configured: true, endpoint: post })
      expect(await Bark.send('任务 "完成"', "结果/包含 空格", async (url, options) => {
        requests.push({ url, options })
        return Response.json({ code: "80000000" })
      })).toBe(true)
      expect(requests[2].url).toBe("https://push.example/send?group=example")
      expect(requests[2].options?.method).toBe("POST")
      expect(requests[2].options?.redirect).toBe("follow")
      expect(requests[2].options?.headers).toEqual({ "Content-Type": "application/json" })
      expect(JSON.parse(String(requests[2].options?.body))).toEqual({ token: "saved_device_key", title: '任务 "完成"', msg: "结果/包含 空格" })
      await Bark.clearKey()
      expect(await Bark.configured()).toEqual({ configured: false, endpoint: post })
    } finally {
      Global.Path.data = original
    }
  })

  it.instance("identifies sessions and distinguishes asks, completion, interruption and errors", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
       const root = yield* session.create({ title: "通知测试会话" })
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
        expect(sent.map((value) => value.split(":")[0])).toEqual([
          "OpenCode · 请求权限", "OpenCode · 等待回答", "OpenCode · 本轮完成",
        ])
        expect(sent.every((value) => value.includes(root.title) && value.includes(root.id.slice(-8)))).toBe(true)
        expect(JSON.stringify(sent)).not.toContain("SECRET")
        yield* session.updateMessage({ ...msg, error: { name: "MessageAbortedError", data: { message: "Aborted" } } })
        emit("session.status", root.id, { status: { type: "busy" } })
        emit("session.status", root.id, { status: { type: "idle" } })
        expect(sent).toHaveLength(4)
        expect(sent[3]).toContain("OpenCode · 已中断")
        emit("session.status", root.id, { status: { type: "busy" } })
        emit("session.error", root.id, { error: { name: "UnknownError", data: { message: "SECRET" } } })
        emit("session.status", root.id, { status: { type: "idle" } })
        expect(sent).toHaveLength(5)
        expect(sent[4]).toContain("OpenCode · 运行出错")
        emit("session.error", child.id, { error: { name: "UnknownError", data: { message: "SECRET" } } })
        expect(sent).toHaveLength(5)
        const interrupted = yield* session.create({ title: "中断事件测试" })
        emit("session.status", interrupted.id, { status: { type: "busy" } })
        emit("session.error", interrupted.id, { error: { name: "MessageAbortedError", data: { message: "SECRET" } } })
        emit("session.status", interrupted.id, { status: { type: "idle" } })
        expect(sent).toHaveLength(6)
        expect(sent[5]).toContain("OpenCode · 已中断")
        expect(sent[5]).toContain(interrupted.title)
        expect(JSON.stringify(sent)).not.toContain("SECRET")
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
      expect(await (await request("GET")).json()).toEqual({ configured: false, endpoint: "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" })
      expect((await request("PUT", { key: "bad/key" })).status).toBe(400)
      expect(await (await request("PUT", { key: "test_device_123" })).json()).toEqual({ configured: true, endpoint: "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" })
      expect(await (await request("GET")).json()).toEqual({ configured: true, endpoint: "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" })
      const delivered = Promise.withResolvers<void>()
      const pushes: string[] = []
      const targets: string[] = []
      let rateLimited = false
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input) !== "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php" && String(input) !== "https://push.example/send") return originalFetch(input, init)
          expect(init?.method).toBe("POST")
          expect(init?.redirect).toBe("manual")
          expect(JSON.parse(String(init?.body)).token).toBe("test_device_123")
          targets.push(String(input))
          pushes.push(JSON.parse(String(init?.body)).title)
          delivered.resolve()
          if (rateLimited) return Response.json({ code: 300, message: "请求过于频繁" })
          return Response.json({ code: "80000000" })
        },
        { preconnect: originalFetch.preconnect },
      )
      // A real event proves that accepting a reused listener does not conceal
      // a missing subscription when this test runs alone or after another suite.
      const created = await (await originalFetch(new URL(`/session?directory=${encodeURIComponent(dir.path)}`, listener.url), {
        method: "POST", headers: { authorization: `Basic ${btoa("opencode:bark-test-password")}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "通知路由测试" }),
      })).json()
      GlobalBus.emit("event", { payload: {
        type: "permission.asked",
        properties: { sessionID: SessionID.make(created.id), id: "bark-route-lifecycle" },
      } })
      await withTimeout(delivered.promise, 5_000, "Bark event was not delivered")
      expect(pushes).toEqual(["OpenCode · 请求权限"])
      expect(await (await originalFetch(new URL("/global/notifications/bark/test", listener.url), {
        method: "POST", headers: { authorization: `Basic ${btoa("opencode:bark-test-password")}` },
      })).json()).toEqual({ success: true })
      rateLimited = true
      expect(await (await originalFetch(new URL("/global/notifications/bark/test", listener.url), {
        method: "POST", headers: { authorization: `Basic ${btoa("opencode:bark-test-password")}` },
      })).json()).toEqual({ success: false, reason: "rate_limit" })
      expect((await request("PATCH", { endpoint: "https://push.example/send" }, false)).status).toBe(401)
      expect((await request("PATCH", { endpoint: "curl -X DELETE 'https://push.example/send'" })).status).toBe(400)
      expect(await (await request("PATCH", { endpoint: "https://push.example/send" })).json()).toEqual({ configured: true, endpoint: "https://push.example/send" })
      expect(await (await request("GET")).json()).toEqual({ configured: true, endpoint: "https://push.example/send" })
      expect(await (await originalFetch(new URL("/global/notifications/bark/test", listener.url), {
        method: "POST", headers: { authorization: `Basic ${btoa("opencode:bark-test-password")}` },
      })).json()).toEqual({ success: false, reason: "rate_limit" })
      expect(targets.at(-1)).toBe("https://push.example/send")
      const sample = "curl -X GET 'https://api.day.app/test_device_123/title/body?group=example&ttl=600'"
      const normalized = "curl -X GET 'https://api.day.app/test_device_123/{{title}}/{{body}}?group=example&ttl=600'"
      expect(await (await request("PATCH", { endpoint: sample })).json()).toEqual({ configured: true, endpoint: normalized })
      expect(await (await request("GET")).json()).toEqual({ configured: true, endpoint: normalized })
      expect(await (await request("DELETE")).json()).toEqual({ configured: true, endpoint: normalized })
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
