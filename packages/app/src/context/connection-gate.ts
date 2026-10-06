import {
  createComponent,
  createResource,
  onCleanup,
  Show,
  Suspense,
  type Component,
  type JSX,
  type ParentProps,
} from "solid-js"
import { useServer } from "./server"
import { useCheckServerHealth } from "../utils/server-health"
import { serverDisplayCache, type DisplayCache } from "./global-sync/server-cache"
import { desktopCacheKey, desktopCacheStorage, loadDesktopCache } from "./global-sync/desktop-cache"
import { usePlatform } from "./platform"

export function ConnectionGate(
  props: ParentProps<{
    displayCache?: DisplayCache
    disableHealthCheck?: boolean
    loading: JSX.Element
    error: () => JSX.Element
  }>,
) {
  const server = useServer()
  const check = useCheckServerHealth()
  const [health, actions] = createResource(
    () => server.current,
    async (connection) => props.disableHealthCheck || (await check(connection.http)).healthy,
  )
  // A matching snapshot permits display, not authorization or a claim that the server is online.
  const cached = () =>
    props.displayCache === serverDisplayCache(server.key, server.current) &&
    !!(props.displayCache?.projects.length || props.displayCache?.directories.size)
  const retry = setInterval(() => {
    if (!props.disableHealthCheck && !health.loading && health.latest === false) void actions.refetch()
  }, 1000)
  onCleanup(() => clearInterval(retry))
  return createComponent(Suspense, {
    get fallback() {
      return props.loading
    },
    get children() {
      return createComponent(Show<boolean | undefined, () => JSX.Element>, {
        keyed: true,
        get when() {
          return cached() || props.disableHealthCheck || health()
        },
        get fallback() {
          return props.error()
        },
        get children() {
          return props.children
        },
      })
    },
  })
}

export function ServerCache(props: { children: (cache: DisplayCache) => JSX.Element }) {
  const server = useServer()
  const platform = usePlatform()
  const [cache] = createResource(
    () => server.ready() && ([server.key, server.current] as const),
    async ([key, connection]) => {
      const snapshot = serverDisplayCache(key, connection)
      if (!snapshot) return
      const diskKey = platform.platform === "desktop" ? desktopCacheKey(connection) : undefined
      if (diskKey) await loadDesktopCache(desktopCacheStorage(platform.storage), snapshot, diskKey)
      return snapshot
    },
  )
  return createComponent(
    Show as Component<{ when: DisplayCache | undefined; keyed: true; children: (cache: DisplayCache) => JSX.Element }>,
    {
      get when() {
        return !cache.loading && cache() === serverDisplayCache(server.key, server.current) ? cache() : undefined
      },
      keyed: true,
      children: props.children,
    },
  )
}
