// Race cancellation as well as forwarding it: a suspended native fetch may ignore abort.
export function abortable<T>(signal: AbortSignal, task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    if (signal.aborted) return cancel()
    signal.addEventListener("abort", cancel, { once: true })
    Promise.resolve().then(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel))
  })
}

export function linkAbortSignals(controller: AbortController, signals: AbortSignal[]) {
  const cleanup = signals.flatMap((signal) => {
    if (controller.signal.aborted) return []
    if (signal.aborted) {
      controller.abort(signal.reason)
      return []
    }
    const cancel = () => controller.abort(signal.reason)
    signal.addEventListener("abort", cancel, { once: true })
    return [() => signal.removeEventListener("abort", cancel)]
  })
  return () => cleanup.forEach((remove) => remove())
}

export function createMobileReadTransport(fetcher: typeof fetch, available = () => true, timeout = 10_000) {
  let controller = new AbortController()
  return {
    signal: () => controller.signal,
    invalidate() {
      controller.abort(new DOMException("Mobile read superseded", "AbortError"))
      controller = new AbortController()
    },
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      // Reconciliation is a read-only POST. Other POSTs, including prompts, remain untouched.
      if (request.method !== "GET" && request.method !== "HEAD" &&
        !(request.method === "POST" && new URL(request.url).pathname === "/session/sidebar/reconcile")) return fetcher(request)
      if (!available()) throw new DOMException("Mobile connection unavailable", "AbortError")
      const deadline = new AbortController()
      const unlink = linkAbortSignals(deadline, [request.signal, controller.signal])
      const signal = deadline.signal
      const timer = setTimeout(() => deadline.abort(new DOMException("Mobile read timed out", "TimeoutError")), timeout)
      try {
        return await abortable(signal, async () => {
          const response = await fetcher(new Request(request, { signal }))
          // Ordinary SDK reads are finite. Keep the deadline until the complete body arrives.
          const feed = /\/session\/[^/]+\/transcript\/(snapshot|changes)$/.test(new URL(request.url).pathname)
          const chunks: Uint8Array[] = []
          const reader = feed ? response.body?.getReader() : undefined
          let size = 0
          if (reader) {
            try {
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.byteLength
                // The server permits one oversized whole entity. Never silently acknowledge a prefix.
                if (size > 32 * 1024 * 1024) {
                  await reader.cancel()
                  throw new Error("Transcript feed response exceeds the 32 MiB client limit")
                }
                chunks.push(chunk.value)
              }
            } finally { reader.releaseLock() }
          }
          const body = reader ? new Uint8Array(size) : await response.arrayBuffer()
          if (reader) {
            let offset = 0
            for (const chunk of chunks) { (body as Uint8Array).set(chunk, offset); offset += chunk.byteLength }
          }
          if (signal.aborted) throw signal.reason
          const headers = new Headers(response.headers)
          // Let the SDK expose an old server's actual route 404 rather than throwing its HTML interceptor.
          if (feed && response.status === 404 && !headers.has("x-opencode-transcript-feed") &&
            headers.get("content-type")?.includes("text/html")) headers.set("content-type", "text/plain")
          return new Response(request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        })
      } finally {
        clearTimeout(timer)
        unlink()
      }
    }, { preconnect: fetcher.preconnect }),
  }
}
