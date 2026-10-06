import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useCheckServerHealth } from "@/utils/server-health"
import { authTokenFromCredentials } from "@/utils/server"
import { usePlatform } from "./platform"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { readMobileConnection, requestMobileConnectionRefresh, validateMobileConnection } from "@/utils/mobile-connection"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http | ServerConnection.Tunnel
export type MobileSessionSummary = Pick<Session, "id" | "directory" | "projectID" | "slug" | "title" | "version"> & {
  time: Pick<Session["time"], "created" | "updated">
}
export type MobileTranscriptMessage = {
  id: string
  role: "user" | "assistant"
  created: number
  parentID?: string
  text: string
}
export type MobileTranscript = { directory: string; sessionID: string; messages: MobileTranscriptMessage[] }
const HEALTH_POLL_INTERVAL_MS = 10_000

export function validateMobileTranscript(value: unknown): MobileTranscript | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const transcript = value as Record<string, unknown>
  if (typeof transcript.directory !== "string" || !transcript.directory.trim() ||
    typeof transcript.sessionID !== "string" || !transcript.sessionID.trim() ||
    !Array.isArray(transcript.messages) || transcript.messages.length > 20) return
  const ids = new Set<string>()
  const messages: MobileTranscriptMessage[] = []
  for (const entry of transcript.messages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
    const message = entry as Record<string, unknown>
    if (typeof message.id !== "string" || !message.id.trim() || ids.has(message.id) ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.created !== "number" || !Number.isFinite(message.created) ||
      typeof message.text !== "string" || !message.text.trim() || message.text.length > 6000 ||
      (message.parentID !== undefined && (message.role !== "assistant" || typeof message.parentID !== "string" || !message.parentID.trim()))) return
    ids.add(message.id)
    messages.push({ id: message.id, role: message.role, created: message.created, text: message.text,
      ...(message.parentID === undefined ? {} : { parentID: message.parentID as string }) })
  }
  return { directory: transcript.directory, sessionID: transcript.sessionID, messages }
}

export function mobileCache() {
  if (typeof window === "undefined" || (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ !== true)
    return
  const value: unknown = (window as Window & { __HAOLAB_CACHE__?: unknown }).__HAOLAB_CACHE__
  if (!value || typeof value !== "object") return
  const cache = value as { version?: unknown; projects?: unknown; sessions?: unknown; selected?: unknown; transcript?: unknown }
  if (cache.version !== 1 || !sidebarProjects([], cache.projects)) return
  const sessions: Record<string, MobileSessionSummary[]> = {}
  if (cache.sessions && typeof cache.sessions === "object" && !Array.isArray(cache.sessions)) {
    for (const [directory, entries] of Object.entries(cache.sessions)) {
      if (!Array.isArray(entries) || !entries.every((entry) => {
        if (!entry || typeof entry !== "object") return false
        const session = entry as Record<string, unknown>
        const time = session.time as Record<string, unknown> | undefined
        return session.directory === directory &&
          [session.id, session.directory, session.projectID, session.slug, session.title, session.version].every(
            (field) => typeof field === "string" && !!field.trim(),
          ) && !!time && typeof time === "object" &&
          typeof time.created === "number" && Number.isFinite(time.created) &&
          typeof time.updated === "number" && Number.isFinite(time.updated)
      })) continue
      sessions[directory] = entries.map((entry: MobileSessionSummary) => ({
        id: entry.id, directory: entry.directory, projectID: entry.projectID, slug: entry.slug,
        title: entry.title, version: entry.version, time: { created: entry.time.created, updated: entry.time.updated },
      }))
    }
  }
  return {
    projects: cache.projects as string[],
    sessions,
    selected: typeof cache.selected === "string" && (cache.projects as string[]).includes(cache.selected)
      ? cache.selected : undefined,
    transcript: validateMobileTranscript(cache.transcript),
  }
}

export function sendMobileCache(message: { type: "projects"; directories: string[] } | { type: "sessions"; directory: string; sessions: MobileSessionSummary[] } | { type: "selected"; directory: string } | ({ type: "transcript" } & MobileTranscript)) {
  if (typeof window === "undefined" || (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ !== true)
    return
  ;(window as Window & { webkit?: { messageHandlers?: { haolabCache?: { postMessage: (value: typeof message) => void } } } })
    .webkit?.messageHandlers?.haolabCache?.postMessage(message)
}

export function sidebarProjects(current: StoredProject[], directories: unknown): StoredProject[] | undefined {
  if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== "string" || !directory.trim())) return
  const expanded = new Map(current.map((project) => [project.worktree, project.expanded]))
  const next = [...new Set(directories)].map((worktree) => ({ worktree, expanded: expanded.get(worktree) ?? true }))
  if (next.length === current.length && next.every((project, index) => project.worktree === current[index]?.worktree))
    return current
  return next
}

export function canRestoreTunnelSidebar(conn: ServerConnection.Any | undefined, verified?: ServerConnection.HttpBase | string) {
  if (typeof verified === "string") return conn?.type === "tunnel" && /^[a-f0-9]{64}$/.test(verified) && conn.cacheKey === verified
  return conn?.type === "tunnel" && !!verified && verified.url === conn.http.url &&
    verified.username === conn.http.username && verified.password === conn.http.password
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
    cacheKey?: string
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
    const platform = usePlatform()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        verified: {} as Record<string, string>,
      }),
    )
    const [remote, setRemote] = createStore({ loaded: {} as Record<string, ServerConnection.HttpBase | undefined> })
    const mobile =
      typeof window !== "undefined" && (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true
    const [native, setNative] = createStore({ connection: mobile ? readMobileConnection() : undefined })
    if (mobile) {
      const receive = (event: Event) => {
        const next = validateMobileConnection((event as CustomEvent<unknown>).detail)
        if (!next || (native.connection && next.revision < native.connection.revision)) return
        setNative("connection", next)
      }
      window.addEventListener("haolab:connection", receive)
      onCleanup(() => window.removeEventListener("haolab:connection", receive))
    }
    const cached = mobileCache()
    const [mobileProjects, setMobileProjects] = createStore({
      list: sidebarProjects([], cached?.projects) ?? ([] as StoredProject[]),
      selected: cached?.selected,
      status: "loading" as "loading" | "ready" | "error",
      retry: 0,
    })

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      if (mobile) return (props.servers ?? []).filter((conn) => conn.type === "http" && conn.http.url === window.location.origin)
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: mobile ? ServerConnection.Key.make(window.location.origin) : props.defaultServer,
      healthy: undefined as boolean | undefined,
    })

    const healthy = () => state.healthy
    const connection = {
      state: () => native.connection?.state ?? (healthy() === true ? "connected" : healthy() === false ? "offline" : "connecting"),
      active: () => native.connection?.active ?? true,
      revision: () => native.connection?.revision ?? 0,
      refresh: () => {
        if (mobile && requestMobileConnectionRefresh()) return
        const conn = current()
        if (conn) void check(conn).then((next) => setState("healthy", next))
        if (mobile) setMobileProjects("retry", (value) => value + 1)
      },
    }

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

    const remember = (key: ServerConnection.Key) => {
      if (platform.platform !== "desktop") return
      void Promise.resolve(platform.setDefaultServer?.(key)).catch(() => undefined)
    }

    function setActive(input: ServerConnection.Key) {
      if (state.active === input) return
      setState("active", input)
      remember(input)
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
        remember(ServerConnection.key(conn))
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
        remember(key)
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
          const selected = next ? ServerConnection.key(next) : ServerConnection.Key.make("sidecar")
          setState("active", selected)
          remember(selected)
        }
      })
    }

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (conn: ServerConnection.Any) => checkServerHealth(conn.http).then((x) => x.healthy)

    createEffect(() => {
      const current_ = current()
      if (!current_) return

      if (mobile && native.connection) {
        setState("healthy", native.connection.state === "connected" ? true : native.connection.state === "offline" ? false : undefined)
        return
      }
      if (props.disableHealthCheck && !mobile) {
        setState("healthy", true)
        return
      }
      setState("healthy", undefined)
      onCleanup(startHealthPolling(current_))
    })

    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const origin = createMemo(() => {
      const conn = current()
      const key = conn ? ServerConnection.key(conn) : state.active
      return conn?.type === "tunnel" && /^[a-f0-9]{64}$/.test(conn.cacheKey ?? "")
        ? `${key}:${conn.cacheKey}` : projectsKey(key)
    })
    const projectsList = createMemo(() => {
      if (mobile) return mobileProjects.list
      const conn = current()
      if (conn?.type === "tunnel") {
        if (!canRestoreTunnelSidebar(conn, store.verified[origin()] ?? remote.loaded[origin()])) return []
      }
      return store.projects[origin()] ?? []
    })
    const isLocal = createMemo(() => {
      if (mobile) return false
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    createEffect(() => {
      if (!mobile || !ready() || healthy() !== true || !connection.active()) return
      connection.revision()
      mobileProjects.retry
      const conn = current()
      if (conn?.type !== "http" || window.location.protocol !== "http:") return
      if (window.location.hostname !== "127.0.0.1") return

      const controller = new AbortController()
      let busy = false
      const load = async () => {
        if (busy) return
        busy = true
        const request = new AbortController()
        const cancel = () => request.abort()
        controller.signal.addEventListener("abort", cancel)
        try {
          const data = await new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
              cancel()
              reject(new Error("Project snapshot timed out"))
            }, 10_000)
            void fetch("/__haolab/projects", { signal: request.signal }).then(async (response) => {
              if (!response.ok) throw new Error("Project snapshot unavailable")
              return response.json() as Promise<unknown>
            }).then(resolve, reject).finally(() => clearTimeout(timeout))
          })
          if (
            controller.signal.aborted || request.signal.aborted ||
            !data ||
            typeof data !== "object" ||
            !Array.isArray((data as { directories?: unknown }).directories)
          ) throw new Error("Invalid project snapshot")
          const next = sidebarProjects(mobileProjects.list, (data as { directories: unknown[] }).directories)
          if (!next) throw new Error("Invalid project snapshot")
          if (next !== mobileProjects.list) {
            setMobileProjects("list", next)
            sendMobileCache({ type: "projects", directories: next.map((project) => project.worktree) })
          }
          setMobileProjects("status", "ready")
        } catch {
          if (!controller.signal.aborted) setMobileProjects("status", "error")
        } finally {
          controller.signal.removeEventListener("abort", cancel)
          busy = false
        }
      }
      void load()
      const interval = setInterval(() => void load(), HEALTH_POLL_INTERVAL_MS)
      onCleanup(() => {
        clearInterval(interval)
        controller.abort()
      })
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

      const key = origin()
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
          batch(() => {
            if (next !== currentProjects) setStore("projects", key, next.slice(0, 30))
            if (/^[a-f0-9]{64}$/.test(conn.cacheKey ?? "")) setStore("verified", key, conn.cacheKey!)
            setRemote("loaded", key, { url: conn.http.url, username: conn.http.username, password })
          })
        } catch {
          // Reconnecting can request A's sidebar again.
        }
      }
      void load()
      onCleanup(() => {
        alive = false
        controller.abort()
      })
    })

    return {
      ready: isReady,
      healthy,
      connection,
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
        status: () => mobile ? mobileProjects.status : "ready",
        retry: () => setMobileProjects("retry", (value) => value + 1),
        open(directory: string) {
          if (mobile) return
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          if (mobile) return
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
          if (mobile) {
            const index = mobileProjects.list.findIndex((x) => x.worktree === directory)
            if (index !== -1) setMobileProjects("list", index, "expanded", true)
            return
          }
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          if (mobile) {
            const index = mobileProjects.list.findIndex((x) => x.worktree === directory)
            if (index !== -1) setMobileProjects("list", index, "expanded", false)
            return
          }
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          if (mobile) return
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
          if (mobile) return mobileProjects.list.some((project) => project.worktree === mobileProjects.selected)
            ? mobileProjects.selected : undefined
          const key = origin()
          if (!key) return
          if (current()?.type === "tunnel" && !canRestoreTunnelSidebar(current(), store.verified[key] ?? remote.loaded[key])) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          if (mobile) {
            setMobileProjects("selected", directory)
            return
          }
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
