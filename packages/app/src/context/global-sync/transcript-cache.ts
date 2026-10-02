import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { compareMessages } from "../../utils/message-order"

export const TRANSCRIPT_STORE = "opencode.transcripts.dat"
const MAX_BYTES = 16 * 1024 * 1024
const MAX_SESSIONS = 100
export type TranscriptPage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}
export type TranscriptEntry = TranscriptPage & { directory: string; sessionID: string; updated?: number }
type Entry = TranscriptEntry
export type TranscriptMutation =
  | { type: "write"; entry: Entry; fresh?: string }
  | { type: "remove" | "touch" | "evict"; directory: string; sessionID: string }
  | { type: "clearDirectory"; directory: string }
type Storage = (SyncStorage | AsyncStorage) & {
  transcriptMutate?: (scope: string, owner: string, operations: TranscriptMutation[]) => Promise<void>
  transcriptAcquire?: (
    scope: string,
    owner: string,
    directory: string,
    sessionID: string,
  ) => Promise<{ token: string; revalidate: boolean } | undefined>
}
const owners = new WeakMap<Storage, Map<string, { token: symbol; queue: Promise<void> }>>()
const keyFor = (directory: string, sessionID: string) => JSON.stringify([directory, sessionID])
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const bytes = (value: string) => new TextEncoder().encode(value).length

// Same opaque pagination contract as session.messages; a local boundary remains usable after LRU eviction.
export function transcriptCursor(message: Message) {
  return btoa(JSON.stringify({ id: message.id, time: message.time.created }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

export function createTranscriptCache(storage: Storage | undefined, scope: string | undefined, budget = MAX_BYTES) {
  const entries = new Map<string, Entry>()
  const revisions = new Map<string, number>()
  const metadataRevisions = new Map<string, number>()
  const deleted = new Set<string>()
  const validated = new Set<string>()
  const active = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let disposed = false
  let owner: string | undefined
  let pending: TranscriptMutation[] = []
  const enabled = !!storage && !!scope && (scope === "sidecar.v1" || /^tunnel\.v1\.[a-f0-9]{64}$/.test(scope))
  const scopes = storage
    ? (owners.get(storage) ?? new Map<string, { token: symbol; queue: Promise<void> }>())
    : undefined
  if (storage && scopes) owners.set(storage, scopes)
  const previous = scope ? scopes?.get(scope)?.queue : undefined
  const token = Symbol()
  const ready = enabled
    ? (previous ?? Promise.resolve())
        .then(() => storage!.getItem(scope!))
        .catch(() => null)
        .then((raw) => {
          if (!raw || bytes(raw) > budget + (storage?.transcriptMutate ? 100 : 0)) return
          try {
            const value = JSON.parse(raw)
            if (typeof value.owner === "string") owner = value.owner
            if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_SESSIONS) return
            for (const entry of value.entries) {
              if (!validEntry(entry)) continue
              const key = keyFor(entry.directory, entry.sessionID)
              if (entries.has(key) || revisions.has(key) || revisions.has(entry.directory)) continue
              entries.set(key, entry)
            }
          } catch {
            // A corrupt disposable cache must not prevent opening a session.
          }
        })
    : Promise.resolve()
  if (enabled) scopes!.set(scope!, { token, queue: ready })

  const trim = () => {
    const sizes = [...entries].map(([key, entry]) => ({ key, size: bytes(JSON.stringify(entry)) + 1 }))
    let total = bytes('{"version":1,"entries":[]}') + sizes.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of sizes) {
      if (entries.size <= MAX_SESSIONS && total <= Math.min(budget, MAX_BYTES - 256)) break
      entries.delete(entry.key)
      validated.delete(entry.key)
      const identity = JSON.parse(entry.key) as [string, string]
      enqueue({ type: "evict", directory: identity[0], sessionID: identity[1] })
      total -= entry.size
    }
  }
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!enabled || scopes?.get(scope!)?.token !== token) return queue
    queue = queue
      .then(() => ready)
      .then(() => {
        trim()
        if (storage!.transcriptMutate) {
          const operations = pending.map((operation) =>
            operation.type === "write" ? { ...operation, entry: clone(operation.entry) } : operation,
          )
          pending = []
          if (!owner || !operations.length) return
          return (async () => {
            for (const [index, operation] of operations.entries()) {
              try {
                await storage!.transcriptMutate!(scope!, owner!, [operation])
              } catch (error) {
                pending.unshift(...operations.slice(index))
                changed()
                throw error
              }
            }
          })()
        }
        return storage!.setItem(scope!, JSON.stringify({ version: 1, entries: [...entries.values()] }))
      })
      .then(() => undefined)
      .catch(() => undefined)
    scopes!.set(scope!, { token, queue })
    return queue
  }
  const changed = () => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, 500)
  }
  const enqueue = (operation: TranscriptMutation, mergedFrom?: Entry) => {
    if (!storage?.transcriptMutate) return
    const entry = operation.type === "write" ? operation.entry : operation
    if (operation.type === "clearDirectory") {
      pending = pending.filter(
        (item) => (item.type === "write" ? item.entry.directory : item.directory) !== entry.directory,
      )
    } else {
      // Streaming deltas must not accumulate full copies of the same transcript.
      const key = keyFor(entry.directory, "sessionID" in entry ? entry.sessionID : "")
      const previous = pending.findLastIndex(
        (item) =>
          item.type !== "clearDirectory" &&
          keyFor(
            item.type === "write" ? item.entry.directory : item.directory,
            item.type === "write" ? item.entry.sessionID : item.sessionID,
          ) === key,
      )
      if (previous >= 0 && operation.type === "touch" && pending[previous].type !== "touch") {
        pending.push(...pending.splice(previous, 1))
        return
      }
      if (previous >= 0) {
        const previousOperation = pending[previous]
        if (
          operation.type === "write" &&
          previousOperation.type === "write" &&
          (operation.entry === previousOperation.entry || mergedFrom === previousOperation.entry)
        )
          operation.fresh ??= previousOperation.fresh
        pending.splice(previous, 1)
      }
    }
    pending.push(operation)
  }
  const touch = (key: string, entry: Entry) => {
    entries.delete(key)
    entries.set(key, entry)
  }
  const revision = (directory: string, sessionID: string) =>
    (revisions.get(keyFor(directory, sessionID)) ?? 0) + (revisions.get(directory) ?? 0)
  const bump = (key: string) => revisions.set(key, (revisions.get(key) ?? 0) + 1)

  return {
    ready,
    enabled,
    revision,
    activate: (directory: string, sessionID: string) => {
      active.add(keyFor(directory, sessionID))
    },
    deactivate: (directory: string, sessionID: string) => {
      active.delete(keyFor(directory, sessionID))
    },
    async beginFetch(directory: string, sessionID: string) {
      await ready
      if (!storage?.transcriptAcquire || !owner || !scope) return
      await flush()
      const grant = await storage.transcriptAcquire(scope, owner, directory, sessionID).catch(() => undefined)
      if (grant?.revalidate) validated.delete(keyFor(directory, sessionID))
      return grant?.token
    },
    sessionRevision: (directory: string, sessionID: string) =>
      (metadataRevisions.get(keyFor(directory, sessionID)) ?? 0) + (revisions.get(directory) ?? 0),
    deleted: (directory: string, sessionID: string) => deleted.has(keyFor(directory, sessionID)),
    validationBoundary(directory: string, sessionID: string, updated?: number) {
      const key = keyFor(directory, sessionID)
      const entry = entries.get(key)
      return validated.has(key) && (updated === undefined || entry?.updated === undefined || entry.updated === updated)
        ? undefined
        : entry?.session[0]
    },
    invalidate(directory?: string) {
      const directories = directory ? [directory] : this.directories()
      for (const directory of directories) bump(directory)
      for (const [key, entry] of entries) if (!directory || entry.directory === directory) validated.delete(key)
    },
    flush,
    dispose() {
      disposed = true
      void flush()
    },
    directories: () => [...new Set([...entries.values()].map((entry) => entry.directory))],
    available(directory: string, sessionID: string, before?: string) {
      const entry = entries.get(keyFor(directory, sessionID))
      if (!entry || !before) return false
      const end = entry.session.findIndex((message) => transcriptCursor(message) === before)
      return end > 0 || (end === 0 && entry.complete)
    },
    read(directory: string, sessionID: string, limit = 20, before?: string): TranscriptPage | undefined {
      const key = keyFor(directory, sessionID)
      const entry = entries.get(key)
      if (!entry) return
      const end = before
        ? entry.session.findIndex((message) => transcriptCursor(message) === before)
        : entry.session.length
      if (end < 0 || (end === 0 && !entry.complete)) return
      touch(key, entry)
      enqueue({ type: "touch", directory, sessionID })
      changed()
      const start = Math.max(0, end - limit)
      const session = entry.session.slice(start, end)
      const ids = new Set(session.map((message) => message.id))
      return clone({
        session,
        part: entry.part.filter((part) => ids.has(part.id)),
        cursor: start > 0 ? transcriptCursor(session[0]) : entry.cursor,
        complete: start === 0 && entry.complete,
      })
    },
    write(
      directory: string,
      sessionID: string,
      page: TranscriptPage,
      options: { before?: string; updated?: number; reset?: boolean; validated?: boolean; fresh?: string } = {},
    ) {
      if (!enabled) return
      const key = keyFor(directory, sessionID)
      const previous = entries.get(key)
      const keep =
        previous && !options.reset
          ? previous.session.filter((message) => {
              if (page.complete && !options.before) return false
              return options.before || (page.session[0] && compareMessages(message, page.session[0]) < 0)
            })
          : []
      const messages = new Map(keep.map((message) => [message.id, message]))
      for (const message of page.session) messages.set(message.id, message)
      const parts = new Map(
        (previous?.part ?? []).filter((part) => messages.has(part.id)).map((part) => [part.id, part.part]),
      )
      for (const part of page.part) parts.set(part.id, part.part)
      const older = !!previous && !options.reset && !options.before && keep.length > 0
      const entry = clone({
        directory,
        sessionID,
        session: [...messages.values()].sort(compareMessages),
        part: [...parts].map(([id, part]) => ({ id, part })),
        cursor: older ? previous.cursor : page.cursor,
        complete: older ? previous.complete : page.complete,
        updated: options.before ? previous?.updated : (options.updated ?? previous?.updated),
      })
      if (!validEntry(entry)) return
      touch(key, entry)
      if (options.validated) {
        validated.add(key)
        deleted.delete(key)
      }
      // A prepend retains the authorized base; replacements and resets must acquire their own grant.
      enqueue(
        { type: "write", entry, ...(options.fresh ? { fresh: options.fresh } : {}) },
        options.before && !options.reset ? previous : undefined,
      )
      trim()
      changed()
    },
    remove(directory: string, sessionID: string) {
      const key = keyFor(directory, sessionID)
      bump(key)
      metadataRevisions.set(key, (metadataRevisions.get(key) ?? 0) + 1)
      deleted.add(key)
      validated.delete(key)
      active.delete(key)
      entries.delete(key)
      enqueue({ type: "remove", directory, sessionID })
      changed()
    },
    clearDirectory(directory: string) {
      bump(directory)
      enqueue({ type: "clearDirectory", directory })
      for (const [key, entry] of entries)
        if (entry.directory === directory) {
          bump(key)
          validated.delete(key)
          active.delete(key)
          entries.delete(key)
        }
      changed()
    },
    event(directory: string, event: { type: string; properties?: unknown }) {
      const props = event.properties as {
        info?: Message & { time: { updated?: number } }
        part?: Part
        sessionID?: string
        messageID?: string
        partID?: string
        field?: string
        delta?: string
      }
      if (event.type === "session.deleted") {
        this.remove(directory, props.info!.id)
        return
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const key = keyFor(directory, props.info!.id)
        metadataRevisions.set(key, (metadataRevisions.get(key) ?? 0) + 1)
        if (event.type === "session.created") deleted.delete(key)
        if (event.type === "session.updated" && entries.get(key)?.updated !== props.info?.time.updated) {
          if (!active.has(key)) validated.delete(key)
          bump(key)
        }
        return
      }
      if (!event.type.startsWith("message.")) return
      const sessionID =
        props.sessionID ??
        props.info?.sessionID ??
        props.part?.sessionID ??
        [...entries.values()].find(
          (entry) => entry.directory === directory && entry.session.some((message) => message.id === props.messageID),
        )?.sessionID
      if (!sessionID) {
        bump(directory)
        return
      }
      const key = keyFor(directory, sessionID)
      bump(key)
      const entry = entries.get(key)
      if (!entry) return // Never mirror sessions which have not been fetched.
      if (event.type === "message.updated" && props.info) {
        if (!entry.session.some((message) => message.id === props.info!.id)) {
          const tail = entry.session.at(-1)
          if (
            !active.has(key) ||
            !validated.has(key) ||
            (tail && compareMessages(props.info, tail) <= 0) ||
            (props.info.role === "assistant" &&
              !entry.session.some(
                (message) => message.id === (props.info as Extract<Message, { role: "assistant" }>).parentID,
              ))
          ) {
            // Only an opened, validated connection can extend its live message sequence.
            validated.delete(key)
            return
          }
        }
        entry.session = [...entry.session.filter((message) => message.id !== props.info!.id), clone(props.info)].sort(
          compareMessages,
        )
        if (!entry.part.some((part) => part.id === props.info!.id)) entry.part.push({ id: props.info.id, part: [] })
      }
      if (event.type === "message.removed") {
        entry.session = entry.session.filter((message) => message.id !== props.messageID)
        entry.part = entry.part.filter((part) => part.id !== props.messageID)
      }
      const item = entry.part.find((part) => part.id === (props.part?.messageID ?? props.messageID))
      if (item && event.type === "message.part.updated" && props.part)
        item.part = [...item.part.filter((part) => part.id !== props.part!.id), clone(props.part)].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        )
      if (item && event.type === "message.part.removed")
        item.part = item.part.filter((part) => part.id !== props.partID)
      if (item && event.type === "message.part.delta" && props.field && typeof props.delta === "string") {
        const part = item.part.find((part) => part.id === props.partID)
        if (part && (part.type === "text" || part.type === "reasoning") && props.field === "text")
          part.text += props.delta
      }
      touch(key, entry)
      enqueue({ type: "write", entry })
      changed()
    },
  }
}
export type TranscriptCache = ReturnType<typeof createTranscriptCache>

export function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false
  const entry = value as Entry
  if (
    typeof entry.directory !== "string" ||
    typeof entry.sessionID !== "string" ||
    !entry.sessionID ||
    typeof entry.complete !== "boolean" ||
    (entry.complete ? entry.cursor !== undefined : typeof entry.cursor !== "string" || !entry.cursor) ||
    (entry.updated !== undefined && !Number.isFinite(entry.updated)) ||
    !Array.isArray(entry.session) ||
    !Array.isArray(entry.part)
  )
    return false
  const ids = new Set<string>()
  for (const message of entry.session) {
    if (
      !message?.id ||
      typeof message.id !== "string" ||
      !/^[\w-]+$/.test(message.id) ||
      ids.has(message.id) ||
      message.sessionID !== entry.sessionID ||
      !["user", "assistant"].includes(message.role) ||
      !Number.isFinite(message.time?.created) ||
      message.time.created < 0 ||
      typeof message.agent !== "string" ||
      (message.role === "user" &&
        (typeof message.model?.providerID !== "string" || typeof message.model?.modelID !== "string"))
    )
      return false
    ids.add(message.id)
  }
  const parts = new Set<string>()
  for (const item of entry.part) {
    if (!ids.has(item?.id) || parts.has(item.id) || !Array.isArray(item.part)) return false
    parts.add(item.id)
    const seen = new Set<string>()
    for (const part of item.part) {
      if (
        !part?.id ||
        typeof part.id !== "string" ||
        seen.has(part.id) ||
        part.messageID !== item.id ||
        part.sessionID !== entry.sessionID ||
        ![
          "text",
          "reasoning",
          "file",
          "tool",
          "agent",
          "subtask",
          "retry",
          "compaction",
          "snapshot",
          "patch",
          "step-start",
          "step-finish",
        ].includes(part.type) ||
        ((part.type === "text" || part.type === "reasoning") && typeof part.text !== "string")
      )
        return false
      if (part.type === "file" && (typeof part.mime !== "string" || typeof part.url !== "string")) return false
      if (
        part.type === "tool" &&
        (typeof part.tool !== "string" ||
          typeof part.callID !== "string" ||
          !part.state ||
          !["pending", "running", "completed", "error"].includes(part.state.status))
      )
        return false
      seen.add(part.id)
    }
  }
  return parts.size === ids.size
}
