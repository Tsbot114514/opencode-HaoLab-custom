import { expect, spyOn, test } from "bun:test"
import { createComponent, createRoot, type Component } from "solid-js"
import { render } from "solid-js/web"
import type { BaseRouterProps } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createTranscriptCache } from "../src/context/global-sync/transcript-cache"
import { clearSessionPrefetchDirectory } from "../src/context/global-sync/session-prefetch"
import { applyDirectoryEvent } from "../src/context/global-sync/event-reducer"
import type { State } from "../src/context/global-sync/types"
import type { TranscriptEntry } from "../src/context/global-sync/transcript-cache"
import type { Platform } from "../src/context/platform"
import type { ServerConnection as Connection } from "../src/context/server"
import { createMobileReadTransport } from "../src/utils/mobile-request"

// Invoked only by opencode's scoped loopback integration test, never a live app.
test("actual B directory-sync persistence and finite recovery", async () => {
  const input = JSON.parse(process.env.OPENCODE_TRANSFER_FIXTURE!) as {
    baseUrl: string
    directory: string
    sessionID: string
    authorization: string
    event?: Parameters<typeof applyDirectoryEvent>[0]["event"]
    text?: string
    replay?: {
      snapshot: unknown
      events: Parameters<typeof applyDirectoryEvent>[0]["event"][]
      text: string
      partID: string
    }
    ui?: { entry: TranscriptEntry; partID: string; text: string }
  }
  expect(new URL(input.baseUrl).hostname).toBe("127.0.0.1")
  expect(input.directory).toContain("opencode-test-")
  const host = window as Window & { __HAOLAB_MOBILE__?: boolean; happyDOM: { setURL(url: string): void } }
  host.happyDOM.setURL(input.baseUrl)
  host.__HAOLAB_MOBILE__ = true
  const { createDirSyncContext } = await import("../src/context/directory-sync")
  if (input.ui) {
    const { AppBaseProviders, AppInterface } = await import("../src/app")
    const { PlatformProvider } = await import("../src/context/platform")
    const { ServerConnection } = await import("../src/context/server")
    const { serverDisplayCache } = await import("../src/context/global-sync/server-cache")
    const { useGlobalSync } = await import("../src/context/global-sync")
    const { MemoryRouter, createMemoryHistory } = await import("@solidjs/router")
    const { base64Encode } = await import("@opencode-ai/core/util/encode")
    const sentry = await import("@sentry/solid")
    const errors: unknown[] = []
    const capture = spyOn(sentry, "captureException").mockImplementation((error) => {
      errors.push(error)
      console.error("isolated SessionPage error", error)
      return "fixture"
    })
    const conn: Connection.Http = {
      type: "http",
      http: { url: input.baseUrl, username: "transfer", password: "isolated-test-only" },
    }
    const scope = `tunnel.v1.${"a".repeat(64)}`
    const key = ServerConnection.key(conn)
    const cache = serverDisplayCache(key, conn)!
    const captured = input.ui
    const session = captured.entry.feed!.session
    Object.assign(host, {
      __HAOLAB_CONNECTION__: { state: "connected", active: true, revision: 1 },
      __HAOLAB_CACHE__: {
        version: 1,
        projects: [input.directory],
        selected: input.directory,
        sessions: { [input.directory]: [session] },
      },
    })
    const nativeFetch = Bun.fetch
    const read = async (pathname: string) => {
      const response = await nativeFetch(new URL(pathname, input.baseUrl), {
        headers: { authorization: input.authorization, "x-opencode-directory": input.directory },
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    cache.projects = await read("/project")
    cache.path = await read("/path")
    cache.config = await read("/config")
    cache.provider = { all: new Map(), connected: [], default: {} }
    cache.directoryPaths.set(input.directory, cache.path!)
    cache.directories.set(input.directory, {
      sessions: [session],
      total: 1,
      project: session.projectID,
      transcript: {
        sessionID: input.sessionID,
        messages: captured.entry.session,
        parts: Object.fromEntries(captured.entry.part.map((item) => [item.id, item.part])),
      },
    })
    const disk = new Map<string, string>([
      [
        "server",
        JSON.stringify({
          list: [],
          projects: { [key]: [{ worktree: input.directory, expanded: true }] },
          lastProject: { [key]: input.directory },
        }),
      ],
      [
        "layout.page",
        JSON.stringify({
          lastProjectSession: { [input.directory]: { directory: input.directory, id: input.sessionID, at: 1 } },
        }),
      ],
      [scope, JSON.stringify({ version: 1, entries: [captured.entry] })],
    ])
    let failed = true
    let restarts = 0
    const requests: { path: string; cursor: string | null; status: number }[] = []
    const platform: Platform = {
      platform: "web",
      openLink() {},
      back() {},
      forward() {},
      notify: async () => {},
      restart: async () => {
        restarts++
      },
      storage: () => ({
        getItem: async (key) => disk.get(key) ?? null,
        setItem: async (key, value) => {
          disk.set(key, value)
        },
        removeItem: async (key) => {
          disk.delete(key)
        },
      }),
      transcriptStorage: {
        scope,
        storage: {
          getItem: async (key) => disk.get(key) ?? null,
          setItem: async (key, value) => {
            disk.set(key, value)
          },
          removeItem: async (key) => {
            disk.delete(key)
          },
        },
      },
      fetch: Object.assign(
        async (value: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(value, init)
          const url = new URL(request.url)
          expect(url.origin).toBe(new URL(input.baseUrl).origin)
          if (url.pathname === "/__haolab/projects") return Response.json({ directories: [input.directory] })
          request.headers.set("x-opencode-directory", input.directory)
          request.headers.set(
            "authorization",
            failed && url.pathname.includes("/transcript/") ? "Basic invalid-fixture-only" : input.authorization,
          )
          const response = await nativeFetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            signal: request.signal,
            ...(request.method !== "GET" && request.method !== "HEAD" ? { body: await request.arrayBuffer() } : {}),
          })
          requests.push({ path: url.pathname, cursor: url.searchParams.get("cursor"), status: response.status })
          if (url.pathname.endsWith("/event")) return response
          // Native fetch streams cleanly; Happy DOM Headers need a plain record at this boundary.
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: Object.fromEntries(response.headers),
          })
        },
        { preconnect: nativeFetch.preconnect },
      ),
    }
    let sync: ReturnType<typeof createDirSyncContext> | undefined
    const Probe = () => {
      sync = useGlobalSync().createDirSyncContext(input.directory)
      return null
    }
    const history = createMemoryHistory()
    history.set({ value: `/${base64Encode(input.directory)}/session/${input.sessionID}`, replace: true, scroll: false })
    const router: Component<BaseRouterProps> = (props) =>
      createComponent(MemoryRouter, {
        history,
        root: props.root,
        get children() {
          return props.children
        },
      })
    const root = document.createElement("div")
    document.body.append(root)
    const reload = spyOn(host.location, "reload").mockImplementation(() => {})
    const oldFetch = globalThis.fetch
    globalThis.fetch = platform.fetch!
    const dispose = render(
      () =>
        createComponent(PlatformProvider, {
          value: platform,
          get children() {
            return createComponent(AppBaseProviders, {
              locale: "en",
              get children() {
                return createComponent(AppInterface, {
                  defaultServer: key,
                  servers: [conn],
                  router,
                  disableHealthCheck: true,
                  get children() {
                    return createComponent(Probe, {})
                  },
                })
              },
            })
          },
        }),
      root,
    )
    const wait = async (predicate: () => boolean, message: string) => {
      const end = performance.now() + 10_000
      while (!predicate() && performance.now() < end) await Bun.sleep(10)
      expect(
        predicate(),
        `${message}: ${root.textContent}; requests=${JSON.stringify(requests)}; errors=${String(errors)}`,
      ).toBe(true)
    }
    try {
      await wait(
        () =>
          [...root.querySelectorAll('[role="status"]')].some((element) =>
            element.textContent?.includes("Unable to load session messages:"),
          ),
        "Missing actual session page inline error",
      )
      expect(
        sync?.data.part[
          captured.entry.part.find((item) => item.part.some((part) => part.id === captured.partID))!.id
        ].find((part) => part.id === captured.partID),
      ).toMatchObject({ text: "a" })
      expect(sync?.session.error(input.sessionID)).toBeTruthy()
      expect(document.querySelector('[data-component="toast"]')).toBeNull()
      const retry = [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry")
      expect(retry).toBeDefined()
      const count = requests.filter((request) => request.path.includes("/transcript/")).length
      failed = false
      retry!.click()
      await wait(
        () =>
          Object.values(sync?.data.part ?? {})
            .flat()
            .some((part) => part.id === captured.partID && part.type === "text" && part.text === captured.text),
        "Retry did not replace the actual cached text part",
      )
      await wait(
        () =>
          !sync?.session.error(input.sessionID) &&
          ![...root.querySelectorAll('[role="status"]')].some((element) =>
            element.textContent?.includes("Unable to load session messages:"),
          ),
        "Actual Retry did not clear the SessionPage inline error",
      )
      expect(
        requests
          .filter((request) => request.path.includes("/transcript/"))
          .slice(count)
          .filter((request) => request.status === 200),
      ).toEqual([
        expect.objectContaining({
          path: `/session/${input.sessionID}/transcript/changes`,
          cursor: captured.entry.syncCursor,
          status: 200,
        }),
      ])
      expect(
        requests.filter((request) => request.path.includes("/transcript/") && request.status === 401).length,
      ).toBeLessThanOrEqual(2)
      expect(
        requests.some(
          (request) =>
            request.path === `/session/${input.sessionID}/message` ||
            request.path === `/session/${input.sessionID}/transcript/snapshot`,
        ),
      ).toBe(false)
      expect(document.querySelector('[data-component="toast"]')).toBeNull()
      expect(reload).not.toHaveBeenCalled()
      expect(restarts).toBe(0)
      expect(capture).not.toHaveBeenCalled()
      console.info(
        "actual SessionPage inline Retry feed requests",
        JSON.stringify(
          requests
            .filter((request) => request.path.includes("/transcript/"))
            .map((request) => ({ ...request, cursor: !!request.cursor })),
        ),
      )
    } finally {
      dispose()
      root.remove()
      globalThis.fetch = oldFetch
      reload.mockRestore()
      capture.mockRestore()
      delete host.__HAOLAB_MOBILE__
    }
    return
  }
  const data = new Map<string, string>()
  const storage = {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: async (key: string) => {
      data.delete(key)
    },
  }
  type Mode = "normal" | "auth" | "invalid" | "cap" | "old"
  let mode: Mode = "normal"
  const requests: { path: string; cursor: string | null; status: number }[] = []
  let cancelled = false
  const fetcher = Object.assign(
    async (value: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(value, init)
      const url = new URL(request.url)
      const feed = url.pathname.includes("/transcript/")
      if (input.replay && requests.length === 0 && url.pathname.endsWith("/transcript/snapshot")) {
        requests.push({ path: url.pathname, cursor: null, status: 200 })
        // Captured from this actual A before its transaction, not computed fixture feed JSON.
        return Response.json(input.replay.snapshot, { headers: { "x-opencode-transcript-feed": "1" } })
      }
      if (feed && mode === "cap") {
        // Reuse one chunk; reject the stream without allocating a giant joined body.
        const chunk = new Uint8Array(1024 * 1024)
        let remaining = 100
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (remaining-- > 0) {
                controller.enqueue(chunk)
                return
              }
              controller.close()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "application/json", "x-opencode-transcript-feed": "1" } },
        )
      }
      if (feed && mode === "old") {
        requests.push({ path: url.pathname, cursor: url.searchParams.get("cursor"), status: 404 })
        return new Response("Unsupported old server route", { status: 404 })
      }
      if (mode === "auth") request.headers.set("authorization", "Basic invalid-fixture-only")
      const response = await fetch(request)
      requests.push({ path: url.pathname, cursor: url.searchParams.get("cursor"), status: response.status })
      if (feed && mode === "invalid") {
        const real = await response.json()
        return Response.json(
          { ...real, changes: [{ seq: 0, type: "part.upsert", info: {}, part: {} }] },
          { headers: response.headers },
        )
      }
      return response
    },
    { preconnect: fetch.preconnect },
  )
  const fixtures: { dispose(): void; cache: ReturnType<typeof createTranscriptCache> }[] = []
  const create = () => {
    clearSessionPrefetchDirectory(input.directory)
    const cache = createTranscriptCache(storage, "sidecar.v1")
    const transport = createMobileReadTransport(fetcher)
    const value = createRoot((dispose) => {
      const [store, setStore] = createStore({
        session: [],
        message: {},
        part: {},
        part_text_accum_delta: {},
        session_status: {},
        path: { directory: input.directory },
        status: "complete",
        todo: {},
        session_diff: {},
        permission: {},
        question: {},
      } as unknown as State)
      const client = createOpencodeClient({
        baseUrl: input.baseUrl,
        directory: input.directory,
        headers: { authorization: input.authorization },
        fetch: transport.fetch,
        throwOnError: true,
      })
      const context = createDirSyncContext(client, input.directory, {
        child: () => [store, setStore],
        transcript: cache,
        todo: { set() {} },
        data: { project: [], session_todo: {} },
        recovery: { epoch: () => 0, signal: transport.signal },
      })
      return { store, setStore, context, client, dispose, cache }
    })
    fixtures.push(value)
    return value
  }
  try {
    const first = create()
    await first.context.session.sync(input.sessionID, { force: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toEndWith("/transcript/snapshot")
    expect(first.store.session[0]?.id).toBe(input.sessionID)
    expect(first.store.message[input.sessionID]).toHaveLength(20)
    if (input.replay) {
      expect(
        Object.values(first.store.part)
          .flat()
          .find((part) => part.id === input.replay!.partID),
      ).toMatchObject({ text: "a" })
      for (const event of input.replay.events) {
        expect(first.cache.event(input.directory, event)).not.toBe(false)
        applyDirectoryEvent({
          event,
          directory: input.directory,
          store: first.store,
          setStore: first.setStore,
          push() {},
          setSessionTodo() {},
          loadLsp() {},
        })
      }
      const livePart = Object.values(first.store.part)
        .flat()
        .find((part) => part.id === input.replay!.partID)
      expect(livePart?.type === "text" ? livePart.text : undefined).toBe(input.replay.text)
      await first.context.session.sync(input.sessionID, { force: true })
      expect(requests.at(-1)?.path).toEndWith("/transcript/changes")
      expect(
        Object.values(first.store.part)
          .flat()
          .find((part) => part.id === input.replay!.partID),
      ).toMatchObject({ text: input.replay.text })
      for (const event of input.replay.events) expect(first.cache.event(input.directory, event)).toBe(false)
      await first.cache.flush()
      first.dispose()
      first.cache.dispose()
      const restarted = create()
      await restarted.context.session.sync(input.sessionID, { force: true })
      expect(
        Object.values(restarted.store.part)
          .flat()
          .find((part) => part.id === input.replay!.partID),
      ).toMatchObject({ text: input.replay.text })
      expect(requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
      return
    }
    if (input.event) {
      const before = JSON.stringify(first.store.part)
      const accepted = first.cache.event(input.directory, input.event)
      expect(accepted).toBe(false)
      if (accepted !== false)
        applyDirectoryEvent({
          event: input.event,
          directory: input.directory,
          store: first.store,
          setStore: first.setStore,
          push() {},
          setSessionTodo() {},
          loadLsp() {},
        })
      expect(JSON.stringify(first.store.part)).toBe(before)
      expect(Object.values(first.store.part).flat()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: input.text ?? "ab" })]),
      )
      await first.cache.flush()
      first.dispose()
      first.cache.dispose()
      const restarted = create()
      await restarted.context.session.sync(input.sessionID, { force: true })
      expect(restarted.cache.event(input.directory, input.event)).toBe(false)
      expect(Object.values(restarted.store.part).flat()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: input.text ?? "ab" })]),
      )
      expect(requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
      return
    }
    await first.cache.flush()
    const cursor = first.cache.feedEntry(input.directory, input.sessionID)?.syncCursor
    expect(cursor).toBeTruthy()
    first.dispose()
    first.cache.dispose()
    const b = create()
    await b.context.session.sync(input.sessionID, { force: true })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ cursor, status: 200 })
    expect(requests[1]?.path).toEndWith("/transcript/changes")
    const visible = JSON.stringify(b.store.message[input.sessionID])
    for (const failure of ["auth", "invalid", "cap"] as const) {
      mode = failure
      await expect(b.context.session.sync(input.sessionID, { force: true })).rejects.toBeDefined()
      expect(b.context.session.error(input.sessionID)).toBeTruthy()
      expect(b.context.session.history.loading(input.sessionID)).toBe(false)
      expect(JSON.stringify(b.store.message[input.sessionID])).toBe(visible)
      expect(b.cache.feedEntry(input.directory, input.sessionID)?.syncCursor).toBe(cursor)
      if (failure === "cap") {
        expect(b.context.session.error(input.sessionID)).toContain("32 MiB")
        expect(cancelled).toBe(true)
      }
      mode = "normal"
      await b.context.session.sync(input.sessionID, { force: true })
      expect(b.context.session.error(input.sessionID)).toBeUndefined()
      expect(b.cache.feedEntry(input.directory, input.sessionID)?.syncCursor).toBe(cursor)
    }
    expect(requests.slice(1).every((request) => request.path.endsWith("/transcript/changes"))).toBe(true)
    await b.cache.flush()
    b.dispose()
    b.cache.dispose()
    // Only a genuinely unmarked old-server 404 may enter the legacy fallback.
    const old = create()
    const offset = requests.length
    mode = "old"
    await old.context.session.sync(input.sessionID, { force: true })
    expect(old.cache.feedCapability()).toBe(false)
    expect(requests.slice(offset).map((request) => request.path)).toEqual(
      expect.arrayContaining([`/session/${input.sessionID}`, `/session/${input.sessionID}/message`]),
    )
    mode = "normal"
    old.dispose()
    old.cache.dispose()
    // Production marked 404 removes visible/cache data without trying history.
    const deleted = create()
    await deleted.context.session.sync(input.sessionID, { force: true })
    await deleted.client.session.delete({ sessionID: input.sessionID })
    const beforeDeletion = requests.length
    await deleted.context.session.sync(input.sessionID, { force: true })
    expect(requests.slice(beforeDeletion)).toHaveLength(1)
    expect(requests.at(-1)).toMatchObject({ status: 404 })
    expect(requests.at(-1)?.path).toEndWith("/transcript/changes")
    expect(deleted.cache.feedEntry(input.directory, input.sessionID)).toBeUndefined()
    expect(deleted.store.message[input.sessionID]).toBeUndefined()
    console.info(
      "actual B directory-sync requests",
      JSON.stringify(
        requests.map((request) => ({
          ...request,
          cursor: !!request.cursor,
        })),
      ),
    )
  } finally {
    fixtures.forEach((fixture) => {
      fixture.dispose()
      fixture.cache.dispose()
    })
    clearSessionPrefetchDirectory(input.directory)
    delete host.__HAOLAB_MOBILE__
  }
}, 30_000)
