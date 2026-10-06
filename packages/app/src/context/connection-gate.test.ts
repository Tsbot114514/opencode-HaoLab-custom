import { expect, test } from "bun:test"
import { createComponent, getOwner, Suspense } from "solid-js"
import { insert, isServer, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/solid-query"
import { PlatformProvider, type Platform } from "./platform"
import { ServerConnection, ServerProvider, useServer } from "./server"
import { ConnectionGate, ServerCache } from "./connection-gate"
import { serverDisplayCache } from "./global-sync/server-cache"
import { downloadedUpdateVersion } from "../pages/layout/update"
import { createChildStoreManager } from "./global-sync/child-store"
import type { QueryOptionsApi } from "./global-sync"

const browserTest = isServer ? test.skip : test

for (const healthy of [true, false])
  browserTest(`cached messages and paired sidebar render before network (healthy=${healthy})`, async () => {
    const conn: ServerConnection.Tunnel = {
      type: "tunnel",
      host: `cached-gate-${healthy}.test`,
      cacheKey: "a".repeat(64),
      http: { url: `http://127.0.0.1:${healthy ? 48111 : 48112}`, username: "fixture", password: "fixture" },
    }
    const key = ServerConnection.key(conn)
    const [connections, setConnections] = createStore({ list: [conn] })
    const identity = `${key}:${conn.cacheKey}`
    const cache = serverDisplayCache(key, conn)!
    cache.directories.set("/cached", {
      project: "fixture",
      total: 1,
      sessions: [],
      transcript: {
        sessionID: "ses_cached",
        messages: [
          {
            id: "msg_cached",
            sessionID: "ses_cached",
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "fixture", modelID: "fixture" },
          },
        ],
        parts: {
          msg_cached: [
            {
              id: "part_cached",
              messageID: "msg_cached",
              sessionID: "ses_cached",
              type: "text",
              text: "Cached message visible",
            },
          ],
        },
      },
    })
    const disk = new Map<string, string>([
      [
        "server",
        JSON.stringify({
          list: [],
          projects: { [identity]: [{ worktree: "/cached", expanded: false }] },
          lastProject: { [identity]: "/cached" },
          verified: { [identity]: conn.cacheKey },
        }),
      ],
    ])
    const requests: string[] = []
    let health: ((response: Response) => void) | undefined
    let update: ((value: { updateAvailable: boolean; downloaded: boolean; version: string }) => void) | undefined
    const platform: Platform = {
      platform: "desktop",
      openLink() {},
      restart: async () => {},
      back() {},
      forward() {},
      notify: async () => {},
      storage: () => ({
        getItem: async (key) => disk.get(key) ?? null,
        setItem: async (key, value) => {
          disk.set(key, value)
        },
        removeItem: async (key) => {
          disk.delete(key)
        },
      }),
      fetch: Object.assign(
        (input: RequestInfo | URL) => {
          requests.push(input instanceof Request ? input.url : String(input))
          return new Promise<Response>((resolve) => {
            health = resolve
          })
        },
        { preconnect: fetch.preconnect },
      ),
      checkUpdate: () =>
        new Promise((resolve) => {
          update = resolve
        }),
    }
    const previous = globalThis.fetch
    const sidebarRequests: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        sidebarRequests.push(String(input))
        return new Promise<Response>(() => {})
      },
      { preconnect: previous.preconnect },
    )
    const root = document.createElement("div")
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let server: ReturnType<typeof useServer> | undefined
    const dispose = render(
      () =>
        createComponent(PlatformProvider, {
          value: platform,
          get children() {
            return createComponent(ServerProvider, {
              defaultServer: key,
              get servers() {
                return connections.list
              },
              get children() {
                server = useServer()
                return createComponent(ServerCache, {
                  children: (displayCache) =>
                    createComponent(ConnectionGate, {
                      displayCache,
                      loading: "health splash",
                      error: () => "offline error",
                      get children() {
                        return createComponent(QueryClientProvider, {
                          client,
                          get children() {
                            return createComponent(Suspense, {
                              fallback: "shell splash",
                              get children() {
                                const query = useQuery(() => ({ queryKey: ["update"], queryFn: platform.checkUpdate! }))
                                const manager = createChildStoreManager({
                                  owner: getOwner()!,
                                  displayCache,
                                  isBooting: () => false,
                                  isLoadingSessions: () => false,
                                  onBootstrap() {},
                                  onDispose() {},
                                  translate: (key) => key,
                                  global: { provider: { all: new Map(), connected: [], default: {} } },
                                  queryOptions: {
                                    path: () => ({ queryKey: ["path"], enabled: false }),
                                    mcp: () => ({ queryKey: ["mcp"], enabled: false }),
                                    lsp: () => ({ queryKey: ["lsp"], enabled: false }),
                                    providers: () => ({ queryKey: ["providers"], enabled: false }),
                                  } as unknown as QueryOptionsApi,
                                })
                                const body = document.createElement("div")
                                const child = manager.child("/cached", { bootstrap: false })[0]
                                insert(body, () => {
                                  const version = downloadedUpdateVersion(query)
                                  const part = child.part.msg_cached?.[0]
                                  return `${part?.type === "text" ? part.text : "no message"} sidebar:${server!.projects.list().map((project) => project.worktree)} update:${version ?? "pending"}`
                                })
                                return body
                              },
                            })
                          },
                        })
                      },
                    }),
                })
              },
            })
          },
        }),
      root,
    )
    try {
      await Bun.sleep(50)
      expect(requests.some((url) => url.endsWith("/global/health"))).toBe(true)
      expect(update).toBeDefined()
      expect(root.textContent).toContain("Cached message visible sidebar:/cached update:pending")
      expect(server?.projects.last()).toBe("/cached")
      expect(sidebarRequests).toEqual([])
      health?.(Response.json({ healthy, version: "fixture" }))
      await Bun.sleep(20)
      expect(sidebarRequests.some((url) => url.endsWith("/__haolab/projects"))).toBe(healthy)
      expect(root.textContent).toContain("Cached message visible sidebar:/cached")
      update?.({ updateAvailable: true, downloaded: true, version: "2" })
      await Bun.sleep(20)
      expect(root.textContent).toContain("update:2")
      const other: ServerConnection.Tunnel = {
        ...conn,
        host: `other-${healthy}.test`,
        cacheKey: "c".repeat(64),
        http: { ...conn.http, url: "http://127.0.0.1:48113" },
      }
      setConnections("list", [conn, other])
      server?.setActive(ServerConnection.key(other))
      await Bun.sleep(20)
      expect(root.textContent).not.toContain("Cached message visible")
      expect(server?.projects.list()).toEqual([])
      server?.setActive(key)
      await Bun.sleep(20)
      expect(root.textContent).toContain("Cached message visible sidebar:/cached")
      setConnections("list", [{ ...conn, cacheKey: "b".repeat(64), http: { ...conn.http, password: "rotated" } }])
      await Bun.sleep(20)
      expect(server?.projects.list()).toEqual([])
      expect(server?.projects.last()).toBeUndefined()
      expect(root.textContent).not.toContain("Cached message visible")
    } finally {
      dispose()
      client.clear()
      globalThis.fetch = previous
    }
  })

browserTest("a first-time server stays gated until authenticated health succeeds", async () => {
  const conn: ServerConnection.Http = {
    type: "http",
    http: { url: "https://cold-gate.test", username: "fixture", password: "secret" },
  }
  let release: ((response: Response) => void) | undefined
  const authorization = { value: null as string | null }
  const root = document.createElement("div")
  const platform: Platform = {
    platform: "web",
    openLink() {},
    restart: async () => {},
    back() {},
    forward() {},
    notify: async () => {},
    fetch: Object.assign(
      (input: RequestInfo | URL) => {
        authorization.value = input instanceof Request ? input.headers.get("authorization") : null
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      },
      { preconnect: fetch.preconnect },
    ),
  }
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(ServerProvider, {
            defaultServer: ServerConnection.key(conn),
            servers: [conn],
            get children() {
              return createComponent(ServerCache, {
                children: (displayCache) =>
                  createComponent(ConnectionGate, {
                    displayCache,
                    loading: "health splash",
                    error: () => "connection error",
                    children: "cold content",
                  }),
              })
            },
          })
        },
      }),
    root,
  )
  try {
    await Bun.sleep(20)
    expect(root.textContent).toBe("health splash")
    expect(authorization.value).toBe(`Basic ${btoa("fixture:secret")}`)
    release?.(Response.json({ healthy: true, version: "fixture" }))
    await Bun.sleep(20)
    expect(root.textContent).toBe("cold content")
  } finally {
    dispose()
  }
})

browserTest("ServerCache hydrates paired disk summaries before a held health response", async () => {
  const conn: ServerConnection.Tunnel = {
    type: "tunnel",
    host: "disk-gate.test",
    cacheKey: "d".repeat(64),
    http: { url: "http://127.0.0.1:48114", password: "fixture" },
  }
  const key = ServerConnection.key(conn)
  const identity = `${key}:${conn.cacheKey}`
  const reads: string[] = []
  const disk = new Map([
    [
      "server",
      JSON.stringify({
        projects: { [identity]: [{ worktree: "/disk", expanded: true }] },
        verified: { [identity]: conn.cacheKey },
      }),
    ],
    [
      `tunnel.v1.${conn.cacheKey}`,
      JSON.stringify({
        version: 1,
        projects: [],
        directories: [
          {
            directory: "/disk",
            project: "fixture",
            total: 1,
            sessions: [
              {
                id: "ses_disk",
                directory: "/disk",
                projectID: "fixture",
                slug: "fixture",
                title: "Disk session",
                version: "1",
                time: { created: 1, updated: 2 },
              },
            ],
          },
        ],
      }),
    ],
  ])
  let release: ((response: Response) => void) | undefined
  const platform: Platform = {
    platform: "desktop",
    openLink() {},
    restart: async () => {},
    back() {},
    forward() {},
    notify: async () => {},
    storage: () => ({
      getItem: async (key) => {
        reads.push(key)
        await Bun.sleep(5)
        return disk.get(key) ?? null
      },
      setItem: async (key, value) => {
        disk.set(key, value)
      },
      removeItem: async (key) => {
        disk.delete(key)
      },
    }),
    fetch: Object.assign(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      { preconnect: fetch.preconnect },
    ),
  }
  const root = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(ServerProvider, {
            defaultServer: key,
            servers: [conn],
            get children() {
              const server = useServer()
              return createComponent(ServerCache, {
                children: (displayCache) =>
                  createComponent(ConnectionGate, {
                    displayCache,
                    loading: "health splash",
                    error: () => "offline error",
                    get children() {
                      const body = document.createElement("div")
                      insert(
                        body,
                        () =>
                          `${displayCache.directories.get("/disk")?.sessions[0]?.title}:${server.projects.list()[0]?.worktree}`,
                      )
                      return body
                    },
                  }),
              })
            },
          })
        },
      }),
    root,
  )
  try {
    await Bun.sleep(50)
    expect(reads).toContain(`tunnel.v1.${conn.cacheKey}`)
    expect(release).toBeDefined()
    expect(root.textContent).toBe("Disk session:/disk")
    release?.(Response.json({ healthy: false }))
    await Bun.sleep(20)
    expect(root.textContent).toBe("Disk session:/disk")
  } finally {
    dispose()
  }
})
