import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { applySessionReconciliation, applySidebarFeed, loadSidebarFeed } from "./global-sync/session-reconcile"
import { decodeDesktopCache, encodeDesktopCache } from "./global-sync/desktop-cache"
import type { DisplayCache } from "./global-sync/server-cache"
import type { State } from "./global-sync/types"

describe("session sidebar reconciliation", () => {
  test("sends bounded known roots through the SDK reconciliation endpoint", async () => {
    const requests: Request[] = []
    const client = createOpencodeClient({
      baseUrl: "http://sessions.test",
      fetch: Object.assign(async (request: RequestInfo | URL) => {
        requests.push(request instanceof Request ? request : new Request(request))
        return Response.json({ upserts: [], removed: [], limit: 55, limited: false })
      }, { preconnect: fetch.preconnect }),
    })
    const known = [{ id: "ses_a", title: "Old", updated: 2 }]

    const result = await client.session.reconcile({ directory: "/work", known, limit: 55 })

    expect(result.data?.removed).toEqual([])
    expect(new URL(requests[0].url).pathname).toBe("/session/sidebar/reconcile")
    expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/work")
    expect(await requests[0].json()).toEqual({ known, limit: 55 })
  })

  test("merges changed roots, removes archived roots and retains children and unchanged messages", () => {
    const session = (id: string, title: string, parentID?: string) => ({
      id, title, parentID, directory: "/work", projectID: "work", slug: id, version: "1",
      time: { created: 1, updated: 2 },
    })
    const [store, setStore] = createStore({
      session: [session("ses_a", "unchanged"), session("ses_b", "archived"), session("ses_c", "child", "ses_a")],
      sessionTotal: 8, limit: 5, permission: {}, question: {}, todo: {}, session_status: {}, session_diff: {},
      message: { ses_a: [{ id: "msg_a", sessionID: "ses_a" }], ses_b: [{ id: "msg_b", sessionID: "ses_b" }] },
      part: { msg_a: [{ id: "part_a", sessionID: "ses_a" }], msg_b: [{ id: "part_b", sessionID: "ses_b" }] },
      part_text_accum_delta: {},
    } as unknown as State)
    const cleared: string[] = []

    applySessionReconciliation({
      store, setStore,
      changes: { upserts: [session("ses_d", "new")], removed: ["ses_b"], limited: true },
      clearTodo: (id) => cleared.push(id),
    })

    expect(store.session.map((s) => s.id)).toEqual(["ses_a", "ses_c", "ses_d"])
    expect(store.sessionTotal).toBe(8)
    expect(store.message.ses_a?.[0]?.id).toBe("msg_a")
    expect(store.part.msg_a?.[0]?.id).toBe("part_a")
    expect(store.message.ses_b).toBeUndefined()
    expect(store.part.msg_b).toBeUndefined()
    expect(cleared).toContain("ses_b")
  })

  test("replaces the estimated total when the server window is complete", () => {
    const [store, setStore] = createStore({
      session: [{ id: "ses_a", title: "Old", time: { created: 1, updated: 1 } }],
      sessionTotal: 90, limit: 5, permission: {}, question: {}, todo: {}, session_status: {}, session_diff: {},
      message: {}, part: {}, part_text_accum_delta: {},
    } as unknown as State)
    applySessionReconciliation({
      store, setStore,
      changes: { upserts: [], removed: ["ses_a"], limited: false },
      clearTodo: () => undefined,
    })
    expect(store.session).toEqual([])
    expect(store.sessionTotal).toBe(0)
  })

  test("keeps a load-more affordance when cached mobile roots fill the server window", () => {
    const [store, setStore] = createStore({
      session: Array.from({ length: 10 }, (_, index) => ({
        id: `ses_${index}`, title: `Session ${index}`, directory: "/work", time: { created: index, updated: index },
      })),
      sessionTotal: 10, limit: 10, permission: {}, question: {}, todo: {}, session_status: {}, session_diff: {},
      message: {}, part: {}, part_text_accum_delta: {},
    } as unknown as State)

    applySessionReconciliation({
      store, setStore,
      changes: { upserts: [], removed: [], limited: true },
      clearTodo: () => undefined,
    })

    expect(store.sessionTotal).toBe(11)
    expect(store.session).toHaveLength(10)
  })
})

describe("sidebar cursor feed", () => {
  const title = (id: string, name = id) => ({
    id, title: name, directory: "/work", projectID: "work", slug: id, version: "1",
    time: { created: 1, updated: 2 },
  })
  const state = () => createStore({
    session: [title("ses_old"), { ...title("ses_child"), parentID: "ses_old" }],
    sessionTotal: 1, limit: 10, permission: {}, question: {}, todo: {}, session_status: {}, session_diff: {},
    message: { ses_child: [{ id: "msg_child", sessionID: "ses_child" }] }, part: {}, part_text_accum_delta: {},
  } as unknown as State)

  test("propagates an aborted SDK request instead of treating it as an unavailable legacy route", async () => {
    const controller = new AbortController()
    const error = new DOMException("Session load timed out", "TimeoutError")
    const requests: Request[] = []
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", signal: controller.signal,
      fetch: Object.assign((input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
          controller.abort(error)
        })
      }, { preconnect: fetch.preconnect }) })

    await expect(loadSidebarFeed({ sdk: client, directory: "/work" })).rejects.toBe(error)
    expect(requests).toHaveLength(1)
    expect(requests[0].signal.aborted).toBe(true)
  })

  test("loads only the newest page of 500 roots and preserves children", async () => {
    const urls: URL[] = []
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      urls.push(url)
      return Response.json({ cursor: 8, total: 500,
        items: Array.from({ length: 55 }, (_, i) => ({ ...title(`ses_${String(500 - i).padStart(3, "0")}`), time: { created: 1, updated: 500 - i } })),
        next: { updated: 446, id: "ses_446" } })
    }, { preconnect: fetch.preconnect }) })
    const result = await loadSidebarFeed({ sdk: client, directory: "/work" })
    expect(result && result !== "expired" && result.kind).toBe("snapshot")
    if (!result || result === "expired" || result.kind !== "snapshot") return
    const [store, setStore] = state()
    setStore("session", 1, "parentID", "ses_500")
    applySidebarFeed({ store, setStore, feed: result, clearTodo: () => undefined })
    expect(urls).toHaveLength(1)
    expect(urls[0].searchParams.get("limit")).toBe("55")
    expect(store.session.map((item) => item.id)).toContain("ses_child")
    expect(store.message.ses_child).toHaveLength(1)
    expect(store.sessionTotal).toBe(500)
    expect(result.cursor).toBe("8")
  })

  test("rebuilds the newest window after disk kept only 55 of 60 roots", async () => {
    const urls: URL[] = []
    const roots = Array.from({ length: 60 }, (_, index) => ({
      ...title(`ses_${String(60 - index).padStart(3, "0")}`), time: { created: 1, updated: 60 - index },
    }))
    const cache = { projects: [], directoryPaths: new Map(), directoryProviders: new Map(),
      directories: new Map([["/work", { project: "work", total: 500, cursor: "8", sessions: roots }]]) } as DisplayCache
    const restored = decodeDesktopCache(encodeDesktopCache(cache))!.directories.get("/work")!
    expect(restored.sessions).toHaveLength(55)
    expect(restored.sessions.map((s) => s.id)).not.toContain("ses_005")
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      urls.push(url)
      return Response.json(url.pathname.endsWith("changes")
        ? { cursor: 9, total: 500, changes: [], more: false }
        : { cursor: 9, total: 500, items: roots, next: { updated: 1, id: "ses_001" } })
    }, { preconnect: fetch.preconnect }) })
    const [store, setStore] = createStore({ ...state()[0], session: restored.sessions, sessionTotal: restored.total,
      limit: 60 } as unknown as State)
    const result = await loadSidebarFeed({ sdk: client, directory: "/work", cursor: restored.cursor,
      snapshot: store.session.filter((s) => !s.parentID).length < store.limit, limit: store.limit })
    expect(result && result !== "expired" && result.kind).toBe("snapshot")
    if (!result || result === "expired" || result.kind !== "snapshot") return
    applySidebarFeed({ store, setStore, feed: result, clearTodo: () => undefined })
    expect(store.session.map((s) => s.id)).toEqual(roots.map((s) => s.id).sort())
    expect(store.sessionTotal).toBe(500)
    expect(urls.map((url) => url.pathname)).toEqual(["/session/sidebar/snapshot"])
    expect(urls[0].searchParams.get("limit")).toBe("60")
    expect(urls[0].searchParams.has("cursor")).toBe(false)
    expect(urls[0].searchParams.has("afterID")).toBe(false)
    const changes = await loadSidebarFeed({ sdk: client, directory: "/work", cursor: result.cursor })
    expect(changes && changes !== "expired" && changes.kind).toBe("changes")
    expect(urls.at(-1)?.pathname).toBe("/session/sidebar/changes")
  })

  test("pages a requested window larger than 200 under one snapshot cursor", async () => {
    const urls: URL[] = []
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      urls.push(url)
      const start = url.searchParams.get("afterID") ? 200 : 0
      return Response.json({ cursor: 14, total: 500,
        items: Array.from({ length: start ? 5 : 200 }, (_, i) => ({ ...title(`ses_${500 - start - i}`), time: { created: 1, updated: 500 - start - i } })),
        next: { updated: 500 - start - (start ? 5 : 200) + 1, id: `ses_${500 - start - (start ? 5 : 200) + 1}` },
      })
    }, { preconnect: fetch.preconnect }) })
    const result = await loadSidebarFeed({ sdk: client, directory: "/work", snapshot: true, limit: 205 })
    expect(result && result !== "expired" && result.kind).toBe("snapshot")
    if (!result || result === "expired" || result.kind !== "snapshot") return
    expect(result.items).toHaveLength(205)
    expect(urls.map((url) => url.searchParams.get("limit"))).toEqual(["200", "5"])
    expect(urls[1].searchParams.get("cursor")).toBe("14")
    expect(urls[1].searchParams.get("afterID")).toBe("ses_301")
  })

  test("collects change pages in order before applying removes and upserts", async () => {
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      return Response.json(url.searchParams.get("cursor") === "8"
        ? { cursor: 9, total: 499, changes: [{ seq: 9, type: "remove", id: "ses_old" }], more: true }
        : { cursor: 11, total: 501, changes: [{ seq: 10, type: "upsert", session: title("ses_old", "restored") },
          { seq: 11, type: "upsert", session: title("ses_new") }], more: false })
    }, { preconnect: fetch.preconnect }) })
    const result = await loadSidebarFeed({ sdk: client, directory: "/work", cursor: "8" })
    expect(result && result !== "expired" && result.kind).toBe("changes")
    if (!result || result === "expired" || result.kind !== "changes") return
    const [store, setStore] = state()
    applySidebarFeed({ store, setStore, feed: result, clearTodo: () => undefined })
    expect(result.cursor).toBe("11")
    expect(store.session.find((item) => item.id === "ses_old")?.title).toBe("restored")
    expect(store.session.map((item) => item.id)).toContain("ses_child")
    expect(store.sessionTotal).toBe(501)
  })

  test("uses exact total for offscreen removal and SSE replay", () => {
    const [store, setStore] = state()
    setStore("sessionTotal", 500)
    applySidebarFeed({ store, setStore, clearTodo: () => undefined, feed: { kind: "changes", total: 499, changes: [
      { seq: 3, type: "upsert", session: title("ses_offscreen", "updated") },
      { seq: 4, type: "remove", id: "ses_offscreen" },
      { seq: 5, type: "upsert", session: title("ses_old", "replayed") },
    ] } })
    expect(store.sessionTotal).toBe(499)
    expect(store.session.find((s) => s.id === "ses_old")?.title).toBe("replayed")
    expect(store.session.map((item) => item.id)).toContain("ses_child")
  })

  test("expires old cursors and does not commit partial failed snapshots", async () => {
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname.endsWith("changes")) return Response.json({ name: "Expired" }, { status: 410 })
      if (url.searchParams.has("afterID")) return Response.json({ error: "failed" }, { status: 500 })
      return Response.json({ cursor: 5, total: 500, items: [title("ses_old")], next: { updated: 2, id: "ses_old" } })
    }, { preconnect: fetch.preconnect }) })
    expect(await loadSidebarFeed({ sdk: client, directory: "/work", cursor: "2" })).toBe("expired")
    await expect(loadSidebarFeed({ sdk: client, directory: "/work" })).rejects.toBeDefined()
    const [store] = state()
    expect(store.session.map((item) => item.id)).toEqual(["ses_old", "ses_child"])
  })

  test("an expired older page leaves cached titles intact until a new snapshot succeeds", async () => {
    const urls: URL[] = []
    const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      urls.push(url)
      if (urls.length === 1) return Response.json({ name: "Expired" }, { status: 410 })
      return Response.json({ cursor: 11, total: 1, items: [title("ses_new")], next: null })
    }, { preconnect: fetch.preconnect }) })
    const [store, setStore] = state()
    const stale = await loadSidebarFeed({ sdk: client, directory: "/work", cursor: "8", snapshot: true, limit: 2 })
    expect(stale).toBe("expired")
    expect(store.session.map((s) => s.id)).toContain("ses_old")
    const fresh = await loadSidebarFeed({ sdk: client, directory: "/work", limit: 2 })
    expect(fresh && fresh !== "expired" && fresh.kind).toBe("snapshot")
    if (!fresh || fresh === "expired" || fresh.kind !== "snapshot") return
    applySidebarFeed({ store, setStore, feed: fresh, clearTodo: () => undefined })
    expect(store.session.map((s) => s.id)).toContain("ses_new")
    expect(store.sessionTotal).toBe(1)
    expect(urls.map((url) => url.pathname)).toEqual([
      "/session/sidebar/snapshot", "/session/sidebar/snapshot",
    ])
  })

  test("treats legacy HTML and 404 routes as unavailable", async () => {
    for (const response of [new Response("<html>app</html>", { headers: { "content-type": "text/html" } }),
      new Response("not found", { status: 404 })]) {
      const client = createOpencodeClient({ baseUrl: "http://sessions.test", fetch: Object.assign(async () => response.clone(), { preconnect: fetch.preconnect }) })
      expect(await loadSidebarFeed({ sdk: client, directory: "/work" })).toBeUndefined()
    }
  })
})

describe("mobile session list endpoint", () => {
  test("requests directory-scoped roots through the experimental SDK route", async () => {
    const urls: URL[] = []
    const client = createOpencodeClient({
      baseUrl: "http://sessions.test",
      fetch: Object.assign(
        async (request: RequestInfo | URL) => {
          urls.push(new URL(request instanceof Request ? request.url : String(request)))
          return Response.json([])
        },
        { preconnect: fetch.preconnect },
      ),
    })

    const result = await client.experimental.session.list({ directory: "/project/mobile", roots: true, limit: 10 })

    expect(result.data).toEqual([])
    expect(urls).toHaveLength(1)
    expect(urls[0].pathname).toBe("/experimental/session")
    expect(urls[0].searchParams.get("directory")).toBe("/project/mobile")
    expect(urls[0].searchParams.get("roots")).toBe("true")
    expect(urls[0].searchParams.get("limit")).toBe("10")
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
