import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createMobileTranscriptStorage } from "./mobile-transcript-storage"
import { createTranscriptCache } from "../context/global-sync/transcript-cache"
import { createDirSyncContext } from "../context/directory-sync"
import { clearSessionPrefetchDirectory } from "../context/global-sync/session-prefetch"
import type { State } from "../context/global-sync/types"

const scope = `tunnel.v1.${"a".repeat(64)}`
const native = (
  postMessage: (request: { operation: string; scope: string; document: string; value?: string }) => Promise<unknown>,
) => ({
  __HAOLAB_MOBILE__: true,
  __HAOLAB_TRANSCRIPTS__: { scope, document: "document-1" },
  webkit: { messageHandlers: { haolabTranscripts: { postMessage } } },
})

describe("mobile transcript storage", () => {
  test("requires a valid mobile capability and reply handler", () => {
    for (const input of [
      undefined,
      null,
      {},
      { __HAOLAB_MOBILE__: true },
      { ...native(async () => null), __HAOLAB_MOBILE__: false },
      { ...native(async () => null), webkit: {} },
      ...["sidecar.v1", scope.toUpperCase(), scope + "\n", "tunnel.v1.a"].map((scope) => ({
        ...native(async () => null),
        __HAOLAB_TRANSCRIPTS__: { scope, document: "doc" },
      })),
      ...[undefined, null, "", "   ", 1].map((document) => ({
        ...native(async () => null),
        __HAOLAB_TRANSCRIPTS__: { scope, document },
      })),
    ])
      expect(createMobileTranscriptStorage(input)).toBeUndefined()
    expect(createMobileTranscriptStorage(native(async () => null))?.scope).toBe(scope)
  })

  test("sends scoped payloads and captures document identity and handler", async () => {
    const calls: unknown[] = []
    const host = native(async (request) => {
      calls.push(request)
      return request.operation === "get" ? "saved" : null
    })
    const adapter = createMobileTranscriptStorage(host)!
    host.__HAOLAB_TRANSCRIPTS__.document = "document-2"
    host.webkit.messageHandlers.haolabTranscripts.postMessage = async () => {
      throw new Error("replaced")
    }
    expect(await adapter.storage.getItem(scope)).toBe("saved")
    await adapter.storage.setItem(scope, "value")
    await adapter.storage.removeItem(scope)
    expect(calls).toEqual([
      { operation: "get", scope, document: "document-1" },
      { operation: "set", scope, document: "document-1", value: "value" },
      { operation: "remove", scope, document: "document-1" },
    ])
    await expect(adapter.storage.getItem("other")).rejects.toThrow("Native transcript storage unavailable")
    expect(calls).toHaveLength(3)
  })

  test("enforces 16 MiB UTF-8 limits on writes and reads", async () => {
    const limit = "\u00e9".repeat(8 * 1024 * 1024)
    let calls = 0
    const adapter = createMobileTranscriptStorage(
      native(async (request) => {
        calls++
        return request.operation === "get" ? limit : null
      }),
    )!
    await adapter.storage.setItem(scope, limit)
    expect(await adapter.storage.getItem(scope)).toBe(limit)
    await expect(adapter.storage.setItem(scope, limit + "x")).rejects.toThrow()
    expect(calls).toBe(2)
    const oversized = createMobileTranscriptStorage(native(async () => limit + "x"))!
    await expect(oversized.storage.getItem(scope)).rejects.toThrow()
  })

  test("normalizes native failures, malformed replies and timeouts", async () => {
    for (const reply of [
      async () => {
        throw new Error("private native detail")
      },
      () => {
        throw new Error("sync failure")
      },
      async () => 123,
      () => new Promise<never>(() => {}),
    ]) {
      const adapter = createMobileTranscriptStorage(native(reply), 5)!
      await expect(adapter.storage.getItem(scope)).rejects.toThrow("Native transcript storage unavailable")
    }
    const adapter = createMobileTranscriptStorage(native(async () => "invalid"))!
    await expect(adapter.storage.setItem(scope, "value")).rejects.toThrow()
    await expect(adapter.storage.removeItem(scope)).rejects.toThrow()
    expect(await createMobileTranscriptStorage(native(async () => null))!.storage.getItem(scope)).toBeNull()
  })

  test("shared async cache restarts, hydrates 20 messages and serves older history locally", async () => {
    let saved: string | null = null
    const bridge = () =>
      createMobileTranscriptStorage(
        native(async (request) => {
          if (request.operation === "get") return saved
          saved = request.operation === "set" ? request.value! : null
          return null
        }),
      )!
    const first = bridge()
    const original = createTranscriptCache(first.storage, first.scope)
    await original.ready
    const session: Message[] = Array.from({ length: 45 }, (_, index) => ({
      id: `mobile_m${index}`,
      sessionID: "mobile_s",
      role: "user",
      time: { created: index },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    }))
    const part = session.map((message) => ({
      id: message.id,
      part: [
        {
          id: `part_${message.id}`,
          sessionID: message.sessionID,
          messageID: message.id,
          type: "text",
          text: `body ${message.time.created}`,
        } satisfies Part,
      ],
    }))
    original.write("/mobile", "mobile_s", { session, part, complete: true })
    await original.flush()
    original.dispose()
    await original.flush()
    const second = bridge()
    const cache = createTranscriptCache(second.storage, second.scope)
    await cache.ready
    clearSessionPrefetchDirectory("/mobile")
    const app = createRoot((dispose) => {
      const [store, setStore] = createStore({
        session: [{ id: "mobile_s", directory: "/mobile", time: { created: 0, updated: 1 } }],
        message: {},
        part: {},
        part_text_accum_delta: {},
        path: { directory: "/mobile" },
        status: "complete",
        todo: {},
        session_diff: {},
        permission: {},
        question: {},
        session_status: {},
      } as unknown as State)
      let requests = 0
      const client = createOpencodeClient({
        baseUrl: "http://mobile-transcripts.test",
        throwOnError: true,
        fetch: Object.assign(
          async () => {
            requests++
            return new Response("offline", { status: 503 })
          },
          { preconnect: fetch.preconnect },
        ),
      })
      const sync = createDirSyncContext(client, "/mobile", {
        child: () => [store, setStore],
        todo: { set: () => undefined },
        data: { project: [], session_todo: {} },
        transcript: cache,
      })
      return { sync, store, dispose, requests: () => requests }
    })
    await app.sync.session.sync("mobile_s").catch(() => undefined)
    expect(app.store.message.mobile_s?.map((message) => message.id)).toEqual(
      session.slice(-20).map((message) => message.id),
    )
    expect(app.store.part.mobile_m44?.[0]).toEqual(part[44].part[0])
    const requests = app.requests()
    await app.sync.session.history.loadMore("mobile_s")
    expect(app.store.message.mobile_s?.length).toBe(40)
    await app.sync.session.history.loadMore("mobile_s")
    expect(app.store.message.mobile_s?.length).toBe(45)
    // Hydrated history is provisional. Failed lazy checks must stay bounded and never discard local pages.
    expect(app.requests()).toBeLessThanOrEqual(requests + 6)
    app.dispose()
    cache.dispose()
    await cache.flush()
  })

  test("native failures remain observable and recovery persists assistant tools with Windows paths", async () => {
    let saved: string | null = null
    let readFails = true
    let writeFailures = 1
    let writes = 0
    const adapter = createMobileTranscriptStorage(
      native(async (request) => {
        if (request.operation === "get") {
          if (readFails) throw new Error("read rejected")
          return saved
        }
        writes++
        if (writeFailures-- > 0) throw new Error("write rejected")
        saved = request.value!
        return null
      }),
    )!
    const cache = createTranscriptCache(adapter.storage, adapter.scope)
    await cache.ready
    expect(cache.persistenceError()?.operation).toBe("read")
    const assistant: Message = {
      id: "assistant_1",
      sessionID: "s",
      role: "assistant",
      parentID: "user_1",
      time: { created: 2, completed: 3 },
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: "C:\\work", root: "C:\\work" },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
    }
    const tool: Part = {
      id: "tool_1",
      messageID: assistant.id,
      sessionID: "s",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "C:\\work",
        title: "Working directory",
        metadata: {},
        time: { start: 2, end: 3 },
      },
    }
    const page = {
      session: [assistant],
      part: [{ id: assistant.id, part: [tool] }],
      complete: true,
    }
    cache.write("C:\\work", "s", page)
    await cache.flush()
    expect(writes).toBe(0)
    expect(saved).toBeNull()
    readFails = false
    const flushing = cache.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cache.persistenceError()?.operation).toBe("write")
    expect(saved).toBeNull()
    await flushing
    expect(writes).toBe(2)
    expect(cache.persistenceError()).toBeUndefined()
    expect(JSON.parse(saved!).entries[0]).toMatchObject({ directory: "C:\\work", ...page })
    cache.dispose()
    await cache.flush()
    const restarted = createTranscriptCache(adapter.storage, adapter.scope)
    await restarted.ready
    expect(restarted.read("C:\\work", "s")).toEqual(page)
    restarted.dispose()
    await restarted.flush()
  })
})
