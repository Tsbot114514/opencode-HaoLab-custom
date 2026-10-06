import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { compareMessages } from "../../utils/message-order"
import { transcriptRecord, validTranscriptMessage, validTranscriptPart } from "../../utils/transcript-entities"

export const TRANSCRIPT_STORE = "opencode.transcripts.dat"
const MAX_BYTES = 16 * 1024 * 1024
const MAX_SESSIONS = 100
export type TranscriptPage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}
export type TranscriptVersion = { messageID: string; partID?: string; seq: number; full?: number; removed?: boolean }
export type TranscriptFeed = {
  version: number
  after?: { id: string; created: number }
  versions: TranscriptVersion[]
  session: Session
  snapshot: string[]
}
export type TranscriptEntry = TranscriptPage & {
  directory: string; sessionID: string; updated?: number; gaps?: string[]
  syncCursor?: string; syncGeneration?: string; feed?: TranscriptFeed
}
export type TranscriptChange =
  | { seq: number; type: "message.upsert"; info: Message }
  | { seq: number; type: "part.upsert"; info: Message; part: Part }
  | { seq: number; type: "message.remove"; sessionID: string; messageID: string }
  | { seq: number; type: "part.remove"; sessionID: string; messageID: string; partID: string }
const entityKey = (messageID: string, partID?: string) => JSON.stringify([messageID, partID ?? null])
const MAX_VERSIONS = 100_000
const coverage = (version: { seq: number; full?: number } | undefined, baseline = -1) => version?.full ?? version?.seq ?? baseline
type Entry = TranscriptEntry
export type TranscriptEvent =
  | { type: "message.updated"; info: Message }
  | { type: "message.part.updated"; part: Part }
  | { type: "message.part.removed"; messageID: string; partID: string }
  | { type: "message.part.delta"; messageID: string; partID: string; delta: string }
export type TranscriptMutation =
  | { type: "write"; entry: Entry; fresh?: string; range?: { before?: Message }; page?: TranscriptPage; reset?: boolean }
  | { type: "remove" | "touch" | "evict"; directory: string; sessionID: string }
  | { type: "clearDirectory"; directory: string }
  | { type: "event"; directory: string; sessionID: string; event: TranscriptEvent }
  | { type: "removeMessage"; directory: string; sessionID: string; messageID: string }
type Storage = (SyncStorage | AsyncStorage) & {
  transcriptOpen?: (scope: string) => Promise<{ owner: string } | undefined>
  transcriptReadPage?: (scope: string, owner: string, directory: string, sessionID: string, before?: string) => Promise<TranscriptEntry | undefined>
  transcriptMutate?: (scope: string, owner: string, operations: TranscriptMutation[]) => Promise<void>
  transcriptAcquire?: (
    scope: string,
    owner: string,
    directory: string,
    sessionID: string,
  ) => Promise<{ token: string; revalidate: boolean; epoch?: number } | undefined>
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

export function createTranscriptCache(
  storage: Storage | undefined,
  scope: string | undefined,
  budget = MAX_BYTES,
  onPersistenceFailure?: (entries: readonly TranscriptEntry[]) => void,
) {
  const entries = new Map<string, Entry>()
  const revisions = new Map<string, number>()
  const metadataRevisions = new Map<string, number>()
  const deleted = new Set<string>()
  const validated = new Set<string>()
  const ranges = new Map<string, { start?: Message; end?: Message }[]>()
  const commits = new Map<string, { start?: Message; end?: Message; revision: number }[]>()
  const rangeRevisions = new Map<string, number>()
  const tailRevisions = new Map<string, number>()
  const active = new Set<string>()
  const writes = new Map<string, Promise<void>>()
  // Only mobile feed readers initialize these maps; Desktop retains its existing authority.
  const live = new Map<string, Map<string, number>>()
  const generations = new Map<string, number>()
  const feedGenerations = new Map<string, string>()
  const retired = new Map<string, Set<string>>()
  const foreign = new Map<string, Set<string>>()
  const stamped = new Map<string, Map<string, { generation: string; seq: number; full?: number }>>()
  const invalidated = new Set<string>()
  let feedCapability: boolean | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let disposed = false
  let owner: string | undefined
  let pending: TranscriptMutation[] = []
  let hydrated = false
  let persistenceError: { operation: "read" | "write"; error: Error } | undefined
  const enabled = !!storage && !!scope && (scope === "sidecar.v1" || /^tunnel\.v1\.[a-f0-9]{64}$/.test(scope))
  const scopes = storage
    ? (owners.get(storage) ?? new Map<string, { token: symbol; queue: Promise<void> }>())
    : undefined
  if (storage && scopes) owners.set(storage, scopes)
  const previous = scope ? scopes?.get(scope)?.queue : undefined
  const token = Symbol()
  const notifyPersistenceFailure = () => {
    try {
      onPersistenceFailure?.([...entries.values()])
    } catch {
      // An unavailable fallback bridge must not turn a storage error into a render error.
    }
  }
  const hydrate = async () => {
    if (storage!.transcriptOpen) {
      owner = (await storage!.transcriptOpen(scope!))?.owner
      hydrated = true
      return
    }
    const raw = await storage!.getItem(scope!)
    hydrated = true
    if (persistenceError?.operation === "read") persistenceError = undefined
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
        if (entry.feed && !entry.syncCursor) invalidated.add(key)
      }
    } catch {
      // A corrupt disposable cache must not prevent opening a session.
    }
  }
  const readFailed = (error: unknown) => {
    persistenceError = {
      operation: "read",
      error: error instanceof Error ? error : new Error("Transcript storage read failed"),
    }
    notifyPersistenceFailure()
  }
  const ready = enabled ? (storage?.transcriptOpen ? Promise.resolve() : previous ?? Promise.resolve()).then(hydrate).catch(readFailed) : Promise.resolve()
  if (enabled) scopes!.set(scope!, { token, queue: ready })

  const trim = () => {
    const sizes = [...entries].map(([key, entry]) => ({ key, size: bytes(JSON.stringify(entry)) + 1 }))
    let total = bytes('{"version":1,"entries":[]}') + sizes.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of sizes) {
      if (entries.size <= MAX_SESSIONS && total <= Math.min(budget, MAX_BYTES - 256)) break
      entries.delete(entry.key)
      live.delete(entry.key)
      stamped.delete(entry.key)
      invalidated.delete(entry.key)
      generations.set(entry.key, (generations.get(entry.key) ?? 0) + 1)
      validated.delete(entry.key)
      ranges.delete(entry.key)
      if (commits.has(entry.key)) bump(entry.key)
      commits.delete(entry.key)
      rangeRevisions.delete(entry.key)
      tailRevisions.delete(entry.key)
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
      .then(async () => {
        // A rejected read is not an empty store: recover hydration before replacing disk contents.
        if (!hydrated) {
          await hydrate().catch(readFailed)
          if (!hydrated) return
        }
        trim()
        if (storage!.transcriptMutate) {
          const operations = [...pending]
          if (!owner || !operations.length) return
          return (async () => {
            for (const operation of operations) {
              if (!pending.includes(operation)) continue
              pending = pending.filter((item) => item !== operation)
              try {
                const entry = operation.type === "write" ? operation.entry : operation
                const key = operation.type === "clearDirectory" ? operation.directory : keyFor(entry.directory, "sessionID" in entry ? entry.sessionID : "")
                const writing = storage!.transcriptMutate!(scope!, owner!, [clone(operation)])
                writes.set(key, writing)
                await writing.finally(() => { if (writes.get(key) === writing) writes.delete(key) })
                persistenceError = undefined
              } catch (error) {
                pending.unshift(operation)
                changed()
                throw error
              }
            }
          })()
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await storage!.setItem(scope!, JSON.stringify({ version: 1, entries: [...entries.values()] }))
            persistenceError = undefined
            return
          } catch (error) {
            persistenceError = {
              operation: "write",
              error: error instanceof Error ? error : new Error("Transcript storage write failed"),
            }
            if (attempt === 1) {
              notifyPersistenceFailure()
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        persistenceError = {
          operation: "write",
          error: error instanceof Error ? error : new Error("Transcript storage write failed"),
        }
        notifyPersistenceFailure()
      })
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
    if (operation.type === "event" || operation.type === "removeMessage") {
      pending.push(clone(operation))
      return
    }
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
      if (previous >= 0 && pending[previous].type !== "event" && pending[previous].type !== "removeMessage" && !(storage.transcriptReadPage && operation.type === "write" && pending[previous].type === "write" &&
        operation.range?.before?.id !== (pending[previous] as Extract<TranscriptMutation, { type: "write" }>).range?.before?.id)) {
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
    feedCapability: () => feedCapability,
    setFeedCapability: (supported: boolean) => { feedCapability = supported },
    feedEntry(directory: string, sessionID: string) {
      const entry = entries.get(keyFor(directory, sessionID))
      return entry ? clone(entry) : undefined
    },
    beginFeed(directory: string, sessionID: string) {
      const key = keyFor(directory, sessionID)
      if (!live.has(key)) live.set(key, new Map())
      if (entries.get(key)?.syncGeneration) feedGenerations.set(key, entries.get(key)!.syncGeneration!)
      return { cursor: entries.get(key)?.syncCursor, generation: (generations.get(key) ?? 0) + (generations.get(directory) ?? 0), live: new Map(live.get(key)) }
    },
    resetFeed(directory: string, sessionID: string) {
      const key = keyFor(directory, sessionID)
      live.delete(key)
      stamped.delete(key)
      invalidated.delete(key)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      const entry = entries.get(key)
      if (!entry) return
      delete entry.syncCursor
      delete entry.syncGeneration
      delete entry.feed
      ranges.delete(key)
      validated.delete(key)
      enqueue({ type: "write", entry })
      changed()
    },
    applyFeed(
      directory: string,
      sessionID: string,
      token: { cursor?: string; generation: number; live: Map<string, number> },
      response: { cursor: string; generation: string; session?: Session; changes: TranscriptChange[] } |
        { cursor: string; generation: string; session: Session; page: TranscriptPage; version: number },
      overlay?: TranscriptPage,
    ) {
      const key = keyFor(directory, sessionID)
      const previous = entries.get(key)
      if (!enabled || token.generation !== (generations.get(key) ?? 0) + (generations.get(directory) ?? 0) ||
        token.cursor !== previous?.syncCursor && !(invalidated.has(key) && !previous?.syncCursor && previous?.syncGeneration === response.generation) || deleted.has(key)) return
      const dirty = (id: string, partID?: string) =>
        (live.get(key)?.get(entityKey(id, partID)) ?? 0) !== (token.live.get(entityKey(id, partID)) ?? 0)
      const conflicted = new Set<string>()
      const snapshot = "page" in response
      if (!feedGeneration(response.generation)) throw new Error("Invalid transcript generation")
      if (retired.get(key)?.has(response.generation)) return
      if (!snapshot && previous?.syncGeneration !== response.generation) {
        this.resetFeed(directory, sessionID)
        throw new Error("Transcript generation changed; a new snapshot is required")
      }
      const sameGeneration = (previous?.syncGeneration ?? feedGenerations.get(key)) === response.generation
      if (snapshot) {
        const history = retired.get(key) ?? new Set<string>()
        for (const candidate of foreign.get(key) ?? []) if (candidate !== response.generation) history.add(candidate)
        if (!sameGeneration && feedGenerations.has(key)) history.add(feedGenerations.get(key)!)
        while (history.size > 16) history.delete(history.values().next().value!)
        retired.set(key, history)
        foreign.delete(key)
      }
      if (snapshot && !sameGeneration && feedGenerations.has(key)) {
        live.delete(key)
        stamped.delete(key)
      }
      const entry: Entry = snapshot ? {
        directory, sessionID, ...clone(response.page), updated: response.session.time.updated,
        syncGeneration: response.generation,
        feed: { version: response.version, session: clone(response.session), versions: [], snapshot: response.page.session.map((message) => message.id),
          ...(response.page.session.at(-1) ? { after: { id: response.page.session.at(-1)!.id, created: response.page.session.at(-1)!.time.created } } : {}) },
      } : clone(previous!)
      if (!entry?.feed) return
      const versions = new Map(entry.feed.versions.map((item) => [entityKey(item.messageID, item.partID), item]))
      if (snapshot) {
        // Retained history is display data, not newly validated snapshot coverage.
        const first = entry.session[0]
        const older = first && !invalidated.has(key) && (!feedGenerations.has(key) || sameGeneration) ? previous?.session.filter((message) => compareMessages(message, first) < 0) ?? [] : []
        if (older.length) {
          const ids = new Set(older.map((message) => message.id))
          entry.session = [...clone(older), ...entry.session]
          entry.part = [...clone(previous!.part.filter((item) => ids.has(item.id))), ...entry.part]
          entry.cursor = previous!.cursor
          entry.complete = previous!.complete
          entry.gaps = [...(previous!.gaps ?? []).filter((id) => ids.has(id)),
            ...(!previous!.session.some((message) => message.id === first.id) || previous!.gaps?.includes(first.id) ? [first.id] : [])]
        }
        for (const message of response.page.session) {
          versions.set(entityKey(message.id), { messageID: message.id, seq: response.version })
        }
        // A snapshot racing unsequenced SSE must preserve the newer rendered entity, without checkpointing it.
        for (const [identity, revision] of live.get(key) ?? []) {
          if (revision === (token.live.get(identity) ?? 0)) continue
          const [id, partID] = JSON.parse(identity) as [string, string | null]
          const stamp = stamped.get(key)?.get(identity)
          if (stamp?.generation === response.generation && stamp.seq <= response.version) continue
          const matching = stamp?.generation === response.generation
          const covered = matching && coverage(stamp) === stamp.seq
          if (!covered) conflicted.add(identity)
          if (matching) versions.set(identity, { messageID: id, ...(partID ? { partID } : {}), seq: stamp.seq,
            ...(stamp.full !== undefined ? { full: stamp.full } : {}),
            ...(!(overlay ?? previous)?.session.some((message) => message.id === id) || partID &&
              !(overlay ?? previous)?.part.find((item) => item.id === id)?.part.some((part) => part.id === partID) ? { removed: true } : {}) })
          if (id === "session") continue
          const source = overlay ?? previous
          if (!partID) {
            entry.session = entry.session.filter((message) => message.id !== id)
            const info = source?.session.find((message) => message.id === id)
            if (info) entry.session.push(clone(info))
            if (!covered || !info) entry.part = entry.part.filter((item) => item.id !== id)
            if (info && !entry.part.some((item) => item.id === id)) entry.part.push(clone(covered ? { id, part: [] } : source?.part.find((item) => item.id === id) ?? { id, part: [] }))
            continue
          }
          const group = entry.part.find((item) => item.id === id)
          if (!group) continue
          group.part = group.part.filter((part) => part.id !== partID)
          const part = source?.part.find((item) => item.id === id)?.part.find((part) => part.id === partID)
          if (part) group.part.push(clone(part))
        }
        // Retain newer live state; additive watermarks remain provisional until a full replacement covers them.
        for (const version of sameGeneration ? previous?.feed?.versions ?? [] : []) {
          if (version.seq <= response.version) continue
          const id = version.messageID
          const identity = entityKey(id, version.partID)
          if (!version.partID) {
            const info = previous?.session.find((message) => message.id === id)
            entry.session = entry.session.filter((message) => message.id !== id)
            if (info) entry.session.push(clone(info))
            if (!info) entry.part = entry.part.filter((item) => item.id !== id)
            if (info && !entry.part.some((item) => item.id === id)) entry.part.push({ id, part: [] })
          }
          const group = entry.part.find((item) => item.id === id)
          if (version.partID && group) {
            group.part = group.part.filter((part) => part.id !== version.partID)
            const part = previous?.part.find((item) => item.id === id)?.part.find((part) => part.id === version.partID)
            if (part) group.part.push(clone(part))
          }
          versions.set(identity, clone(version))
        }
      }
      if (!snapshot) for (const change of response.changes) {
        const id = "info" in change ? change.info.id : change.messageID
        const partID = change.type === "part.upsert" ? change.part.id : change.type === "part.remove" ? change.partID : undefined
        const identity = entityKey(id, partID)
        const removed = versions.get(entityKey(id))
        // Snapshot parts share the snapshot watermark; only subsequent replacements need individual stamps.
        if (removed?.removed && removed.seq >= change.seq) continue
        const current = versions.get(identity)
        const full = coverage(current, entry.feed.snapshot.includes(id) ? entry.feed.version : -1)
        if (full >= change.seq || (current?.seq ?? -1) > change.seq) {
          // A live part can cover this replacement without covering the separately hydrated owner info.
          if (change.type === "part.upsert" && entry.session.some((message) => message.id === id) &&
            (versions.get(entityKey(id))?.seq ?? -1) < change.seq) {
            if (dirty(id)) conflicted.add(entityKey(id))
            if (!dirty(id)) {
              entry.session = [...entry.session.filter((message) => message.id !== id), clone(change.info)]
              versions.set(entityKey(id), { messageID: id, seq: change.seq })
            }
          }
          if (full < change.seq) conflicted.add(identity)
          continue
        }
        const known = entry.session.some((message) => message.id === id)
        const after = entry.feed.after
        const admit = "info" in change && (!after || change.info.time.created > after.created ||
          change.info.time.created === after.created && change.info.id > after.id)
        if (!known && !admit && !removed?.removed) {
          if (change.type.endsWith("remove")) versions.set(identity, { messageID: id, ...(partID ? { partID } : {}), seq: change.seq, removed: true })
          continue // Older unloaded changes must not fabricate ghost messages/parts.
        }
        const groupDirty = change.type === "message.remove" && [...(live.get(key)?.keys() ?? [])].some((identity) => {
          const [messageID, partID] = JSON.parse(identity) as [string, string | null]
          return messageID === id && dirty(id, partID ?? undefined)
        })
        if (dirty(id, partID) || groupDirty || !known && dirty(id)) { conflicted.add(identity); continue }
        if ("info" in change) {
          if (dirty(id)) conflicted.add(entityKey(id))
          else if ((versions.get(entityKey(id))?.seq ?? -1) <= change.seq) {
            entry.session = [...entry.session.filter((message) => message.id !== id), clone(change.info)]
            versions.set(entityKey(id), { messageID: id, seq: change.seq })
          }
          if (!entry.part.some((item) => item.id === id)) entry.part.push({ id, part: [] })
        }
        if (change.type === "message.remove") {
          const next = entry.session[entry.session.findIndex((message) => message.id === id) + 1]
          if (entry.gaps?.includes(id)) entry.gaps = entry.gaps.flatMap((gap) => gap !== id ? [gap] : next ? [next.id] : [])
          entry.session = entry.session.filter((message) => message.id !== id)
          entry.part = entry.part.filter((item) => item.id !== id)
          for (const [identity, version] of versions) if (version.messageID === id && version.partID) versions.delete(identity)
        }
        const group = entry.part.find((item) => item.id === id)
        if (partID && group) {
          group.part = group.part.filter((part) => part.id !== partID)
          if (change.type === "part.upsert") group.part.push(clone(change.part))
        }
        versions.set(identity, { messageID: id, ...(partID ? { partID } : {}), seq: change.seq,
          ...(change.type.endsWith("remove") ? { removed: true } : {}) })
      }
      if (response.session && !dirty("session")) {
        entry.feed.session = clone(response.session)
        entry.updated = response.session.time.updated
      }
      if (response.session && dirty("session")) {
        conflicted.add(entityKey("session"))
        if (previous?.feed) entry.feed.session = clone(previous.feed.session)
      }
      entry.session.sort(compareMessages)
      for (const group of entry.part) group.part.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      entry.gaps = entry.session.flatMap((message, index) => index > 0 && entry.gaps?.includes(message.id) ? [message.id] : [])
      entry.feed.versions = [...versions.values()]
      // Seeing an append does not prove its base. Even an empty page cannot certify a provisional body.
      for (const version of entry.feed.versions) if (coverage(version) < version.seq && entry.session.some((message) => message.id === version.messageID))
        conflicted.add(entityKey(version.messageID, version.partID))
      entry.syncCursor = conflicted.size || invalidated.has(key) && !snapshot ? previous?.syncCursor : response.cursor
      // A bounded version table cannot silently lose tombstones while retaining feed authority.
      if (entry.feed.versions.length > MAX_VERSIONS) { delete entry.feed; delete entry.syncCursor; delete entry.syncGeneration }
      if (!validEntry(entry)) throw new Error("Invalid transcript feed entry")
      if (bytes(JSON.stringify(entry)) > Math.min(budget, MAX_BYTES - 256)) throw new Error("Transcript exceeds the persistent cache byte limit")
      touch(key, entry)
      feedGenerations.set(key, response.generation)
      if (entry.syncCursor && snapshot && !conflicted.size) invalidated.delete(key)
      if (!conflicted.size) ranges.set(key, [{ start: snapshot ? response.page.session[0] : previous?.session.at(-1) }])
      tailRevisions.set(key, (tailRevisions.get(key) ?? 0) + 1)
      bump(key)
      enqueue({ type: "write", entry })
      trim()
      changed()
      return { entry: clone(entry), checkpointed: !conflicted.size && !!entry.syncCursor,
        metadataSafe: !dirty("session"), statusSafe: !dirty("status") }
    },
    enabled,
    async ensureSelected(directory: string, sessionID: string, before?: string) {
      await ready
      if (!storage?.transcriptReadPage || !owner || !scope) return
      if (this.read(directory, sessionID, 20, before, true)) return
      const captured = revision(directory, sessionID)
      const page = await storage.transcriptReadPage(scope, owner, directory, sessionID, before)
      if (!page || captured !== revision(directory, sessionID) || deleted.has(keyFor(directory, sessionID))) return
      const key = keyFor(directory, sessionID)
      const previous = entries.get(key)
      if (!previous) {
        entries.set(key, page)
        return
      }
      const messages = new Map([...page.session, ...previous.session].map((message) => [message.id, message]))
      const parts = new Map([...page.part, ...previous.part].map((part) => [part.id, part]))
      const session = [...messages.values()].sort(compareMessages)
      const gaps = new Set(previous.gaps)
      for (const message of page.session) gaps.delete(message.id)
      const boundary = previous.session.find((message) => transcriptCursor(message) === before)
      if (boundary && page.session.length) gaps.delete(boundary.id)
      // Reading a separate canonical window does not prove the interval between windows.
      if (page.session[0] && previous.session.some((message) => compareMessages(message, page.session[0]) < 0) &&
        !previous.session.some((message) => message.id === page.session[0].id)) gaps.add(page.session[0].id)
      if (previous.session[0] && page.session.some((message) => compareMessages(message, previous.session[0]) < 0) &&
        !page.session.some((message) => message.id === previous.session[0].id) &&
        before !== transcriptCursor(previous.session[0])) gaps.add(previous.session[0].id)
      const older = !previous.session[0] || !!page.session[0] && compareMessages(page.session[0], previous.session[0]) < 0
      entries.set(key, { ...previous, session, part: [...parts.values()],
        cursor: older ? page.cursor : previous.cursor, complete: older ? page.complete : previous.complete,
        gaps: session.flatMap((message, index) => index > 0 && gaps.has(message.id) ? [message.id] : []) })
    },
    persistenceError: () => persistenceError,
    revision,
    tailRevision: (directory: string, sessionID: string) => tailRevisions.get(keyFor(directory, sessionID)) ?? 0,
    rangeRevision: (directory: string, sessionID: string) => rangeRevisions.get(keyFor(directory, sessionID)) ?? 0,
    changedPage(directory: string, sessionID: string, revision: number, page: TranscriptPage, before: Message) {
      const start = page.complete ? undefined : page.session[0]
      return (commits.get(keyFor(directory, sessionID)) ?? []).some((range) =>
        range.revision > revision &&
        (!range.end || !start || compareMessages(start, range.end) < 0) &&
        (!range.start || compareMessages(range.start, before) < 0),
      )
    },
    activate: (directory: string, sessionID: string) => {
      active.add(keyFor(directory, sessionID))
    },
    deactivate: (directory: string, sessionID: string) => {
      active.delete(keyFor(directory, sessionID))
    },
    async beginFetch(directory: string, sessionID: string, onRevalidate?: () => void) {
      await ready
      if (!storage?.transcriptAcquire || !owner || !scope) return
      const key = keyFor(directory, sessionID)
      // Capture canonical ownership before a same-session write can rebase the owner.
      const initial = onRevalidate && (writes.has(key) || writes.has(directory) || pending.some((operation) =>
        operation.type === "clearDirectory" ? operation.directory === directory :
          keyFor(operation.type === "write" ? operation.entry.directory : operation.directory,
            operation.type === "write" ? operation.entry.sessionID : operation.sessionID) === key))
        ? await storage.transcriptAcquire(scope, owner, directory, sessionID).catch(() => undefined)
        : undefined
      await writes.get(key)
      await writes.get(directory)
      // Only the fetched session's queued base must precede its revision grant.
      const operations = pending.filter((operation) => operation.type === "clearDirectory" ? operation.directory === directory :
        keyFor(operation.type === "write" ? operation.entry.directory : operation.directory,
          operation.type === "write" ? operation.entry.sessionID : operation.sessionID) === key)
      if (operations.length && storage.transcriptMutate) {
        pending = pending.filter((operation) => !operations.includes(operation))
        for (const operation of operations) await storage.transcriptMutate(scope, owner, [clone(operation)]).catch(() => {
          pending.push(operation)
          changed()
        })
      }
      const grant = await storage.transcriptAcquire(scope, owner, directory, sessionID).catch(() => undefined)
      if (grant?.revalidate || initial?.revalidate || initial?.epoch !== undefined && initial.epoch !== grant?.epoch) {
        onRevalidate?.()
        validated.delete(keyFor(directory, sessionID))
        ranges.delete(keyFor(directory, sessionID))
      }
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
    validatedPage(directory: string, sessionID: string, page: TranscriptPage, before?: Message) {
      const key = keyFor(directory, sessionID)
      if (validated.has(key)) return true
      return (ranges.get(key) ?? []).some((range) =>
        (!range.start || (!page.complete && page.session[0] && compareMessages(page.session[0], range.start) >= 0)) &&
        (!range.end || (before && compareMessages(before, range.end) <= 0)),
      )
    },
    invalidate(directory?: string) {
      const directories = directory ? [directory] : this.directories()
      for (const directory of directories) {
        bump(directory)
        generations.set(directory, (generations.get(directory) ?? 0) + 1)
      }
      for (const [key, entry] of entries) if (!directory || entry.directory === directory) {
        stamped.delete(key)
        validated.delete(key)
        ranges.delete(key)
        commits.delete(key)
        rangeRevisions.delete(key)
        tailRevisions.delete(key)
      }
    },
    revalidate() {
      // A stream gap dirties validation, not ownership of healthy in-flight reads.
      validated.clear()
      ranges.clear()
      stamped.clear()
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
      return end > 0 && !entry.gaps?.some((id) => id === entry.session[end]?.id) || (end === 0 && entry.complete)
    },
    read(directory: string, sessionID: string, limit = 20, before?: string, peek = false): TranscriptPage | undefined {
      const key = keyFor(directory, sessionID)
      const entry = entries.get(key)
      if (!entry) return
      const end = before
        ? entry.session.findIndex((message) => transcriptCursor(message) === before)
        : entry.session.length
      if (end < 0 || (end === 0 && !entry.complete)) return
      const gaps = new Set(entry.gaps)
      const boundary = Math.max(0, entry.session.findLastIndex((message, index) => index <= end && gaps.has(message.id)))
      if (end > 0 && boundary === end) return
      if (!peek) {
        touch(key, entry)
        enqueue({ type: "touch", directory, sessionID })
        changed()
      }
      const start = Math.max(boundary, end - limit)
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
      options: { before?: string; updated?: number; reset?: boolean; validated?: boolean; fresh?: string; range?: { before?: Message } } = {},
    ) {
      if (!enabled) return
      const key = keyFor(directory, sessionID)
      const previous = entries.get(key)
      const keep =
        previous && !options.reset
          ? previous.session.filter((message) => {
              if (options.range) return (
                !!options.range.before && compareMessages(message, options.range.before) >= 0 ||
                !page.complete && !!page.session[0] && compareMessages(message, page.session[0]) < 0
              )
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
      const older = !!previous && !options.reset && (!options.before || options.range) && (!options.range || !page.complete) &&
        keep.some((message) => !page.session[0] || compareMessages(message, page.session[0]) < 0)
      const session = [...messages.values()].sort(compareMessages)
      const previousGaps = new Set(previous?.gaps)
      const gaps = options.range ? session.flatMap((message, index) => {
        if (!index) return []
        const covered = (!options.range!.before || compareMessages(message, options.range!.before) <= 0) &&
          (page.complete || !!page.session[0] && compareMessages(message, page.session[0]) >= 0)
        if (previousGaps.has(message.id) && !covered) return [message.id]
        // Matching the old segment's first message does not bridge the unknown preceding interval.
        if (message.id === page.session[0]?.id && keep.some((item) => compareMessages(item, message) < 0) &&
          (!previous?.session.some((item) => item.id === message.id) || previousGaps.has(message.id))) return [message.id]
        return []
      }) : undefined
      const entry = clone({
        directory,
        sessionID,
        session,
        part: [...parts].map(([id, part]) => ({ id, part })),
        cursor: older ? previous.cursor : page.cursor,
        complete: older ? previous.complete : page.complete,
        updated: options.before ? previous?.updated : (options.updated ?? previous?.updated),
        ...(gaps?.length ? { gaps } : {}),
        ...(options.before && !options.reset && previous?.feed ? { syncCursor: previous.syncCursor, syncGeneration: previous.syncGeneration, feed: previous.feed } : {}),
      })
      if (!validEntry(entry)) return
      if (options.before && previous?.feed && live.has(key)) {
        // A history response can observe newer state than an already dispatched feed read.
        // Treat changed entities like a live overlay; never let that older feed body roll them back.
        const dirty = live.get(key)!
        for (const message of [...page.session, ...previous.session.filter((message) => !messages.has(message.id))]) {
          if (JSON.stringify(previous.session.find((item) => item.id === message.id)) !== JSON.stringify(messages.get(message.id))) {
            const identity = entityKey(message.id)
            dirty.set(identity, (dirty.get(identity) ?? 0) + 1)
          }
        }
        for (const group of page.part) for (const part of group.part) {
          if (JSON.stringify(previous.part.find((item) => item.id === group.id)?.part.find((item) => item.id === part.id)) !== JSON.stringify(part)) {
            const identity = entityKey(group.id, part.id)
            dirty.set(identity, (dirty.get(identity) ?? 0) + 1)
          }
        }
        for (const group of previous.part) for (const part of group.part) {
          if (!parts.get(group.id)?.some((item) => item.id === part.id)) {
            const identity = entityKey(group.id, part.id)
            dirty.set(identity, (dirty.get(identity) ?? 0) + 1)
          }
        }
        if (dirty.size > MAX_VERSIONS) {
          this.resetFeed(directory, sessionID)
          delete entry.feed
          delete entry.syncCursor
          delete entry.syncGeneration
        }
      }
      touch(key, entry)
      if (options.range) {
        // History cannot starve a tail read; old overlapping pages still yield to newer commits.
        const revision = (rangeRevisions.get(key) ?? 0) + 1
        rangeRevisions.set(key, revision)
        if (!options.before) tailRevisions.set(key, (tailRevisions.get(key) ?? 0) + 1)
        validated.delete(key)
        if (options.reset || (!options.before && previous?.updated !== entry.updated)) ranges.delete(key)
        // A confirmed tail can accept live SSE while retained historical ranges remain provisional.
        if (page.session.length || page.complete) {
          const committed = { start: page.complete ? undefined : clone(page.session[0]), end: options.range.before ? clone(options.range.before) : undefined, revision }
          // Dirty validation must not release ownership of already committed HTTP intervals.
          commits.set(key, [...(commits.get(key) ?? []).filter((range) => {
            if (!options.before && !range.end) return false
            return !((!committed.start || !!range.start && compareMessages(range.start, committed.start) >= 0) &&
              (!committed.end || !!range.end && compareMessages(range.end, committed.end) <= 0))
          }), committed])
          const confirmed = ranges.get(key) ?? []
          ranges.set(key, [...confirmed.filter((range) =>
            options.before ? range.end?.id !== options.range?.before?.id : !!range.end,
          ), committed])
        }
        deleted.delete(key)
      }
      if (options.validated) {
        validated.add(key)
        deleted.delete(key)
      }
      // A prepend retains the authorized base; replacements and resets must acquire their own grant.
      enqueue(
        { type: "write", entry, ...(options.fresh ? { fresh: options.fresh } : {}),
          ...(storage?.transcriptMutate && (storage.transcriptReadPage || options.range) ? { page: clone({ session: page.session, part: page.part, cursor: page.cursor, complete: page.complete }), range: options.range ?? {}, ...(options.reset ? { reset: true } : {}) } : {}) },
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
      live.delete(key)
      stamped.delete(key)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      validated.delete(key)
      ranges.delete(key)
      commits.delete(key)
      rangeRevisions.delete(key)
      tailRevisions.delete(key)
      active.delete(key)
      entries.delete(key)
      enqueue({ type: "remove", directory, sessionID })
      changed()
    },
    clearDirectory(directory: string) {
      bump(directory)
      generations.set(directory, (generations.get(directory) ?? 0) + 1)
      for (const key of live.keys()) if ((JSON.parse(key) as [string, string])[0] === directory) live.delete(key)
      for (const key of stamped.keys()) if ((JSON.parse(key) as [string, string])[0] === directory) stamped.delete(key)
      enqueue({ type: "clearDirectory", directory })
      for (const [key, entry] of entries)
        if (entry.directory === directory) {
          bump(key)
          validated.delete(key)
          ranges.delete(key)
          commits.delete(key)
          rangeRevisions.delete(key)
          tailRevisions.delete(key)
          active.delete(key)
          live.delete(key)
          generations.set(key, (generations.get(key) ?? 0) + 1)
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
        transcript?: unknown
      }
      if (event.type === "session.deleted") {
        this.remove(directory, props.info!.id)
        return
      }
      if (event.type === "session.status" && props.sessionID) {
        const key = keyFor(directory, props.sessionID)
        const revisions = live.get(key)
        if (revisions) revisions.set(entityKey("status"), (revisions.get(entityKey("status")) ?? 0) + 1)
        return
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const key = keyFor(directory, props.info!.id)
        if (live.has(key)) live.get(key)!.set(entityKey("session"), (live.get(key)!.get(entityKey("session")) ?? 0) + 1)
        const entry = entries.get(key)
        const updated = entry?.updated
        if (entry?.feed && validFeedSession(props.info, directory, entry.sessionID)) {
          entry.feed.session = clone(props.info)
          entry.updated = props.info.time.updated
          enqueue({ type: "write", entry })
          changed()
        }
        metadataRevisions.set(key, (metadataRevisions.get(key) ?? 0) + 1)
        if (event.type === "session.created") deleted.delete(key)
        if (event.type === "session.updated" && updated !== props.info?.time.updated) {
          if (!active.has(key)) validated.delete(key)
          if (ranges.has(key)) ranges.set(key, active.has(key) ? ranges.get(key)!.filter((range) => !range.end) : [])
          bump(key)
          commits.delete(key)
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
      if (deleted.has(key) && feedCapability === true) return false
      const entry = entries.get(key)
      const id = props.info?.id ?? props.part?.messageID ?? props.messageID
      const partID = props.part?.id ?? props.partID
      const identity = id ? entityKey(id, partID) : undefined
      const stamp = transcriptRecord(props.transcript) ? props.transcript : undefined
      const sequenced = (live.has(key) || !!entry?.feed) && stamp !== undefined && feedGeneration(stamp.generation) && Number.isSafeInteger(stamp.seq) && Number(stamp.seq) >= 0
      if (live.has(key) || entry?.feed) {
        if (props.transcript !== undefined && !sequenced) return false
        if (props.info && !validTranscriptMessage(props.info) || props.part && !validTranscriptPart(props.part)) {
          return false
        }
        if (sequenced && identity) {
          const generation = stamp.generation as string
          const seq = stamp.seq as number
          if (retired.get(key)?.has(generation)) return false
          const knownGeneration = entry?.syncGeneration ?? feedGenerations.get(key)
          if (knownGeneration && knownGeneration !== generation) {
            const candidates = foreign.get(key) ?? new Set<string>()
            candidates.add(generation)
            if (candidates.size > 16) candidates.delete(candidates.values().next().value!)
            foreign.set(key, candidates)
            this.resetFeed(directory, sessionID)
            return false
          }
          feedGenerations.set(key, generation)
          const version = entry?.feed?.versions.find((item) => entityKey(item.messageID, item.partID) === identity)
          const removed = entry?.feed?.versions.find((item) => item.messageID === id && !item.partID && item.removed)
          const prior = stamped.get(key)?.get(identity)
          const baseline = entry?.feed?.snapshot.includes(id!) ? entry.feed.version : -1
          const seen = Math.max(version?.seq ?? baseline, prior?.generation === generation ? prior.seq : -1)
          const full = Math.max(coverage(version, baseline), coverage(prior?.generation === generation ? prior : undefined))
          const replacement = event.type === "message.part.updated" || event.type === "message.part.removed"
          if ((seq < seen || seq === seen && !(replacement && full < seen || invalidated.has(key) && event.type === "message.part.updated")) ||
            removed && (seq <= removed.seq || event.type !== "message.updated")) return false
          if (event.type === "message.part.delta" &&
            (!entry?.feed && !prior || invalidated.has(key) && !prior || !entry?.part.find((item) => item.id === id)?.part.some((part) => part.id === partID) && !prior ||
              props.field !== "text" || typeof props.delta !== "string")) return false
          // An additive delta cannot establish its own base after a stream gap or disk hydration.
          // Wait for a current-state feed replacement or a full live part before trusting that append.
          if (event.type === "message.part.delta" && entry?.feed && !prior && !(ranges.get(key) ?? []).some((range) => !range.end)) return false
        }
        if (!sequenced && entry?.feed && entry.feed.versions.some((item) => item.messageID === id && item.removed && (!item.partID || item.partID === partID))) return false
        if (entry?.feed && !entry.session.some((message) => message.id === id) && (!props.info || entry.feed.after &&
          (props.info.time.created < entry.feed.after.created || props.info.time.created === entry.feed.after.created && props.info.id <= entry.feed.after.id))) return false
        // Unsequenced mutations cannot certify entity state, even if the next changes page is empty.
        if (!sequenced && entry?.feed) {
          invalidated.add(key)
          delete entry.syncCursor
          if (identity) stamped.get(key)?.delete(identity)
        }
      }
      if (live.has(key)) {
        if (id) {
          if (!sequenced && entry?.feed?.versions.some((item) => item.messageID === id && item.removed && (!item.partID || item.partID === partID))) return false
          const known = entry?.session.some((message) => message.id === id)
          const after = entry?.feed?.after
          if (entry?.feed && !known && (!props.info || after && (props.info.time.created < after.created ||
            props.info.time.created === after.created && props.info.id <= after.id))) return false
          const identity = entityKey(id, partID)
          if (live.get(key)!.size >= MAX_VERSIONS && !live.get(key)!.has(identity)) {
            this.resetFeed(directory, sessionID)
            live.set(key, new Map())
          }
          if (!sequenced || !entry?.feed) live.get(key)!.set(identity, (live.get(key)!.get(identity) ?? 0) + 1)
        }
      }
      bump(key)
      commits.delete(key)
      if (!entry) {
        if (sequenced && identity) {
          const versions = stamped.get(key) ?? new Map<string, { generation: string; seq: number; full?: number }>()
          const prior = versions.get(identity)
          versions.set(identity, { generation: stamp.generation as string, seq: stamp.seq as number,
            ...(event.type === "message.part.delta" ? { full: coverage(prior, 0) } : {}) })
          stamped.set(key, versions)
        }
        return // Never mirror sessions which have not been fetched.
      }
      // Freeze queued HTTP snapshots before mutating the renderer's provisional entry.
      if (storage?.transcriptMutate) pending = pending.map((operation) =>
        operation.type === "write" && operation.entry === entry ? { ...operation, entry: clone(entry) } : operation)
      if (event.type === "message.updated" && props.info) {
        if (!entry.session.some((message) => message.id === props.info!.id)) {
          const tail = entry.session.at(-1)
          if (
            !active.has(key) ||
            (!entry.feed && !validated.has(key) && !(ranges.get(key) ?? []).some((range) => !range.end)) ||
            (tail && compareMessages(props.info, tail) <= 0) ||
            (!entry.feed && props.info.role === "assistant" &&
              !entry.session.some(
                (message) => message.id === (props.info as Extract<Message, { role: "assistant" }>).parentID,
              ) &&
              !((ranges.get(key) ?? []).some((range) => !range.end) && tail?.role === "assistant" &&
                typeof props.info.parentID === "string" && props.info.parentID.length > 0 && tail.parentID === props.info.parentID))
          ) {
            // Only an opened, validated connection can extend its live message sequence.
            validated.delete(key)
            ranges.delete(key)
            return
          }
        }
        entry.session = [...entry.session.filter((message) => message.id !== props.info!.id), clone(props.info)].sort(
          compareMessages,
        )
        if (!entry.part.some((part) => part.id === props.info!.id)) entry.part.push({ id: props.info.id, part: [] })
      }
      if (event.type === "message.removed") {
        const next = entry.session[entry.session.findIndex((message) => message.id === props.messageID) + 1]
        if (entry.gaps?.includes(props.messageID!)) entry.gaps = entry.gaps.flatMap((id) =>
          id !== props.messageID ? [id] : next ? [next.id] : [])
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
      if (sequenced && identity && id) {
        const versions = stamped.get(key) ?? new Map<string, { generation: string; seq: number; full?: number }>()
        const current = entry.feed?.versions.find((item) => entityKey(item.messageID, item.partID) === identity)
        const baseline = entry.feed?.snapshot.includes(id) ? entry.feed.version : 0
        const version = { generation: stamp.generation as string, seq: stamp.seq as number,
          ...(event.type === "message.part.delta" ? { full: Math.max(coverage(current, baseline), coverage(versions.get(identity), 0)) } : {}) }
        versions.set(identity, version)
        stamped.set(key, versions)
        if (entry.feed) {
          entry.feed.versions = [...entry.feed.versions.filter((item) => entityKey(item.messageID, item.partID) !== identity),
            { messageID: id, ...(partID ? { partID } : {}), seq: version.seq,
              ...(version.full !== undefined ? { full: version.full } : {}),
              ...(event.type === "message.removed" || event.type === "message.part.removed" ? { removed: true } : {}) }]
          if (entry.feed.versions.length > MAX_VERSIONS) this.resetFeed(directory, sessionID)
        }
      }
      touch(key, entry)
      if (entry.gaps) {
        const gaps = new Set(entry.gaps)
        entry.gaps = entry.session.flatMap((message, index) => index > 0 && gaps.has(message.id) ? [message.id] : [])
      }
      if (storage?.transcriptMutate) {
        if (event.type === "message.removed" && props.messageID)
          enqueue({ type: "removeMessage", directory, sessionID, messageID: props.messageID })
        if (event.type === "message.updated" && props.info)
          enqueue({ type: "event", directory, sessionID, event: { type: "message.updated", info: props.info } })
        if (event.type === "message.part.updated" && props.part)
          enqueue({ type: "event", directory, sessionID, event: { type: "message.part.updated", part: props.part } })
        if (event.type === "message.part.removed" && props.messageID && props.partID)
          enqueue({ type: "event", directory, sessionID, event: { type: "message.part.removed", messageID: props.messageID, partID: props.partID } })
        if (event.type === "message.part.delta" && props.messageID && props.partID && props.field === "text" && typeof props.delta === "string")
          enqueue({ type: "event", directory, sessionID, event: { type: "message.part.delta", messageID: props.messageID, partID: props.partID, delta: props.delta } })
      }
      changed()
    },
  }
}
export type TranscriptCache = ReturnType<typeof createTranscriptCache>

export function validEntry(value: unknown): value is Entry {
  if (!transcriptRecord(value)) return false
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
  if (entry.syncCursor !== undefined && (!feedText(entry.syncCursor) || !entry.feed || !feedGeneration(entry.syncGeneration))) return false
  if (entry.syncGeneration !== undefined && (!feedGeneration(entry.syncGeneration) || !entry.feed)) return false
  if (entry.feed !== undefined && (!feedGeneration(entry.syncGeneration) || !validFeed(entry.feed, entry.directory, entry.sessionID))) return false
  const ids = new Set<string>()
  for (const message of entry.session) {
    if (
      !validTranscriptMessage(message) ||
      ids.has(message.id) ||
      message.sessionID !== entry.sessionID
    )
      return false
    ids.add(message.id)
  }
  if (entry.gaps !== undefined) {
    if (!Array.isArray(entry.gaps) || entry.gaps.length > entry.session.length) return false
    const messages = new Map(entry.session.map((message, index) => [message.id, index]))
    const positions = entry.gaps.map((id) => typeof id === "string" ? messages.get(id) ?? -1 : -1)
    if (positions.some((index, offset) => index <= 0 || offset > 0 && index <= positions[offset - 1])) return false
  }
  const parts = new Set<string>()
  for (const item of entry.part) {
    if (!ids.has(item?.id) || parts.has(item.id) || !Array.isArray(item.part)) return false
    parts.add(item.id)
    const seen = new Set<string>()
    for (const part of item.part) {
      if (
        !validTranscriptPart(part) ||
        seen.has(part.id) ||
        part.messageID !== item.id ||
        part.sessionID !== entry.sessionID
      )
        return false
      seen.add(part.id)
    }
  }
  return parts.size === ids.size
}

export function feedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
}

export function feedGeneration(value: unknown): value is string {
  return feedText(value) && value.length <= 256
}

export function validFeedSession(value: unknown, directory: string, sessionID: string): value is Session {
  if (!transcriptRecord(value)) return false
  const session = value as Session
  return session.id === sessionID && session.directory === directory && feedText(session.projectID) &&
    feedText(session.slug) && typeof session.title === "string" && session.title.length <= 16384 && feedText(session.version) &&
    Number.isFinite(session.time?.created) && Number.isFinite(session.time?.updated)
}

function validFeed(value: unknown, directory: string, sessionID: string): value is TranscriptFeed {
  if (!transcriptRecord(value)) return false
  const feed = value as TranscriptFeed
  if (!Object.keys(feed).every((key) => ["version", "after", "versions", "session", "snapshot"].includes(key)) ||
    !Number.isSafeInteger(feed.version) || feed.version < 0 || !validFeedSession(feed.session, directory, sessionID) ||
    !Array.isArray(feed.versions) || feed.versions.length > MAX_VERSIONS || !Array.isArray(feed.snapshot) || feed.snapshot.length > 20 ||
    !feed.snapshot.every((id) => typeof id === "string" && /^[\w-]+$/.test(id)) || new Set(feed.snapshot).size !== feed.snapshot.length) return false
  if (feed.after !== undefined && (!feed.after || !feedText(feed.after.id) || !Number.isFinite(feed.after.created) || feed.after.created < 0 ||
    Object.keys(feed.after).some((key) => !["id", "created"].includes(key)))) return false
  const seen = new Set<string>()
  return feed.versions.every((item) => {
    if (!transcriptRecord(item) || !feedText(item.messageID) ||
      item.partID !== undefined && !feedText(item.partID) || !Number.isSafeInteger(item.seq) || item.seq < 0 ||
      item.removed !== undefined && typeof item.removed !== "boolean" ||
      item.full !== undefined && (!Number.isSafeInteger(item.full) || item.full < 0 || item.full > item.seq || !item.partID || item.removed === true) ||
      Object.keys(item).some((key) => !["messageID", "partID", "seq", "full", "removed"].includes(key))) return false
    const identity = entityKey(item.messageID, item.partID)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}
