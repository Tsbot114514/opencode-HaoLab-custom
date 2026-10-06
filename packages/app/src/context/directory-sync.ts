import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import {
  clearSessionPrefetch,
  clearSessionPrefetchDirectory,
  clearSessionPrefetchInflight,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useGlobalSync } from "./global-sync"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { compareMessages, findMessage } from "@/utils/message-order"
import { projectSessionRevision } from "./global-sync/project-restore"
import { sendMobileCache, type MobileTranscript, type MobileTranscriptMessage } from "./server"
import { transcriptCursor, type TranscriptCache } from "./global-sync/transcript-cache"
import { decodeTranscriptChanges, decodeTranscriptSnapshot } from "../utils/transcript-feed"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function projectMobileTranscript(directory: string, sessionID: string, items: { info: Message; parts: Part[] }[]): MobileTranscript {
  const ids = new Set<string>()
  const messages: MobileTranscriptMessage[] = []
  for (const item of [...items].sort((a, b) => compareMessages(a.info, b.info)).slice(-20)) {
    const info = item.info
    if (info.sessionID !== sessionID || !info.id?.trim() || ids.has(info.id) ||
      (info.role !== "user" && info.role !== "assistant") || !Number.isFinite(info.time.created) ||
      (info.role === "assistant" && info.error)) continue
    ids.add(info.id)
    const text = item.parts.flatMap((part) => part.sessionID === sessionID && part.messageID === info.id &&
      part.type === "text" && !part.synthetic &&
      typeof part.text === "string" && part.text.trim() ? [part.text] : [])
    if (!text.length || text.some((part) => part.length > 6000)) continue
    const joined = text.join("\n")
    if (joined.length > 6000) continue
    messages.push({ id: info.id, role: info.role, created: info.time.created, text: joined,
      ...(info.role === "assistant" && info.parentID ? { parentID: info.parentID } : {}) })
  }
  return { directory, sessionID, messages }
}

function merge(a: readonly Message[], b: readonly Message[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort(compareMessages)
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const index = findMessage(session, item.message.id)
    const found = index >= 0
    if (!found) session.push(item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session: session.sort(compareMessages),
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    messages.push(input.message)
    messages.sort(compareMessages)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const index = findMessage(messages, input.messageID)
    if (index >= 0) messages.splice(index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    return [...messages, input.message].sort(compareMessages)
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const index = findMessage(messages, input.messageID)
    if (index < 0) return messages
    const next = [...messages]
    next.splice(index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const createDirSyncContext = (
  client: OpencodeClient,
  directory: string,
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child" | "todo"> & {
    data: Pick<ReturnType<typeof useGlobalSync>["data"], "project" | "session_todo">
    transcript?: TranscriptCache
    recovery?: { epoch: () => number; signal: () => AbortSignal | undefined }
  } = useGlobalSync(),
) => {
  type Child = ReturnType<(typeof globalSync)["child"]>
  type Setter = Child[1]

  const current = createMemo(() => globalSync.child(directory))
  const target = (directory?: string) => {
    if (!directory || directory === directory) return current()
    return globalSync.child(directory)
  }
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const mobile = typeof window !== "undefined" && (window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true
  const initialMessagePageSize = 20
  const historyMessagePageSize = 20
  const inflight = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const feedDeferred = new Set<string>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const maxDirs = 30
  const seen = new Map<string, Set<string>>()
  let revision = 0
  const version = () => `${revision}:${projectSessionRevision(current()[0])}:${globalSync.recovery?.epoch() ?? 0}`
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
    history: {} as Record<string, boolean>,
    error: {} as Record<string, string | undefined>,
  })

  const getSession = (sessionID: string) => {
    const store = current()[0]
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    if (match.found) return store.session[match.index]
    return undefined
  }

  const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
    const key = keyFor(directory, sessionID)
    const list = optimistic.get(key)
    if (list) {
      list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
      return
    }
    optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
  }

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }

    const list = optimistic.get(key)
    if (!list) return
    list.delete(messageID)
    if (list.size === 0) optimistic.delete(key)
  }

  const getOptimistic = (directory: string, sessionID: string) => [
    ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
  ]

  const seenFor = (directory: string) => {
    const existing = seen.get(directory)
    if (existing) {
      seen.delete(directory)
      seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.set(directory, created)
    while (seen.size > maxDirs) {
      const first = seen.keys().next().value
      if (!first) break
      const stale = [...(seen.get(first) ?? [])]
      seen.delete(first)
      const [, setStore] = globalSync.child(first, { bootstrap: false })
      evict(first, setStore, stale)
    }
    return created
  }

  const clearMeta = (directory: string, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) {
      clearOptimistic(directory, sessionID)
      feedDeferred.delete(keyFor(directory, sessionID))
      globalSync.transcript?.deactivate(directory, sessionID)
    }
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          const key = keyFor(directory, sessionID)
          delete draft.limit[key]
          delete draft.cursor[key]
          delete draft.complete[key]
           delete draft.loading[key]
           delete draft.history[key]
           delete draft.error[key]
        }
      }),
    )
  }

  const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    clearSessionPrefetch(directory, sessionIDs)
    for (const sessionID of sessionIDs) {
      globalSync.todo.set(sessionID, undefined)
    }
    setStore(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    clearMeta(directory, sessionIDs)
  }

  const touch = (directory: string, setStore: Setter, sessionID: string) => {
    const stale = pickSessionCacheEvictions({
      seen: seenFor(directory),
      keep: sessionID,
      limit: SESSION_CACHE_LIMIT,
    })
    evict(directory, setStore, stale)
  }

  const fetchMessages = async (input: { client: typeof client; sessionID: string; limit: number; before?: string }) => {
    const signal = mobile ? globalSync.recovery?.signal() : undefined
    const messages = await retry(() =>
      input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }, signal ? { signal } : undefined),
    )
    const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
    const session = items.map((x) => clean(x.info)).sort(compareMessages)
    const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
    const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
    return {
      session,
      part,
      cursor,
      complete: !cursor,
      transcript: !input.before && mobile && (!globalSync.transcript?.enabled || globalSync.transcript.persistenceError())
        ? projectMobileTranscript(directory, input.sessionID, items)
        : undefined,
    }
  }

  const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const loadMessages = async (input: {
    directory: string
    client: typeof client
    setStore: Setter
    sessionID: string
    limit: number
    before?: string
    mode?: "replace" | "prepend" | "refresh"
    local?: boolean
    attempt?: number
    authority?: Promise<boolean>
    preservePagination?: boolean
    waitValidation?: boolean
  }): Promise<void> => {
    const key = keyFor(input.directory, input.sessionID)
    const captured = version()
    const [store] = globalSync.child(input.directory, { bootstrap: false })
    const before = input.before ? store.message[input.sessionID]?.find((message) => transcriptCursor(message) === input.before) : undefined
    if (input.local) await globalSync.transcript?.ensureSelected(input.directory, input.sessionID, input.before)
    const local = input.local
      ? globalSync.transcript?.read(input.directory, input.sessionID, input.limit, input.before)
      : undefined

    if (!local) setMeta("loading", key, true)
    const eventRevision = globalSync.transcript?.revision(input.directory, input.sessionID)
    const sessionRevision = globalSync.transcript?.sessionRevision(input.directory, input.sessionID)
    const tailRevision = globalSync.transcript?.tailRevision(input.directory, input.sessionID)
    const rangeRevision = globalSync.transcript?.rangeRevision(input.directory, input.sessionID) ?? 0
    const ownership = { revalidate: false }
    const grant = !local ? globalSync.transcript?.beginFetch(input.directory, input.sessionID, () => { ownership.revalidate = true }) : undefined
    if (captured !== version()) return
    const read = async () => {
      if (local) return { ...local, local: true, transcript: undefined }
      const page = await fetchMessages(input)
      await grant
      // A delayed grant must never authorize a body fetched before a canonical change.
      if (ownership.revalidate) return { ...await fetchMessages(input), local: false }
      return { ...page, local: false }
    }
    const applied = await Promise.all([read(), input.authority ?? Promise.resolve(true), grant])
      .then(([page, authorized, fresh]) => {
        if (!authorized || globalSync.transcript?.deleted(input.directory, input.sessionID)) return
        if (captured !== version()) return
        if (!tracked(input.directory, input.sessionID)) return
        if (eventRevision !== globalSync.transcript?.revision(input.directory, input.sessionID)) return
        if (sessionRevision !== globalSync.transcript?.sessionRevision(input.directory, input.sessionID)) return
        if (tailRevision !== globalSync.transcript?.tailRevision(input.directory, input.sessionID)) return
        if (before && globalSync.transcript?.changedPage(input.directory, input.sessionID, rangeRevision, page, before)) return
        if (input.before && !before) return
        if (page.transcript) sendMobileCache({ type: "transcript", ...page.transcript })
        if (!page.local) {
          const updated = getSession(input.sessionID)?.time.updated
          globalSync.transcript?.write(input.directory, input.sessionID, page, {
            before: input.before,
            updated,
            range: { before },
            fresh,
          })
        }
        const [store] = globalSync.child(input.directory, { bootstrap: false })
        const oldest = store.message[input.sessionID]?.[0]
        const cropped = input.mode === "refresh" && globalSync.transcript?.enabled
          ? meta.history[key] && oldest
            ? page.session.filter((message) => compareMessages(message, oldest) >= 0)
            : page.session.slice(-Math.max(initialMessagePageSize, meta.limit[key] ?? 0))
          : page.session
        // If the whole anchored range was deleted, show the surviving recent range instead.
        const rendered = cropped.length ? cropped : page.session.slice(-initialMessagePageSize)
        const window = rendered.length < page.session.length
          ? {
              ...page,
              session: rendered,
              part: page.part.filter((part) => rendered.some((message) => message.id === part.id)),
              cursor: transcriptCursor(rendered[0]),
              complete: false,
            }
          : page
        const next = mergeOptimisticPage(window, getOptimistic(input.directory, input.sessionID))
        for (const messageID of page.local ? [] : next.confirmed) {
          clearOptimistic(input.directory, input.sessionID, messageID)
        }
        const cached = input.mode === "prepend"
           ? (store.message[input.sessionID] ?? []).filter((message) => page.local ||
              !!before && compareMessages(message, before) >= 0 ||
              !page.complete && !!page.session[0] && compareMessages(message, page.session[0]) < 0)
            : input.mode === "refresh" && meta.history[key] && page.session[0] && !page.complete
            ? (store.message[input.sessionID] ?? []).filter((message) => compareMessages(message, page.session[0]) < 0)
            : []
        const message = cached.length ? merge(cached, next.session) : next.session
        const preserved = input.mode === "refresh" && cached.length > 0 &&
          (!globalSync.transcript?.enabled || !page.cursor || globalSync.transcript.available(input.directory, input.sessionID, page.cursor)) ||
          mobile && input.mode === "prepend" && input.preservePagination
        const cursor = preserved ? meta.cursor[key] : next.cursor
        const complete = preserved ? meta.complete[key] : next.complete
        batch(() => {
          if (input.mode === "refresh" || input.mode === "prepend" && !page.local) input.setStore(produce((draft) => {
            for (const previous of draft.message[input.sessionID] ?? []) {
              if (message.some((item) => item.id === previous.id)) continue
              for (const part of draft.part[previous.id] ?? []) delete draft.part_text_accum_delta[part.id]
              delete draft.part[previous.id]
            }
          }))
          input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
          for (const p of next.part) {
            const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
            input.setStore("part", p.id, filtered)
          }
          setMeta("limit", key, message.length)
          setMeta("cursor", key, cursor)
          setMeta("complete", key, complete)
          if (input.mode === "prepend" && page.session.length) setMeta("history", key, true)
          setSessionPrefetch({
            directory: input.directory,
            sessionID: input.sessionID,
            limit: message.length,
            cursor,
            complete,
          })
        })
        return true
      })
      .finally(() => {
        if (captured !== version()) return
        if (local) return
        setMeta(
          produce((draft) => {
            if (!tracked(input.directory, input.sessionID)) {
              delete draft.loading[key]
              return
            }
            draft.loading[key] = false
          }),
        )
      })
    if (local && captured === version() && tracked(input.directory, input.sessionID) &&
      !globalSync.transcript?.deleted(input.directory, input.sessionID) &&
      !globalSync.transcript?.validatedPage(input.directory, input.sessionID, local, before)) {
      // Offline history is immediately usable; only this requested interval is checked online.
      const validation = runInflight(inflight, `${key}\nvalidate\n${input.before ?? ""}`, () => loadMessages({ ...input, local: false })).catch(() => undefined)
      if (mobile || input.waitValidation) await validation
    }
    if (!applied && !local && captured === version() && tracked(input.directory, input.sessionID) &&
      !globalSync.transcript?.deleted(input.directory, input.sessionID) &&
      (eventRevision !== globalSync.transcript?.revision(input.directory, input.sessionID) ||
        mobile && (sessionRevision !== globalSync.transcript?.sessionRevision(input.directory, input.sessionID) ||
          tailRevision !== globalSync.transcript?.tailRevision(input.directory, input.sessionID) ||
          rangeRevision !== globalSync.transcript?.rangeRevision(input.directory, input.sessionID))) && (input.attempt ?? 0) < 2) {
      await loadMessages({ ...input, attempt: (input.attempt ?? 0) + 1 })
    }
  }

  const syncFeed = async (sessionID: string, setStore: Setter, captured: string) => {
    const cache = globalSync.transcript
    if (!mobile || !cache?.enabled || cache.feedCapability() === false) return false
    const key = keyFor(directory, sessionID)
    feedDeferred.delete(key)
    setMeta("error", key, undefined)
    setMeta("loading", key, true)
    try {
      for (let page = 0; page < 256; page++) {
        const token = cache.beginFeed(directory, sessionID)
        const result = token.cursor
          ? await client.session.transcriptChanges({ sessionID, directory, cursor: token.cursor, limit: "100" },
              { throwOnError: false, signal: globalSync.recovery?.signal() })
          : await client.session.transcriptSnapshot({ sessionID, directory, limit: "20" },
              { throwOnError: false, signal: globalSync.recovery?.signal() })
        if (captured !== version() || !tracked(directory, sessionID)) return true
        if (!result.response) throw result.error ?? new Error("Transcript feed unavailable")
        const supported = result.response.headers.get("x-opencode-transcript-feed") === "1"
        if (!supported && result.response.status === 404) {
          cache.setFeedCapability(false)
          cache.resetFeed(directory, sessionID)
          return false
        }
        if (!supported) throw new Error("Unmarked transcript feed response")
        cache.setFeedCapability(true)
        if (result.response.status === 404) {
          const error = result.error as { name?: unknown; data?: { message?: unknown } } | undefined
          if (error?.name !== "NotFoundError" || typeof error.data?.message !== "string") throw new Error("Invalid transcript deletion response")
          cache.remove(directory, sessionID)
          evict(directory, setStore, [sessionID])
          return true
        }
        if (token.cursor && (result.response.status === 410 || result.response.status === 400)) {
          if (result.response.status === 410) {
            const error = result.error as { _tag?: unknown; reason?: unknown } | undefined
            if (error?._tag !== "TranscriptCursorExpiredError" || !["retention", "session-reset", "database-reset"].includes(String(error.reason)))
              throw new Error("Invalid transcript expiration response")
          }
          cache.resetFeed(directory, sessionID)
          continue
        }
        if (!result.response.ok) throw new Error(`Transcript feed request failed (${result.response.status})`)
        const decoded = token.cursor
          ? decodeTranscriptChanges(result.data, directory, sessionID)
          : decodeTranscriptSnapshot(result.data, directory, sessionID)
        if (token.cursor && cache.feedEntry(directory, sessionID)?.syncGeneration !== decoded.generation) {
          cache.resetFeed(directory, sessionID)
          continue
        }
        const [store] = globalSync.child(directory, { bootstrap: false })
        const overlay = { session: [...(store.message[sessionID] ?? [])],
          part: (store.message[sessionID] ?? []).map((info) => ({ id: info.id, part: store.part[info.id] ?? [] })),
          complete: meta.complete[key] ?? true, cursor: meta.cursor[key] }
        const applied = cache.applyFeed(directory, sessionID, token, decoded, overlay)
        if (!applied) {
          if (!cache.deleted(directory, sessionID) && !cache.feedEntry(directory, sessionID)?.syncCursor) feedDeferred.add(key)
          return true
        }
        const entry = applied.entry
        if (applied.metadataSafe && entry.feed?.session.time.archived) {
          cache.remove(directory, sessionID)
          evict(directory, setStore, [sessionID])
          return true
        }
        const oldest = meta.history[key] ? store.message[sessionID]?.[0] : undefined
        const rendered = oldest ? entry.session.filter((message) => compareMessages(message, oldest) >= 0) :
          entry.session.slice(-Math.max(initialMessagePageSize, meta.limit[key] ?? 0))
        const ids = new Set(rendered.map((message) => message.id))
        const next = mergeOptimisticPage({ session: rendered, part: entry.part.filter((item) => ids.has(item.id)),
          complete: entry.complete && rendered.length === entry.session.length,
          cursor: rendered.length < entry.session.length && rendered[0] ? transcriptCursor(rendered[0]) : entry.cursor }, getOptimistic(directory, sessionID))
        for (const id of next.confirmed) clearOptimistic(directory, sessionID, id)
        batch(() => {
          setStore(produce((draft) => {
            for (const previous of draft.message[sessionID] ?? []) {
              if (next.session.some((message) => message.id === previous.id)) continue
              for (const part of draft.part[previous.id] ?? []) delete draft.part_text_accum_delta[part.id]
              delete draft.part[previous.id]
            }
          }))
          setStore("message", sessionID, reconcile(next.session, { key: "id" }))
          for (const item of next.part) {
            for (const part of item.part) setStore("part_text_accum_delta", part.id, undefined!)
            setStore("part", item.id, reconcile(item.part.filter((part) => !SKIP_PARTS.has(part.type)), { key: "id" }))
          }
          const info = applied.metadataSafe ? entry.feed?.session : undefined
          if (info) setStore("session", produce((draft) => {
            const match = Binary.search(draft, sessionID, (session) => session.id)
            if (match.found) draft[match.index] = info
            if (!match.found) draft.splice(match.index, 0, info)
          }))
          if (applied.statusSafe) setStore("session_status", sessionID, decoded.status)
          setMeta("limit", key, next.session.length)
          setMeta("cursor", key, next.cursor)
          setMeta("complete", key, next.complete)
          setSessionPrefetch({ directory, sessionID, limit: next.session.length, cursor: next.cursor, complete: next.complete })
        })
        // Dirty entities stay live and the base cursor stays unchanged. Idle/next handshake retries once, not a busy loop.
        if (!applied.checkpointed) { feedDeferred.add(key); return true }
        if (!("more" in decoded) || !decoded.more) return true
        if (decoded.cursor === token.cursor) throw new Error("Transcript feed cursor did not advance")
      }
      throw new Error("Transcript feed page limit reached; retry to continue")
    } catch (error) {
      if (captured === version()) setMeta("error", key, error instanceof Error ? error.message : "Transcript synchronization failed")
      throw error
    } finally {
      if (captured === version()) setMeta("loading", key, false)
    }
  }

  return {
    recover() {
      // Release obsolete readers without dropping loaded ranges, pagination or optimistic edits.
      revision++
      inflight.clear()
      inflightDiff.clear()
      inflightTodo.clear()
      setMeta("loading", reconcile({}))
      clearSessionPrefetchInflight(directory)
    },
    invalidate() {
      // Existing readers may finish after the replacement, even after a new read starts.
      revision++
      const sessions = [...(seen.get(directory) ?? [])]
      clearMeta(directory, sessions)
      for (const key of optimistic.keys()) if (key.startsWith(`${directory}\n`)) optimistic.delete(key)
      clearSessionPrefetchDirectory(directory)
      seen.delete(directory)
      inflight.clear()
      inflightDiff.clear()
      inflightTodo.clear()
      return sessions
    },
    get data() {
      return current()[0]
    },
    get set(): Setter {
      return current()[1]
    },
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
      if (match.found) return globalSync.data.project[match.index]
      return undefined
    },
    session: {
      get: getSession,
      error: (sessionID: string) => meta.error[keyFor(directory, sessionID)],
      deactivate() { for (const id of seen.get(directory) ?? []) globalSync.transcript?.deactivate(directory, id) },
      refresh() { return Promise.allSettled([...(seen.get(directory) ?? [])].map((id) => this.sync(id, { force: true }))) },
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          setOptimistic(_directory, input.sessionID, { message: input.message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          clearOptimistic(_directory, input.sessionID, input.messageID)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        const message: Message = {
          id: input.messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { ...input.model, variant: input.variant },
        }
        const [, setStore] = target()
        setOptimistic(directory, input.sessionID, { message, parts: input.parts })
        setOptimisticAdd(setStore as (...args: unknown[]) => void, {
          sessionID: input.sessionID,
          message,
          parts: input.parts,
        })
      },
      async sync(sessionID: string, opts?: { force?: boolean }) {
        const captured = version()
        const signal = mobile ? globalSync.recovery?.signal() : undefined
        const [store, setStore] = globalSync.child(directory)
        const key = keyFor(directory, sessionID)

        touch(directory, setStore, sessionID)
        globalSync.transcript?.activate(directory, sessionID)

        const seeded = getSessionPrefetch(directory, sessionID)
        if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
          batch(() => {
            setMeta("limit", key, seeded.limit)
            setMeta("cursor", key, seeded.cursor)
            setMeta("complete", key, seeded.complete)
            setMeta("loading", key, false)
          })
        }

        await globalSync.transcript?.ready
        await globalSync.transcript?.ensureSelected(directory, sessionID)
        if (captured !== version()) return
        const local = meta.limit[key] === undefined && globalSync.transcript?.read(directory, sessionID, initialMessagePageSize)
        if (local) {
          batch(() => {
            const next = mergeOptimisticPage(local, getOptimistic(directory, sessionID))
            setStore("message", sessionID, reconcile(next.session, { key: "id" }))
            for (const part of next.part) setStore("part", part.id, part.part.filter((part) => !SKIP_PARTS.has(part.type)))
            setMeta("limit", key, next.session.length)
            setMeta("cursor", key, local.cursor)
            setMeta("complete", key, local.complete)
          })
        }
        const request = runInflight(inflight, key, async () => {
          const pending = getSessionPrefetchPromise(directory, sessionID)
          if (pending) {
            await pending
            if (captured !== version()) return
            const seeded = getSessionPrefetch(directory, sessionID)
            if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
              batch(() => {
                setMeta("limit", key, seeded.limit)
                setMeta("cursor", key, seeded.cursor)
                setMeta("complete", key, seeded.complete)
                setMeta("loading", key, false)
              })
            }
          }

          const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
          const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
          if (cached && hasSession && !opts?.force && !local) return

          if (await syncFeed(sessionID, setStore, captured)) return

          const limit = mobile || globalSync.transcript?.enabled ? initialMessagePageSize : (meta.limit[key] ?? initialMessagePageSize)
          const readSession = async (attempt = 0): Promise<boolean> => {
            const eventRevision = globalSync.transcript?.sessionRevision(directory, sessionID)
            const session = await retry(() => client.session.get({ sessionID }, { throwOnError: false, ...(signal ? { signal } : {}) }))
            if (captured !== version() || !tracked(directory, sessionID)) return false
            if (eventRevision !== globalSync.transcript?.sessionRevision(directory, sessionID)) {
              if (globalSync.transcript?.deleted(directory, sessionID)) {
                evict(directory, setStore, [sessionID])
                return false
              }
              return attempt < 1 ? readSession(attempt + 1) : false
            }
            if (!session.response) throw session.error ?? new Error("Failed to refresh session")
            if (session.response.status === 404) {
              globalSync.transcript?.remove(directory, sessionID)
              evict(directory, setStore, [sessionID])
            }
            if (!session.response.ok) throw session.error ?? new Error("Failed to refresh session")
             const data = session.data
             if (!data) return false
             if (data.time.archived) {
               globalSync.transcript?.remove(directory, sessionID)
               evict(directory, setStore, [sessionID])
               return false
             }
            setStore("session", produce((draft) => {
              const match = Binary.search(draft, sessionID, (s) => s.id)
              if (match.found) {
                draft[match.index] = data
                return
              }
              draft.splice(match.index, 0, data)
            }))
            return true
          }
          const sessionReq =
            hasSession && !opts?.force && !local
              ? Promise.resolve(true)
              : readSession()

           const messagesReq = loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit,
            mode: cached && (local || opts?.force) ? "refresh" : undefined,
            authority: sessionReq,
           })

          await Promise.all([sessionReq, messagesReq])
        }).then(async () => {
          // An idle event may arrive while the preceding request still owns the in-flight slot.
          // Settle that final race once; an active stream never starts a retry loop.
          if (captured !== version() || !feedDeferred.has(key) || store.session_status[sessionID]?.type !== "idle") return
          feedDeferred.delete(key)
          await runInflight(inflight, key, async () => { await syncFeed(sessionID, setStore, captured) })
        })
        if (!opts?.force && globalSync.transcript?.enabled && store.message[sessionID] !== undefined && meta.limit[key] !== undefined) {
          void request.catch(() => undefined)
          return
        }
        return request
      },
      async diff(sessionID: string, opts?: { force?: boolean }) {
        const captured = version()
        const signal = mobile ? globalSync.recovery?.signal() : undefined
        const [store, setStore] = globalSync.child(directory)
        touch(directory, setStore, sessionID)
        if (store.session_diff[sessionID] !== undefined && !opts?.force) return

        const key = keyFor(directory, sessionID)
        return runInflight(inflightDiff, key, () =>
          retry(() => client.session.diff({ sessionID }, signal ? { signal } : undefined)).then((diff) => {
            if (captured !== version()) return
            if (!tracked(directory, sessionID)) return
            setStore("session_diff", sessionID, reconcile(list(diff.data), { key: "file" }))
          }),
        )
      },
      async todo(sessionID: string, opts?: { force?: boolean }) {
        const captured = version()
        const signal = mobile ? globalSync.recovery?.signal() : undefined
        const [store, setStore] = globalSync.child(directory)
        touch(directory, setStore, sessionID)
        const existing = store.todo[sessionID]
        const cached = globalSync.data.session_todo[sessionID]
        if (existing !== undefined) {
          if (cached === undefined) {
            globalSync.todo.set(sessionID, existing)
          }
          if (!opts?.force) return
        }

        if (cached !== undefined) {
          setStore("todo", sessionID, reconcile(cached, { key: "id" }))
        }

        const key = keyFor(directory, sessionID)
        return runInflight(inflightTodo, key, () =>
          retry(() => client.session.todo({ sessionID }, signal ? { signal } : undefined)).then((todo) => {
            if (captured !== version()) return
            if (!tracked(directory, sessionID)) return
            const list = todo.data ?? []
            setStore("todo", sessionID, reconcile(list, { key: "id" }))
            globalSync.todo.set(sessionID, list)
          }),
        )
      },
      history: {
        provisional(sessionID: string, before?: string, count = historyMessagePageSize) {
          const page = globalSync.transcript?.read(directory, sessionID, count, before, true)
          const boundary = before ? current()[0].message[sessionID]?.find((message) => transcriptCursor(message) === before) : undefined
          return !!globalSync.transcript?.enabled && (!page || !globalSync.transcript.validatedPage(directory, sessionID, page, boundary))
        },
        async validate(sessionID: string, before: string, count = historyMessagePageSize) {
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          await runInflight(inflight, `${keyFor(directory, sessionID)}\n${before}`, () =>
             loadMessages({ directory, client, setStore, sessionID, limit: count, before, mode: "prepend", local: true, preservePagination: true, waitValidation: true }))
        },
        more(sessionID: string) {
          const store = current()[0]
          const key = keyFor(directory, sessionID)
          if (store.message[sessionID] === undefined) return false
          if (meta.limit[key] === undefined) return false
          if (meta.complete[key]) return false
          return !!meta.cursor[key]
        },
        loading(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return !!meta.loading[key] && !globalSync.transcript?.available(directory, sessionID, meta.cursor[key])
        },
        async loadMore(sessionID: string, count?: number) {
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const key = keyFor(directory, sessionID)
          const step = count ?? historyMessagePageSize
          if (meta.complete[key]) return
          const before = meta.cursor[key]
          if (!before) return

          await runInflight(inflight, `${key}\n${before}`, () => loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit: step,
            before,
            mode: "prepend",
            local: true,
          }))
        },
      },
      evict(sessionID: string, _directory = directory) {
        const [, setStore] = globalSync.child(_directory)
        seenFor(_directory).delete(sessionID)
        evict(_directory, setStore, [sessionID])
      },
      fetch: async (count = 10) => {
        const captured = version()
        const [store, setStore] = globalSync.child(directory)
        setStore("limit", (x) => x + count)
        await client.session.list().then((x) => {
          if (captured !== version()) return
          const sessions = (x.data ?? [])
            .filter((s) => !!s?.id)
            .sort((a, b) => cmp(a.id, b.id))
            .slice(0, store.limit)
          setStore("session", reconcile(sessions, { key: "id" }))
        })
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        const [, setStore] = globalSync.child(directory)
        await client.session.update({ sessionID, time: { archived: Date.now() } })
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
      },
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }
}
