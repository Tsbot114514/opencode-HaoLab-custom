export type MobileConnection = {
  state: "connecting" | "connected" | "offline"
  active: boolean
  revision: number
}

export function validateMobileConnection(value: unknown): MobileConnection | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.state !== "connecting" && input.state !== "connected" && input.state !== "offline") return
  if (typeof input.active !== "boolean" || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) return
  return { state: input.state, active: input.active, revision: input.revision as number }
}

export function readMobileConnection() {
  if (typeof window === "undefined") return
  return validateMobileConnection((window as Window & { __HAOLAB_CONNECTION__?: unknown }).__HAOLAB_CONNECTION__)
}

export function requestMobileConnectionRefresh() {
  if (typeof window === "undefined") return false
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { haolabConnection?: { postMessage: (value: { operation: "refresh" }) => void } } }
  }).webkit?.messageHandlers?.haolabConnection
  if (!handler) return false
  handler.postMessage({ operation: "refresh" })
  return true
}

// Native connection updates and the stream handshake describe the same reconnect.
export function createMobileRefreshCoordinator(refresh: () => Promise<unknown>, now = Date.now) {
  let running: Promise<unknown> | undefined
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision: string | undefined
  let disposed = false
  let queued = false
  const cancel = () => {
    queued = false
    running = undefined
    last = -Infinity
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const request = (key?: string) => {
    if (disposed) return
    const changed = key !== undefined && key !== revision
    if (key !== undefined && !changed) return
    if (changed) {
      revision = key
      cancel()
    }
    if (timer) return
    if (running) { queued = true; return }
    timer = setTimeout(() => {
      timer = undefined
      last = now()
      const task = Promise.resolve().then(refresh).catch(() => undefined).finally(() => {
        if (running !== task) return
        running = undefined
        if (!queued) return
        queued = false
        last = -Infinity
        request()
      })
      running = task
    }, changed ? 0 : Math.max(0, 1500 - (now() - last)))
  }
  return {
    request,
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
