import type { Config, OpencodeClient, Path, Project, ProviderAuthResponse, Todo } from "@opencode-ai/sdk/v2/client"
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
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { projectRestoreDirectories, projectSessionRevision, resetProjectSessions } from "./global-sync/project-restore"
import { useServer } from "./server"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { desktopCacheKey } from "./global-sync/desktop-cache"
import { createTranscriptCache, TRANSCRIPT_STORE } from "./global-sync/transcript-cache"

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

export const loadMcpQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadLspQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(globalSDK: () => OpencodeClient, sdkFor: (dir: PathKey) => OpencodeClient) {
  return {
    globalConfig: () => loadGlobalConfigQuery(globalSDK()),
    projects: () => loadProjectsQuery(globalSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(directory, directory === null ? globalSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) => loadPathQuery(directory, directory === null ? globalSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(directory, sdkFor(directory)),
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
    platform.platform === "desktop" ? platform.storage?.(TRANSCRIPT_STORE) : undefined,
    platform.platform === "desktop" ? desktopCacheKey(server.current) : undefined,
  )
  onCleanup(() => transcript.dispose())
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<boolean>>()
  const sessionEventRevision = new Map<string, number>()
  const sessionMeta = new Map<string, { limit: number }>()
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

  const queryOptionsApi = makeQueryOptionsApi(() => globalSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
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
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })
  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
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
    queryFn: async () => {
      await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
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
    bootstrap: () => queryClient.fetchQuery({ queryKey: ["bootstrap"] }),
    bootstrapInstance,
  })

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
      sessionEventRevision.delete(key)
      sessionMeta.delete(key)
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
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const revision = projectSessionRevision(store)
    const eventRevision = sessionEventRevision.get(key) ?? 0
    const meta = sessionMeta.get(key)
    if (!options?.force && meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      children.unpin(key)
      return true
    }

    const requestedLimit = store.limit
    const limit = Math.max(requestedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const known = options?.reconcile || (displayCache?.directories.has(directory) && !meta)
      ? store.session
          .filter((s) => !s.parentID && s.directory === directory && !s.time.archived)
          .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
          .slice(0, 200)
          .map((s) => ({ id: s.id, title: s.title, updated: s.time.updated ?? s.time.created }))
      : undefined
    let retry = false
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: async () => {
          const cached = displayCache?.directories.get(directory)
          const cursor = cached?.cursor
          const feed = await loadSidebarFeed({
            sdk: globalSDK.client, directory, cursor,
            snapshot: !!cursor && store.session.filter((s) => !s.parentID).length < requestedLimit,
            limit: cursor ? requestedLimit : Math.max(55, requestedLimit),
          })
          if (feed === "expired") {
            const snapshot = await loadSidebarFeed({ sdk: globalSDK.client, directory, limit: Math.max(55, requestedLimit) })
            if (snapshot && snapshot !== "expired") return { feed: snapshot }
            if (snapshot === "expired") throw new Error("Sidebar snapshot expired")
          }
          if (feed && feed !== "expired") return { feed }
          if (known) {
            const result = await globalSDK.client.session.reconcile(
              { directory, known, limit: Math.min(limit, 200) },
              { throwOnError: false },
            ).catch((error: unknown) => {
              if (error instanceof Error && error.message === "Request is not supported by this version of OpenCode Server (Server responded with text/html)") return undefined
              throw error
            })
            // Older servers return the SPA HTML for unknown API routes.
            if (result && result.response.status !== 404 && !(result.response.ok && !result.response.headers.get("content-type")?.includes("json"))) {
              if (!result.data || !Array.isArray(result.data.upserts) || !Array.isArray(result.data.removed))
                throw result.error ?? new Error("Invalid session reconciliation")
              return { changes: result.data }
            }
          }
          return {
            snapshot: await loadRootSessionsWithFallback({
                  directory,
                  limit,
                  list: (query) => globalSDK.client.session.list(query),
                }),
          }
        },
      })
      .then((x) => {
               if (disposed || children.children[key]?.[0] !== store || projectSessionRevision(store) !== revision) return false
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
                 return true
               }
               if (x.changes) {
                 for (const id of x.changes.removed) transcript.remove(directory, id)
                applySessionReconciliation({
                  store, setStore, changes: x.changes,
                  clearTodo: (id) => setSessionTodo(id, undefined),
                })
                 sessionMeta.set(key, { limit: requestedLimit })
                  if (displayCache?.directories.get(directory)) {
                    delete displayCache.directories.get(directory)!.cursor
                  }
                return true
              }
              const snapshot = x.snapshot
              if (!snapshot) throw new Error("Invalid session snapshot")
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
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
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
              return true
            })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({
          variant: "error",
          title: language.t("toast.session.listFailed.title", { project }),
          description: formatServerError(err, language.t),
        })
        return false
      })

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      if (sessionLoads.get(key) === promise) sessionLoads.delete(key)
      children.unpin(key)
      if (retry && !disposed && children.children[key]?.[0] === store && projectSessionRevision(store) === revision)
        void loadSessions(directory, { force: true })
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const revision = projectSessionRevision(child[0])
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
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
      booting.delete(key)
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
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
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

    transcript.event(directory, event)
    if (event.type === "server.instance.disposed") transcript.invalidate(directory)
    const existing = children.children[key]
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted")
      sessionEventRevision.set(key, (sessionEventRevision.get(key) ?? 0) + 1)
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
      push: queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
    if (transcript.enabled && event.type === "session.status" && event.properties.status.type === "idle") {
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
    if (displayCache?.directories.size) {
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

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    transcript,
    peek: children.peek,
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
