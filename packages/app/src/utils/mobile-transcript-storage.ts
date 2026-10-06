import type { AsyncStorage } from "@solid-primitives/storage"

type Request = {
  operation: "get" | "set" | "remove"
  scope: string
  document: string
  value?: string
}
type NativeWindow = {
  __HAOLAB_MOBILE__?: unknown
  __HAOLAB_TRANSCRIPTS__?: { scope?: unknown; document?: unknown }
  webkit?: { messageHandlers?: { haolabTranscripts?: { postMessage?: (request: Request) => Promise<unknown> } } }
}
const MAX_BYTES = 16 * 1024 * 1024

export function createMobileTranscriptStorage(input: unknown, timeout = 10_000) {
  if (!input || typeof input !== "object") return
  const host = input as NativeWindow
  const capability = host.__HAOLAB_TRANSCRIPTS__
  const handler = host.webkit?.messageHandlers?.haolabTranscripts
  if (
    host.__HAOLAB_MOBILE__ !== true ||
    typeof capability?.scope !== "string" ||
    capability.scope.length !== 74 ||
    !/^tunnel\.v1\.[a-f0-9]{64}$/.test(capability.scope) ||
    typeof capability.document !== "string" ||
    !capability.document.trim() ||
    typeof handler?.postMessage !== "function"
  )
    return

  // Capture the document-start identity and handler; navigation must create a new adapter.
  const scope = capability.scope
  const document = capability.document
  const postMessage = handler.postMessage.bind(handler)
  const request = async (operation: Request["operation"], key: string, value?: string) => {
    const failure = () => new Error("Native transcript storage unavailable")
    if (
      key !== scope ||
      (operation === "set" && (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_BYTES))
    )
      throw failure()
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      Promise.resolve().then(() =>
        postMessage({ operation, scope, document, ...(operation === "set" ? { value } : {}) }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), timeout)
      }),
    ])
      .then((result) => {
        if (operation !== "get") {
          if (result !== null) throw failure()
          return null
        }
        if (result === null) return null
        if (typeof result !== "string" || new TextEncoder().encode(result).length > MAX_BYTES) throw failure()
        return result
      })
      .catch(() => {
        throw failure()
      })
      .finally(() => clearTimeout(timer))
  }
  const storage: AsyncStorage = {
    getItem: (key) => request("get", key),
    setItem: async (key, value) => {
      await request("set", key, value)
    },
    removeItem: async (key) => {
      await request("remove", key)
    },
  }
  return { scope, storage }
}
