import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useCheckServerHealth } from "@/utils/server-health"
import { authTokenFromCredentials } from "@/utils/server"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http | ServerConnection.Tunnel
const HEALTH_POLL_INTERVAL_MS = 10_000

export function sidebarProjects(current: StoredProject[], directories: unknown): StoredProject[] | undefined {
  if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== "string" || !directory.trim())) return
  const expanded = new Map(current.map((project) => [project.worktree, project.expanded]))
  const next = [...new Set(directories)].map((worktree) => ({ worktree, expanded: expanded.get(worktree) ?? true }))
  if (next.length === current.length && next.every((project, index) => project.worktree === current[index]?.worktree))
    return current
  return next
}

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(key: ServerConnection.Key) {
  if (!key) return ""
  if (key === "sidecar") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const servers = [
    ...input.stored
      .filter(
        (value) =>
          typeof value === "string" ||
          !("type" in value) ||
          value.type !== "tunnel" ||
          !input.props ||
          input.props.some((conn) => conn.type === "tunnel" && conn.host === value.host),
      )
      .map((value) =>
        typeof value === "string"
          ? {
              type: "http" as const,
              http: { url: value },
            }
          : value,
      ),
    ...(input.props ?? []),
  ]

  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>()
  for (const value of servers) {
    const conn: ServerConnection.Any = "type" in value ? value : { type: "http", http: value }
    const key = ServerConnection.key(conn)
    if (deduped.has(key) && conn.type === "http" && !conn.authToken) continue
    deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Tunnel = {
    type: "tunnel"
    host: string
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh | Tunnel)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
      case "tunnel":
        return Key.make(`tunnel:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: {
    defaultServer: ServerConnection.Key
    disableHealthCheck?: boolean
    servers?: Array<ServerConnection.Any>
  }) => {
    const checkServerHealth = useCheckServerHealth()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )
    const [remote, setRemote] = createStore({ loaded: {} as Record<string, boolean> })

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
      healthy: undefined as boolean | undefined,
    })

    const healthy = () => state.healthy

    function startHealthPolling(conn: ServerConnection.Any) {
      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(conn)
          .then((next) => {
            if (!alive) return
            setState("healthy", next)
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, HEALTH_POLL_INTERVAL_MS)
      return () => {
        alive = false
        clearInterval(interval)
      }
    }

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function addTunnel(conn: ServerConnection.Tunnel) {
      if (!conn.host || !conn.http.url) return
      return batch(() => {
        const key = ServerConnection.key(conn)
        const existing = store.list.findIndex((value) =>
          typeof value !== "string" && "type" in value && value.type === "tunnel"
            ? ServerConnection.key(value) === key
            : false,
        )
        if (existing !== -1) setStore("list", existing, conn)
        else setStore("list", store.list.length, conn)
        setState("active", key)
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => {
        const conn: ServerConnection.Any =
          typeof x === "string" ? { type: "http", http: { url: x } } : "type" in x ? x : { type: "http", http: x }
        return ServerConnection.key(conn) !== key
      })
      batch(() => {
        setStore("list", list)
        if (state.active === key) {
          const next = allServers().find((conn) => ServerConnection.key(conn) !== key)
          setState("active", next ? ServerConnection.key(next) : ServerConnection.Key.make("sidecar"))
        }
      })
    }

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (conn: ServerConnection.Any) => checkServerHealth(conn.http).then((x) => x.healthy)

    createEffect(() => {
      const current_ = current()
      if (!current_) return

      if (props.disableHealthCheck) {
        setState("healthy", true)
        return
      }
      setState("healthy", undefined)
      onCleanup(startHealthPolling(current_))
    })

    const origin = createMemo(() => projectsKey(state.active))
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const projectsList = createMemo(() =>
      current()?.type === "tunnel" && !remote.loaded[origin()] ? [] : (store.projects[origin()] ?? []),
    )
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    createEffect(() => {
      const conn = current()
      const password = conn?.http.password
      if (!ready() || healthy() !== true || conn?.type !== "tunnel" || !password) return
      const bridge = (() => {
        try {
          const url = new URL(conn.http.url)
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return
          return new URL("/__haolab/projects", url)
        } catch {
          return
        }
      })()
      if (!bridge) return

      const key = projectsKey(ServerConnection.key(conn))
      const controller = new AbortController()
      let alive = true
      const load = async () => {
        try {
          const response = await fetch(bridge, {
            headers: {
              Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password })}`,
            },
            signal: controller.signal,
          })
          if (!response.ok) {
            if (response.status === 404 && alive) {
              showToast({ variant: "error", title: "设备 A 未提供侧栏清单", description: "请在 A 安装支持侧栏共享的 Desktop。" })
            }
            return
          }
          const data: unknown = await response.json()
          if (!alive || !data || typeof data !== "object" || !Array.isArray((data as { directories?: unknown }).directories)) return
          const currentProjects = store.projects[key] ?? []
          const next = sidebarProjects(currentProjects, (data as { directories: unknown[] }).directories)
          if (!next) return
          if (next !== currentProjects) setStore("projects", key, next)
          setRemote("loaded", key, true)
        } catch {
          // Reconnecting can request A's sidebar again.
        }
      }
      void load()
      onCleanup(() => {
        alive = false
        controller.abort()
        setRemote("loaded", key, false)
      })
    })

    return {
      ready: isReady,
      healthy,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      addTunnel,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
