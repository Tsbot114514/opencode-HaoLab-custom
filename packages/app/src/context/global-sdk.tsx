import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, createEffect, onCleanup, onMount, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { abortable, createMobileReadTransport } from "@/utils/mobile-request"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const mobile = typeof window !== "undefined" && (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true
    const abort = new AbortController()
    const [recovery, setRecovery] = createStore({ epoch: 0, reachable: server.connection.state() === "connected" })
    const available = () => !mobile || (recovery.reachable && server.connection.active() && server.connection.state() !== "offline")
    const reads = mobile ? createMobileReadTransport(platform.fetch ?? globalThis.fetch, available) : undefined
    let connection = untrack(() => ({ revision: server.connection.revision(), blocked: !server.connection.active() || server.connection.state() === "offline" }))
    const invalidateReads = () => {
      if (!reads) return
      reads.invalidate()
      setRecovery("epoch", (epoch) => epoch + 1)
    }

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: mobile ? Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return abortable(request.signal, () => (eventFetch ?? globalThis.fetch)(request))
      }, { preconnect: eventFetch?.preconnect ?? globalThis.fetch.preconnect }) : eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250

    let queue: Queued[] = []
    let buffer: Queued[] = []
    const coalesced = new Map<string, number>()
    const staleDeltas = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()
      staleDeltas.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (skip && event.payload.type === "message.part.delta") {
            const props = event.payload.properties
            if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
          }
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = isAbortError

    let attempt: AbortController | undefined
    let run: Promise<void> | undefined
    let started = false
    // Mobile permits three missed ten-second protocol heartbeats, including comment frames.
    const HEARTBEAT_TIMEOUT_MS = mobile ? 30_000 : 15_000
    let streamRevision = 0
    let failures = 0
    let wake: (() => void) | undefined
    const pause = (ms: number) => mobile ? new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); wake = undefined; resolve() }
      const timer = setTimeout(done, ms)
      wake = done
    }) : wait(ms)
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          if (!available()) {
            await pause(30_000)
            continue
          }
          attempt = new AbortController()
          const controller = attempt
          const revision = streamRevision
          const connectedAt = Date.now()
          lastEventAt = Date.now()
          const onAbort = () => {
            controller.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          // Bound header acquisition too; the generated stream starts fetching on iteration.
          if (mobile) resetHeartbeat()
          try {
            const events = await eventSdk.global.event({
              signal: attempt.signal,
              sseDefaultRetryDelay: mobile ? 1000 : undefined,
              sseMaxRetryAttempts: mobile ? 0 : undefined,
              onSseEvent: mobile ? (frame) => {
                if (controller.signal.aborted) return
                resetHeartbeat()
                const handshake = frame.data !== null && typeof frame.data === "object" && "payload" in frame.data &&
                  (frame.data.payload as { type?: string } | undefined)?.type === "server.connected"
                if (!handshake && Date.now() - connectedAt >= 10_000) failures = 0
              } : undefined,
              onSseError: (error) => {
                if (aborted(error)) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                console.error("[global-sdk] event stream error", {
                  url: currentServer.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            let yielded = Date.now()
            resetHeartbeat()
            for await (const event of events.stream) {
              if (attempt.signal.aborted) break
              resetHeartbeat()
              streamErrorLogged = false
              const directory = event.directory ?? "global"
              if (event.payload.type === "sync") {
                continue
              }

              const payload = event.payload as Event

              const k = key(directory, payload)
              if (k) {
                const i = coalesced.get(k)
                if (i !== undefined) {
                  queue[i] = { directory, payload }
                  if (payload.type === "message.part.updated") {
                    const part = payload.properties.part
                    staleDeltas.add(deltaKey(directory, part.messageID, part.id))
                  }
                  continue
                }
                coalesced.set(k, queue.length)
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            clearHeartbeat()
          }

          if (abort.signal.aborted || !started) return
          if (mobile && revision !== streamRevision) continue
          const delay = mobile ? Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000) * (0.75 + Math.random() * 0.25) : RECONNECT_DELAY_MS
          await pause(delay)
        }
      })().finally(() => {
        run = undefined
        flush()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      clearHeartbeat()
      wake?.()
    }

    const reconnect = () => {
      streamRevision++
      failures = 0
      attempt?.abort()
      wake?.()
      if (!started) return start()
      return run
    }
    createEffect(() => {
      if (!mobile) return
      const revision = server.connection.revision()
      const state = server.connection.state()
      const blocked = !server.connection.active() || state === "offline"
      const changed = revision !== connection.revision || (blocked && !connection.blocked)
      const resumed = connection.blocked && !blocked
      const reachable = untrack(() => recovery.reachable)
      connection = { revision, blocked }
      if (changed || blocked) setRecovery("reachable", false)
      if (!blocked && state === "connected") setRecovery("reachable", true)
      if (changed) {
        invalidateReads()
        streamRevision++
        failures = 0
        attempt?.abort()
        wake?.()
        // Events buffered before a genuine recovery boundary are obsolete.
        queue.length = 0
        coalesced.clear()
        staleDeltas.clear()
      }
      if (resumed || (!reachable && !blocked && state === "connected")) wake?.()
    })

    onMount(() => {
      makeEventListener(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        if (mobile) return
        if (!started) return
        if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
        attempt?.abort()
      })
    })

    onCleanup(() => {
      stop()
      abort.abort()
      reads?.invalidate()
      flush()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: reads?.fetch ?? platform.fetch,
      throwOnError: true,
    })

    const dirSyncContexts = new Map<string, ReturnType<typeof createDirSdkContext>>()
    const dirSdkContextRefCounts = new Map<string, number>()

    return {
      url: currentServer.http.url,
      client: sdk,
      recovery: {
        epoch: () => recovery.epoch,
        signal: () => reads?.signal(),
        available,
        invalidate: invalidateReads,
      },
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
        reconnect,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: reads?.fetch ?? platform.fetch,
          ...opts,
        })
      },
      createDirSyncContext: (directory: string) => {
        onCleanup(() => {
          dirSdkContextRefCounts.set(directory, (dirSdkContextRefCounts.get(directory) ?? 0) - 1)
          if (dirSdkContextRefCounts.get(directory) === 0) {
            dirSyncContexts.delete(directory)
            dirSdkContextRefCounts.delete(directory)
          }
        })

        const cached = dirSyncContexts.get(directory)
        if (cached) {
          dirSdkContextRefCounts.set(directory, (dirSdkContextRefCounts.get(directory) ?? 0) + 1)
          return cached
        }
        const ctx = createDirSdkContext(directory)
        dirSyncContexts.set(directory, ctx)
        dirSdkContextRefCounts.set(directory, 1)

        return ctx
      },
    }
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

function createDirSdkContext(directory: string) {
  const globalSDK = useGlobalSDK()

  const client = globalSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = globalSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    directory,
    client,
    event: emitter,
    get url() {
      return globalSDK.url
    },
    createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
      return globalSDK.createClient(opts)
    },
  }
}
