import type { Config, OpencodeClient, Path, PermissionRequest, Project, ProviderAuthResponse, QuestionRequest, Todo } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import {
  batch,
  createContext,
  createEffect,
  getOwner,
  onCleanup,
  onMount,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "./platform"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { captureDirectory, type DisplayCache } from "./global-sync/server-cache"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import { applySessionReconciliation, applySidebarFeed, loadSidebarFeed } from "./global-sync/session-reconcile"
import { applyPendingRequests } from "./global-sync/pending-requests"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient, type QueryFunction } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { projectRestoreDirectories, projectSessionRevision, resetProjectSessions } from "./global-sync/project-restore"
import { mobileCache, sendMobileCache, useServer } from "./server"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext, projectMobileTranscript } from "./directory-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { desktopCacheKey } from "./global-sync/desktop-cache"
import { createTranscriptCache, TRANSCRIPT_STORE } from "./global-sync/transcript-cache"
import { createMobileRefreshCoordinator } from "@/utils/mobile-connection"
import { linkAbortSignals } from "@/utils/mobile-request"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (directory: string, sdk: OpencodeClient, mobile = false) =>
  queryOptions({
    queryKey: [directory, "mcp"] as const,
    queryFn: (context) => sdk.mcp.status(undefined, mobile ? { signal: context.signal } : undefined).then((r) => r.data ?? {}),
  })

export const loadLspQuery = (directory: string, sdk: OpencodeClient, mobile = false) =>
  queryOptions({
    queryKey: [directory, "lsp"] as const,
    queryFn: (context) => sdk.lsp.status(undefined, mobile ? { signal: context.signal } : undefined).then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(globalSDK: () => OpencodeClient, sdkFor: (dir: PathKey) => OpencodeClient, enabled = () => true, mobile = false) {
  function available<T>(options: T): T & { enabled: boolean } {
    return { ...options, enabled: enabled(), ...(mobile ? { retry: 0 as const } : {}) }
  }
  return {
    globalConfig: () => available(loadGlobalConfigQuery(globalSDK(), mobile)),
    projects: () => available(loadProjectsQuery(globalSDK(), mobile)),
    providers: (directory: PathKey | null) =>
      available(loadProvidersQuery(directory, directory === null ? globalSDK() : sdkFor(directory), mobile)),
    path: (directory: PathKey | null) => available(loadPathQuery(directory, directory === null ? globalSDK() : sdkFor(directory), mobile)),
    agents: (directory: PathKey) => available(loadAgentsQuery(directory, sdkFor(directory), mobile)),
    mcp: (directory: PathKey) => available(loadMcpQuery(directory, sdkFor(directory), mobile)),
    lsp: (directory: PathKey) => available(loadLspQuery(directory, sdkFor(directory), mobile)),
    sessions: (directory: PathKey) => ({ queryKey: [directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

function createGlobalSync(displayCache?: DisplayCache) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const transcript = createTranscriptCache(
    platform.platform === "desktop" ? platform.storage?.(TRANSCRIPT_STORE) : platform.transcriptStorage?.storage,
    platform.platform === "desktop" ? desktopCacheKey(server.current) : platform.transcriptStorage?.scope,
    undefined,
    platform.transcriptStorage ? (entries) => {
      const sessionID = window.location.pathname.match(/\/session\/(ses_[^/]+)$/)?.[1]
      const entry = entries.find((item) => item.sessionID === sessionID)
      if (!entry) return
      const parts = new Map(entry.part.map((item) => [item.id, item.part]))
      sendMobileCache({
        type: "transcript",
        ...projectMobileTranscript(entry.directory, entry.sessionID, entry.session.map((info) => ({
          info,
          parts: parts.get(info.id) ?? [],
        }))),
      })
    } : undefined,
  )
  onCleanup(() => transcript.dispose())
  const mobile = typeof window !== "undefined" && (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true
  if (mobile && transcript.enabled) {
    const flush = () => void transcript.flush()
    const hidden = () => {
      if (document.visibilityState === "hidden") flush()
    }
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("pagehide", flush)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("pagehide", flush)
    })
  }
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<boolean>>()
  const pendingLoads = new Map<string, Promise<void>>()
  const pendingRequestRevision = new Map<string, number>()
  const sessionEventRevision = new Map<string, number>()
  const sessionMeta = new Map<string, { limit: number }>()
  const seededSessions = new Set<string>()
  const [mobileStatus, setMobileStatus] = createStore({ sessions: {} as Record<string, "loading" | "ready" | "error"> })
  const online = () => !mobile || globalSDK.recovery.available()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(() => globalSDK.client, sdkFor, online, mobile)

  const queries = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return bootstrap.isPending
    },
    project: displayCache?.projects ?? [],
    session_todo: {},
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", data: "", config: "", worktree: "", directory: "", home: "" }
      if (queries[2].isLoading) return EMPTY
      return queries[2].data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (queries[1].isLoading) return EMPTY
      return queries[1].data ?? EMPTY
    },
    get config() {
      if (queries[0].isLoading) return {}
      return queries[0].data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })
  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let mobileReconcilePending = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  // Discover each remote project once so closing it locally does not immediately reopen it.
  const discovered = new Set<string>()
  createEffect(() => {
    if (!server.ready()) return
    if (typeof window !== "undefined" && (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true)
      return
    if (server.current?.type === "tunnel") return
    if (platform.platform !== "web" && server.isLocal()) return
    for (const project of globalStore.project) {
      if (project.id === "global" || !project.worktree || discovered.has(project.worktree)) continue
      discovered.add(project.worktree)
      untrack(() => server.projects.open(project.worktree))
    }
  })

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: ["bootstrap"],
    enabled: online(),
    retry: mobile ? 0 : undefined,
    queryFn: async () => {
      const epoch = globalSDK.recovery.epoch()
      if (mobile) await refreshMobileGlobals()
      if (!mobile) await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      if (epoch !== globalSDK.recovery.epoch()) return bootedAt
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => mobile ? refreshMobileGlobals() : queryClient.fetchQuery({ queryKey: ["bootstrap"] }),
    bootstrapInstance,
  })

  function seedMobileSessions(directory: string, child: ReturnType<typeof children.child>) {
    const key = directoryKey(directory)
    if (!mobile || seededSessions.has(key)) return child
    seededSessions.add(key)
    const cached = mobileCache()?.sessions[directory]
    if (cached?.length && child[0].session.length === 0) {
      child[1]("session", reconcile([...cached].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), { key: "id" }))
      child[1]("sessionTotal", cached.length)
    }
    return child
  }

  const children = createChildStoreManager({
    owner,
    displayCache,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory, store) => {
      if (displayCache) captureDirectory(displayCache, directory, store)
      const key = directoryKey(directory)
      queue.clear(key)
      pendingLoads.delete(key)
      pendingRequestRevision.delete(key)
      sessionEventRevision.delete(key)
      sessionMeta.delete(key)
      seededSessions.delete(key)
      sdkCache.delete(key)
      clearProviderRev(key)
      clearSessionPrefetchDirectory(key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { force?: boolean; reconcile?: boolean }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) return pending

    children.pin(key)
    const [store, setStore] = seedMobileSessions(directory, children.child(directory, { bootstrap: false }))
    if (!online()) {
      children.unpin(key)
      return false
    }
    const revision = projectSessionRevision(store)
    const epoch = globalSDK.recovery.epoch()
    const eventRevision = sessionEventRevision.get(key) ?? 0
    const meta = sessionMeta.get(key)
    if (!options?.force && meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
        recentLimit: mobile ? 0 : undefined,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      children.unpin(key)
      return true
    }

    const requestedLimit = store.limit
    const limit = mobile ? requestedLimit : Math.max(requestedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const known = (mobile && store.session.some((session) => !session.parentID && session.directory === directory)) ||
      (!mobile && (options?.reconcile || (displayCache?.directories.has(directory) && !meta)))
      ? store.session
          .filter((s) => !s.parentID && s.directory === directory && !s.time.archived)
          .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
          .slice(0, 200)
          .map((s) => ({ id: s.id, title: s.title, updated: s.time.updated ?? s.time.created }))
      : undefined
    const rememberSessions = () => {
      if (!mobile) return
      sendMobileCache({
        type: "sessions",
        directory,
        sessions: store.session
          .filter((session) => !session.parentID && session.directory === directory && !session.time.archived)
          .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
          .slice(0, 20)
          .map((session) => ({
            id: session.id, directory: session.directory, projectID: session.projectID,
            slug: session.slug, title: session.title, version: session.version,
            time: { created: session.time.created, updated: session.time.updated },
          })),
      })
    }
    let retry = false
    if (mobile) setMobileStatus("sessions", key, "loading")
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        retry: mobile ? 0 : undefined,
        queryFn: async (context) => {
          const controller = mobile ? new AbortController() : undefined
          const unlink = controller ? linkAbortSignals(controller, [context.signal, globalSDK.recovery.signal()!]) : undefined
          // One deadline covers pagination and older-server fallbacks, not the event stream.
          const timeout = controller
            ? setTimeout(() => controller.abort(new DOMException("Session load timed out", "TimeoutError")), 10_000)
            : undefined
          const sdk = controller ? globalSDK.createClient({
            signal: controller.signal,
            throwOnError: true,
          }) : globalSDK.client
          try {
            const cached = displayCache?.directories.get(directory)
            const cursor = cached?.cursor
            const feed = await loadSidebarFeed({
              sdk, directory, cursor,
              snapshot: !!cursor && store.session.filter((s) => !s.parentID).length < requestedLimit,
              limit: cursor ? requestedLimit : Math.max(55, requestedLimit),
            })
            if (feed === "expired") {
              const snapshot = await loadSidebarFeed({ sdk, directory, limit: Math.max(55, requestedLimit) })
              if (snapshot && snapshot !== "expired") return { feed: snapshot }
              if (snapshot === "expired") throw new Error("Sidebar snapshot expired")
            }
            if (feed && feed !== "expired") return { feed }
            if (known) {
              const result = await sdk.session.reconcile(
                { directory, known, limit: Math.min(limit, 200) },
                { throwOnError: false },
              ).catch((error: unknown) => {
                if (error instanceof Error && error.message === "Request is not supported by this version of OpenCode Server (Server responded with text/html)") return undefined
                throw error
              })
              if (result && !result.response) throw result.error ?? new Error("Session reconciliation unavailable")
              // Older servers return the SPA HTML for unknown API routes.
              if (result && result.response.status !== 404 && !(result.response.ok && !result.response.headers.get("content-type")?.includes("json"))) {
                if (!result.data || !Array.isArray(result.data.upserts) || !Array.isArray(result.data.removed))
                  throw result.error ?? new Error("Invalid session reconciliation")
                return { changes: result.data }
              }
            }
            return {
              snapshot: await (mobile
                ? sdk.experimental.session.list({ directory, roots: true, limit }).then((x) => ({
                    data: x.data,
                    limit,
                    limited: true,
                  }))
                : loadRootSessionsWithFallback({
                    directory,
                    limit,
                    list: (query) => sdk.session.list(query),
                  })),
            }
          } finally {
            clearTimeout(timeout)
            unlink?.()
          }
        },
      })
      .then((x) => {
               if (disposed || epoch !== globalSDK.recovery.epoch() || children.children[key]?.[0] !== store || projectSessionRevision(store) !== revision) return false
               if ((sessionEventRevision.get(key) ?? 0) !== eventRevision) {
                 retry = true
                 return false
               }
               if (x.feed) {
                 if (x.feed.kind === "changes") for (const change of x.feed.changes) {
                   if (change.type === "remove") transcript.remove(directory, change.id)
                 }
                 applySidebarFeed({
                   store, setStore, feed: x.feed,
                   recentLimit: mobile ? 0 : undefined,
                   clearTodo: (id) => setSessionTodo(id, undefined),
                 })
                 if (displayCache) {
                    if (!displayCache.directories.has(directory)) captureDirectory(displayCache, directory, store)
                    const entry = displayCache.directories.get(directory)
                     if (entry) {
                       entry.cursor = x.feed.cursor
                     }
                 }
                 sessionMeta.set(key, { limit: requestedLimit })
                 rememberSessions()
                 return true
               }
               if (x.changes) {
                 for (const id of x.changes.removed) transcript.remove(directory, id)
                applySessionReconciliation({
                  store, setStore, changes: x.changes,
                  recentLimit: mobile ? 0 : undefined,
                  clearTodo: (id) => setSessionTodo(id, undefined),
                })
                 sessionMeta.set(key, { limit: requestedLimit })
                  if (displayCache?.directories.get(directory)) {
                    delete displayCache.directories.get(directory)!.cursor
                  }
                rememberSessions()
                return true
              }
              const snapshot = x.snapshot
              if (!snapshot) throw new Error("Invalid session snapshot")
              if (mobile && !snapshot.data) throw new Error("Invalid session snapshot")
              const nonArchived = (snapshot.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => s.directory === directory)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = store.limit
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
                recentLimit: mobile ? 0 : undefined,
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: mobile ? (snapshot.data?.length ?? 0) : nonArchived.length,
                    limit: snapshot.limit,
                    limited: snapshot.limited,
                  }),
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
              })
               sessionMeta.set(key, { limit: requestedLimit })
                if (displayCache?.directories.get(directory)) {
                  delete displayCache.directories.get(directory)!.cursor
                }
              rememberSessions()
              return true
            })
      .catch((err) => {
        if (epoch !== globalSDK.recovery.epoch()) return false
        console.error("Failed to load sessions", err)
        if (mobile) {
          setMobileStatus("sessions", key, "error")
          return false
        }
        const project = getFilename(directory)
        showToast({
          variant: "error",
          title: language.t("toast.session.listFailed.title", { project }),
          description: formatServerError(err, language.t),
        })
        return false
      }).then((result) => {
        if (mobile && result && epoch === globalSDK.recovery.epoch()) setMobileStatus("sessions", key, "ready")
        return result
      })

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      if (sessionLoads.get(key) === promise) sessionLoads.delete(key)
      children.unpin(key)
      if (retry && !disposed && epoch === globalSDK.recovery.epoch() && children.children[key]?.[0] === store && projectSessionRevision(store) === revision)
        void loadSessions(directory, { force: true })
    })
    return promise
  }

  function refreshPending(directory: string) {
    if (!online()) return Promise.resolve()
    const key = directoryKey(directory)
    if (!key) return Promise.resolve()
    const inflight = pendingLoads.get(key)
    if (inflight) return inflight

    const [store, setStore] = children.child(directory, { bootstrap: false })
    const sdk = sdkFor(directory)
    const revision = projectSessionRevision(store)
    const epoch = globalSDK.recovery.epoch()
    const eventRevision = pendingRequestRevision.get(key) ?? 0
    let changed = false
    const request = Promise.all([sdk.permission.list(), sdk.question.list()])
      .then(async ([permissionsResult, questionsResult]) => {
        if (epoch !== globalSDK.recovery.epoch() || disposed) return
        const permissions = (permissionsResult.data ?? []).filter(
          (item): item is PermissionRequest => !!item?.id && !!item.sessionID,
        )
        const questions = (questionsResult.data ?? []).filter(
          (item): item is QuestionRequest => !!item?.id && !!item.sessionID,
        )
        const known = new Set(store.session.map((session) => session.id))
        const ids = [...new Set([...permissions, ...questions].map((item) => item.sessionID))]
          .filter((id) => !known.has(id))
        const sessions = await Promise.all(ids.map((sessionID) =>
          sdk.session.get({ sessionID }).then((result) => result.data).catch(() => undefined),
        ))
        if (epoch !== globalSDK.recovery.epoch() || disposed || children.children[key]?.[0] !== store || projectSessionRevision(store) !== revision) return
        if ((pendingRequestRevision.get(key) ?? 0) !== eventRevision) {
          changed = true
          return
        }

        batch(() => {
          for (const session of sessions) {
            if (!session?.id) continue
            setStore("session", (items) => {
              if (items.some((item) => item.id === session.id)) return items
              return [...items, session].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            })
          }
          applyPendingRequests({ store, setStore, permissions, questions })
        })
      })
      .catch(() => undefined)
      .finally(() => {
        if (pendingLoads.get(key) === request) pendingLoads.delete(key)
        if (changed && epoch === globalSDK.recovery.epoch()) void refreshPending(directory)
      })
    pendingLoads.set(key, request)
    return request
  }

  async function bootstrapInstance(directory: string) {
    if (!online()) return
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const epoch = globalSDK.recovery.epoch()
    const promise = Promise.resolve().then(async () => {
      if (epoch !== globalSDK.recovery.epoch() || disposed) return
      const child = children.ensureChild(directory)
      const revision = projectSessionRevision(child[0])
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      if (mobile) {
        // Mobile reconnects must not invoke the desktop bootstrap's retry/toast fanout.
        await Promise.allSettled([
          loadSessions(directory), refreshPending(directory),
          sdk.config.get().then((result) => { if (epoch === globalSDK.recovery.epoch() && result.data) child[1]("config", reconcile(result.data, { merge: false })) }),
          sdk.command.list().then((result) => { if (epoch === globalSDK.recovery.epoch()) child[1]("command", result.data ?? []) }),
          queryClient.ensureQueryData(queryOptionsApi.agents(key)).then((data) => { if (epoch === globalSDK.recovery.epoch()) child[1]("agent", data) }),
          sdk.session.status().then((result) => { if (epoch === globalSDK.recovery.epoch()) child[1]("session_status", reconcile(result.data ?? {}, { merge: false })) }),
        ])
        return
      }
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: ((...args: unknown[]) => {
          if (projectSessionRevision(child[0]) !== revision) return
          return (child[1] as (...args: unknown[]) => unknown)(...args)
        }) as (typeof child)[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      if (booting.get(key) === promise) booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  function openProjectFromEvent(directory: string) {
    if (!server.isLocal()) return
    if (!directory || directory === "/") return
    server.projects.open(directory)
    void bootstrapInstance(directory)
    void loadSessions(directory)
  }

  function openGlobalProjectEvent(event: { type: string; properties?: unknown }) {
    if (event.type !== "project.updated") return
    const project = event.properties as Project | undefined
    if (!project?.worktree) return
    openProjectFromEvent(project.worktree)
  }

  function openDirectoryEvent(directory: string, event: { type: string; properties?: unknown }) {
    if (event.type !== "session.created" && event.type !== "session.updated") return
    const session = (event.properties as { info?: { directory?: string; time?: { archived?: number } } } | undefined)
      ?.info
    if (session?.time?.archived) return
    openProjectFromEvent(session?.directory ?? directory)
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      if (mobile && event.type === "server.connected") {
        mobileReconcilePending = true
        mobileRefresh.request()
        return
      }
      for (const directory of projectRestoreDirectories(event, transcript.directories())) transcript.clearDirectory(directory)
      for (const key of projectRestoreDirectories(event, Object.keys(children.children))) {
        const contexts = [...dirSyncContexts.entries()]
          .filter(([directory]) => directoryKey(directory) === key)
          .map(([, context]) => ({ context, sessions: context.invalidate() }))
        const [store, setStore] = children.children[key]
         resetProjectSessions({
          directory: key,
          store,
          setStore,
          sessionMeta,
          sessionLoads,
          clearTodo: (id) => setSessionTodo(id, undefined),
          clearQuery: (directory) =>
            queryClient.removeQueries({ ...queryOptionsApi.sessions(directoryKey(directory)), exact: true }),
         })
         if (displayCache?.directories.get(key)) {
           delete displayCache.directories.get(key)!.cursor
         }
        void loadSessions(key).then(() =>
          Promise.allSettled(
            contexts.flatMap(({ context, sessions }) =>
              sessions.map((id) =>
                context.session
                  .sync(id, { force: true })
                  .then(() => Promise.all([context.session.diff(id), context.session.todo(id)])),
              ),
            ),
          ),
        )
      }
      if (mobile && event.type === "global.disposed") invalidateMobileGlobals()
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (mobile) {
            mobileRefresh.request()
            return
          }
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (mobile) {
          mobileRefresh.request()
          return
        }
        if (recent) return
        transcript.invalidate()
        if (transcript.enabled) for (const context of dirSyncContexts.values()) void context.session.refresh()
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      openGlobalProjectEvent(event)
      return
    }

    if (transcript.event(directory, event) === false) return
    if (event.type === "server.instance.disposed") transcript.invalidate(directory)
    const existing = children.children[key]
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted")
      sessionEventRevision.set(key, (sessionEventRevision.get(key) ?? 0) + 1)
    if (mobile && (event.type.startsWith("permission.") || event.type.startsWith("question."))) {
      pendingRequestRevision.set(key, (pendingRequestRevision.get(key) ?? 0) + 1)
    }
    if (!existing) {
      openDirectoryEvent(directory, event)
      return
    }
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: mobile ? () => mobileRefresh.request() : queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
    if (transcript.enabled && event.type === "session.status" && event.properties.status.type === "idle") {
      if (mobile && window.location.pathname.match(/\/session\/(ses_[^/]+)$/)?.[1] !== event.properties.sessionID) return
      const context = dirSyncContexts.get(directory)
      if (context) void context.session.sync(event.properties.sessionID, { force: true }).catch(() => undefined)
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    if (displayCache) {
      displayCache.projects = globalStore.project.map((project) => ({
        id: project.id, worktree: project.worktree, vcs: project.vcs, name: project.name,
        icon: project.icon && { ...project.icon },
        time: { ...project.time }, sandboxes: [...project.sandboxes],
      }))
    }
    for (const directory of Object.keys(children.children)) {
      if (displayCache) captureDirectory(displayCache, directory, children.children[directory][0])
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (!mobile && displayCache?.directories.size) {
      const directories = [...displayCache.directories.keys()]
      const last = server.projects.last()
      directories.sort((a, b) => Number(b === last) - Number(a === last))
      const timer = setTimeout(() => {
        void (async () => {
          for (const directory of directories) {
            if (disposed) return
            if (sessionMeta.has(directoryKey(directory))) continue
            await loadSessions(directory, { reconcile: true })
          }
        })()
      }, 0)
      onCleanup(() => clearTimeout(timer))
    }
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
           void transcript.ready.then(() => { if (!disposed) void globalSDK.event.start() })
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
         void transcript.ready.then(() => { if (!disposed) void globalSDK.event.start() })
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    refreshPending,
    status: (directory: string) => mobileStatus.sessions[directoryKey(directory)],
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => globalSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [null, "providers"] })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === "providers" })
    },
  }))

  const dirSyncContexts = new Map<string, ReturnType<typeof createDirSyncContext>>()
  const dirSyncContextRefCounts = new Map<string, number>()

  function invalidateMobileGlobals() {
    for (const queryKey of [["config"], [null, "providers"], [null, "path"], ["project"]] as const)
      void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" })
  }

  async function refreshMobileGlobals() {
    if (!online()) return
    const epoch = globalSDK.recovery.epoch()
    await Promise.allSettled([
      queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null), queryOptionsApi.projects(),
    ].map(async (options) => {
      const state = queryClient.getQueryState(options.queryKey)
      if (state?.fetchStatus !== "fetching" && state?.data !== undefined && state.status !== "error" && !state.isInvalidated) return
      const data = await queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn as QueryFunction<unknown>, retry: 0 })
      if (epoch === globalSDK.recovery.epoch() && options.queryKey[0] === "project") setProjects(data as Project[])
    }))
  }

  const mobileRefresh = createMobileRefreshCoordinator(async () => {
    if (!mobile || !online() || disposed) return
    if (mobileReconcilePending) {
      mobileReconcilePending = false
      invalidateMobileGlobals()
      transcript.revalidate()
    }
    const epoch = globalSDK.recovery.epoch()
    const selected = server.projects.last() ?? mobileCache()?.selected
    const directories = new Set([...dirSyncContexts.keys(), ...(selected ? [selected] : [])])
    const sessionID = window.location.pathname.match(/\/session\/(ses_[^/]+)$/)?.[1]
    const current = [...dirSyncContexts.entries()].find(([directory]) =>
      children.children[directoryKey(directory)]?.[0].session.some((session) => session.id === sessionID),
    ) ?? (selected ? [...dirSyncContexts.entries()].find(([directory]) => directoryKey(directory) === directoryKey(selected)) : undefined)
      ?? (dirSyncContexts.size === 1 ? [...dirSyncContexts.entries()][0] : undefined)
    await Promise.allSettled([
      refreshMobileGlobals(),
      ...[...directories].flatMap((directory) => {
        const child = seedMobileSessions(directory, children.child(directory, { bootstrap: false }))
        return [loadSessions(directory, { force: true }), refreshPending(directory),
          sdkFor(directory).session.status().then((result) => {
            if (epoch === globalSDK.recovery.epoch() && children.children[directoryKey(directory)] === child)
              child[1]("session_status", reconcile(result.data ?? {}, { merge: false }))
          }),
        ]
      }),
      // Refresh only the current route, once, never every transcript seen by a context.
      ...(sessionID && current ? [transcript.ready.then(() => {
        if (!online() || disposed || epoch !== globalSDK.recovery.epoch()) return
        return current[1].session.sync(sessionID, { force: true })
      })] : []),
    ])
  })
  onCleanup(() => mobileRefresh.dispose())
  let mobileEpoch = globalSDK.recovery.epoch()
  createEffect(() => {
    if (!mobile) return
    const connected = online()
    const epoch = globalSDK.recovery.epoch()
    if (epoch !== mobileEpoch) {
      mobileEpoch = epoch
      untrack(() => {
        mobileRefresh.cancel()
        transcript.invalidate()
        for (const context of dirSyncContexts.values()) context.recover()
        booting.clear()
        sessionLoads.clear()
        pendingLoads.clear()
        const interrupted = queryClient.getQueryCache().findAll({ fetchStatus: "fetching" })
        void queryClient.cancelQueries({ fetchStatus: "fetching" })
        for (const query of interrupted) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" })
        invalidateMobileGlobals()
      })
    }
    if (connected) {
      mobileRefresh.request(`${epoch}`)
    }
  })

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: (directory: string, options?: Parameters<typeof children.child>[1]) => seedMobileSessions(directory, children.child(directory, options)),
    transcript,
    recovery: globalSDK.recovery,
    peek: (directory: string, options?: Parameters<typeof children.peek>[1]) => seedMobileSessions(directory, children.peek(directory, options)),
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
    createDirSyncContext: (directory: string) => {
      onCleanup(() => {
        dirSyncContextRefCounts.set(directory, (dirSyncContextRefCounts.get(directory) ?? 0) - 1)
        if (dirSyncContextRefCounts.get(directory) === 0) {
          dirSyncContexts.get(directory)?.session.deactivate()
          dirSyncContexts.delete(directory)
          dirSyncContextRefCounts.delete(directory)
        }
      })

      const cached = dirSyncContexts.get(directory)
      if (cached) {
        dirSyncContextRefCounts.set(directory, (dirSyncContextRefCounts.get(directory) ?? 0) + 1)
        return cached
      }
      const ctx = createDirSyncContext(globalSDK.createClient({ directory, throwOnError: true }), directory)
      dirSyncContexts.set(directory, ctx)
      if (mobile) void refreshPending(directory)
      dirSyncContextRefCounts.set(directory, 1)

      return ctx
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps<{ displayCache?: DisplayCache }>) {
  const value = createGlobalSync(props.displayCache)
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}

export function useQueryOptions() {
  return useGlobalSync().queryOptions
}
