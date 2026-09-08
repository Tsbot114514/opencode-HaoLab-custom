import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createOpencodeClient, type Message, type Part, type Session, type Todo } from "@opencode-ai/sdk/v2/client"
import { createDirSyncContext } from "../directory-sync"
import { projectRestoreDirectories, resetProjectSessions } from "./project-restore"
import {
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch"
import type { State } from "./types"

function fixture(directory: string) {
  return createRoot((dispose) => {
    const session = (title: string): Session => ({
      id: "ses_same",
      slug: "same",
      projectID: "global",
      directory,
      title,
      version: "1",
      time: { created: 1, updated: 2 },
    })
    const message: Message = {
      id: "msg_same",
      sessionID: "ses_same",
      role: "user",
      time: { created: 1 },
      agent: "assistant",
      model: { providerID: "test", modelID: "test" },
    }
    const part = (text: string): Part => ({
      id: "prt_same",
      sessionID: "ses_same",
      messageID: "msg_same",
      type: "text",
      text,
    })
    const [store, setStore] = createStore<State>({
      status: "complete",
      agent: [],
      command: [],
      project: "global",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider: { all: new Map(), connected: [], default: {} },
      config: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      session_working: () => false,
      session: [session("A"), { ...session("A only"), id: "ses_deleted" }],
      sessionTotal: 2,
      message: { ses_same: [message] },
      part: { msg_same: [part("A")] },
      part_text_accum_delta: { prt_same: "old delta" },
      session_diff: { ses_same: [] },
      todo: { ses_same: [] },
      session_status: { ses_same: { type: "idle" } },
      permission: { ses_same: [] },
      question: { ses_same: [] },
      limit: 10,
      path: { directory, home: "/", state: "/state", data: "/data", config: "/config", worktree: directory },
    })
    const todos = new Map<string, Todo[]>([
      ["ses_same", []],
      ["ses_deleted", []],
    ])
    const calls: string[] = []
    const sessionMeta = new Map([
      [directory, { limit: 60 }],
      ["/unrelated", { limit: 60 }],
    ])
    const sessionLoads = new Map([
      [directory, Promise.resolve()],
      ["/unrelated", Promise.resolve()],
    ])
    const clearedQueries: string[] = []
    const held = new Map<string, { started: PromiseWithResolvers<void>; response: PromiseWithResolvers<void> }>()
    let title = "B"
    const client = createOpencodeClient({
      baseUrl: "http://migration.test",
      throwOnError: true,
      fetch: Object.assign(
        async (request: RequestInfo | URL) => {
          const endpoint = new URL(request instanceof Request ? request.url : String(request)).pathname
          calls.push(endpoint)
          const value = title
          const gate = held.get(endpoint)
          if (gate) {
            held.delete(endpoint)
            gate.started.resolve()
            await gate.response.promise
          }
          const body = endpoint.endsWith("/message")
            ? [{ info: message, parts: [part(value)] }]
            : endpoint.endsWith("/diff")
              ? [{ file: value, patch: `+${value}`, additions: 1, deletions: 0 }]
              : endpoint.endsWith("/todo")
                ? [{ content: value, status: "pending", priority: "high" }]
                : endpoint === "/session"
                  ? [session(value), { ...session("B only"), id: "ses_new" }]
                  : session(value)
          return Response.json(body)
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const sync = createDirSyncContext(client, directory, {
      child: () => [store, setStore],
      data: {
        project: [],
        get session_todo() {
          return Object.fromEntries(todos)
        },
      },
      todo: {
        set: (id, items) => {
          if (items) todos.set(id, items)
          else todos.delete(id)
        },
      },
    })
    setSessionPrefetch({ directory, sessionID: "ses_same", limit: 80, cursor: "A cursor", complete: false })
    return {
      store,
      setStore,
      sync,
      todos,
      calls,
      client,
      sessionMeta,
      sessionLoads,
      clearedQueries,
      hold(endpoint: string) {
        const gate = { started: Promise.withResolvers<void>(), response: Promise.withResolvers<void>() }
        held.set(endpoint, gate)
        return gate
      },
      title(value: string) {
        title = value
      },
      reset(invalidate = true) {
        const sessions = invalidate ? sync.invalidate() : []
        resetProjectSessions({
          directory,
          store,
          setStore,
          sessionMeta,
          sessionLoads,
          clearTodo: (id) => todos.delete(id),
          clearQuery: (directory) => {
            clearedQueries.push(directory)
          },
        })
        return sessions
      },
      [Symbol.dispose]() {
        sync.invalidate()
        dispose()
      },
    }
  })
}

describe("project restore cache invalidation", () => {
  test("matches only the restored directory and descendants, including Windows aliases", () => {
    expect(
      projectRestoreDirectories({ type: "project.restored", properties: { directory: "D:\\Work\\A" } }, [
        "D:/Work/A",
        "d:/work/a/child",
        "D:/Work/A-other",
        "D:/Work",
        "E:/Work/A",
      ]),
    ).toEqual(["D:/Work/A", "d:/work/a/child"])
    expect(
      projectRestoreDirectories({ type: "project.restored", properties: { directory: "/work/A/" } }, [
        "/work/A",
        "/work/A/child",
        "/work/A-other",
        "/work/a",
      ]),
    ).toEqual(["/work/A", "/work/A/child"])
    expect(
      projectRestoreDirectories({ type: "server.instance.disposed", properties: { directory: "/work/A" } }, [
        "/work/A",
      ]),
    ).toEqual([])
    expect(projectRestoreDirectories({ type: "project.restored", properties: {} }, ["/work/A"])).toEqual([])
  })

  test("two preloaded clients replace same-ID transcripts, lists, diffs and todos without restarting", async () => {
    using a = fixture("/restore/client-a")
    using b = fixture("/restore/client-b")
    using unrelated = fixture("/other/project")
    for (const client of [a, b]) {
      await client.sync.session.sync("ses_same")
      expect(client.calls).toEqual([])
      expect(client.sync.session.history.more("ses_same")).toBe(true)
      const sessions = client.reset()
      expect(sessions).toEqual(["ses_same"])
      expect(client.store.session).toEqual([])
      for (const field of [
        "message",
        "part",
        "part_text_accum_delta",
        "session_diff",
        "todo",
        "session_status",
        "permission",
        "question",
      ] as const)
        expect(client.store[field]).toEqual({})
      expect(client.todos.size).toBe(0)
      expect([...client.sessionMeta.keys()]).toEqual(["/unrelated"])
      expect([...client.sessionLoads.keys()]).toEqual(["/unrelated"])
      expect(client.clearedQueries).toEqual([client === a ? "/restore/client-a" : "/restore/client-b"])
      expect(getSessionPrefetch(client === a ? "/restore/client-a" : "/restore/client-b", "ses_same")).toBeUndefined()
      await client.sync.session.fetch()
      await client.sync.session.sync("ses_same")
      await client.sync.session.diff("ses_same")
      await client.sync.session.todo("ses_same")
      expect(client.store.session.map((session) => session.id).sort()).toEqual(["ses_new", "ses_same"])
      expect(client.store.part.msg_same).toMatchObject([{ id: "prt_same", text: "B" }])
      expect(client.store.session_diff.ses_same[0].file).toBe("B")
      expect(client.todos.get("ses_same")).toMatchObject([{ content: "B" }])
      expect(client.sync.session.history.more("ses_same")).toBe(false)
    }
    expect(unrelated.store.part.msg_same).toMatchObject([{ text: "A" }])
    expect(unrelated.calls).toEqual([])
  })

  test("late transcript, list, diff and todo reads cannot repopulate restored caches", async () => {
    using client = fixture("/restore/race")
    await client.sync.session.sync("ses_same")
    client.title("A late")
    const gates = ["/session/ses_same/message", "/session", "/session/ses_same/diff", "/session/ses_same/todo"].map(
      (endpoint) => client.hold(endpoint),
    )
    const old = Promise.all([
      client.sync.session.sync("ses_same", { force: true }),
      client.sync.session.fetch(),
      client.sync.session.diff("ses_same", { force: true }),
      client.sync.session.todo("ses_same", { force: true }),
    ])
    await Promise.all(gates.map((gate) => gate.started.promise))
    client.reset()
    client.title("B")
    await client.sync.session.fetch()
    await client.sync.session.sync("ses_same")
    await client.sync.session.diff("ses_same")
    await client.sync.session.todo("ses_same")
    gates.forEach((gate) => gate.response.resolve())
    await old
    expect(client.store.part.msg_same).toMatchObject([{ text: "B" }])
    expect(client.store.session.find((session) => session.id === "ses_same")?.title).toBe("B")
    expect(client.store.session_diff.ses_same[0].file).toBe("B")
    expect(client.todos.get("ses_same")).toMatchObject([{ content: "B" }])
  })

  test("invalidates an in-flight prefetch before it can repopulate a same-ID transcript", async () => {
    using client = fixture("/restore/prefetch")
    const gate = Promise.withResolvers<void>()
    const pending = runSessionPrefetch({
      directory: "/restore/prefetch",
      sessionID: "ses_same",
      task: async (version) => {
        await gate.promise
        if (isSessionPrefetchCurrent("/restore/prefetch", "ses_same", version))
          client.setStore("part", "msg_same", [
            { id: "old", messageID: "msg_same", sessionID: "ses_same", type: "text", text: "late A" },
          ])
        return undefined
      },
    })
    client.reset()
    await client.sync.session.sync("ses_same")
    gate.resolve()
    await pending
    expect(client.store.part.msg_same).toMatchObject([{ text: "B" }])
  })

  test("a reader from an unmounted context cannot write into the shared store after reset", async () => {
    using client = fixture("/restore/unmounted")
    const gate = client.hold("/session/ses_same/message")
    const old = client.sync.session.sync("ses_same", { force: true })
    await gate.started.promise
    client.reset(false)
    gate.response.resolve()
    await old
    expect(client.store.message).toEqual({})
    expect(client.store.part).toEqual({})
  })

  test("an old read finishing does not remove the new generation's in-flight request", async () => {
    using client = fixture("/restore/dedup")
    const first = client.hold("/session/ses_same/message")
    const old = client.sync.session.sync("ses_same", { force: true })
    await first.started.promise
    client.reset()
    const second = client.hold("/session/ses_same/message")
    const fresh = client.sync.session.sync("ses_same")
    await second.started.promise
    first.response.resolve()
    await old
    const repeated = client.sync.session.sync("ses_same")
    expect(client.calls.filter((path) => path.endsWith("/message"))).toHaveLength(2)
    second.response.resolve()
    await Promise.all([fresh, repeated])
    expect(client.store.part.msg_same).toMatchObject([{ text: "B" }])
  })
})
