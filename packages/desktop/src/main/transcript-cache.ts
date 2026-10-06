import { randomUUID } from "node:crypto"
import {
  validEntry,
  transcriptCursor,
  type TranscriptEntry,
  type TranscriptMutation,
} from "../../../app/src/context/global-sync/transcript-cache"
import { compareMessages } from "../../../app/src/utils/message-order"

const MAX_BYTES = 16 * 1024 * 1024
const keyFor = (directory: string, sessionID: string) => JSON.stringify([directory, sessionID])

// One authority for all windows. Revisions include tombstones, not just live entries.
export function createTranscriptAuthority(
  storage: {
    get: (scope: string) => unknown
    set: (scope: string, value: string) => void
  },
  budget = MAX_BYTES,
  limit = 100,
) {
  const scopes = new Map<
    string,
    {
      entries: Map<string, TranscriptEntry>
      revisions: Map<string, number>
      directories: Map<string, number>
      generation: number
      raw: unknown
    }
  >()
  const owners = new Map<
    string,
    {
      client: number
      scope: string
      generation: number
      revisions: Map<string, number>
      directories: Map<string, number>
      boundaries: Map<string, number>
    }
  >()
  const grants = new Map<string, { owner: string; key: string; revision: number; directory: number }>()
  const releaseOwner = (token: string) => {
    owners.delete(token)
    for (const [fresh, grant] of grants) if (grant.owner === token) grants.delete(fresh)
  }
  const state = (scope: string) => {
    const cached = scopes.get(scope)
    const raw = storage.get(scope)
    if (cached && raw === cached.raw) return cached
    // Disconnect/pairing cleanup can remove the backing store outside renderer IPC.
    if (cached) for (const [token, owner] of owners) if (owner.scope === scope) releaseOwner(token)
    const next = {
      entries: new Map<string, TranscriptEntry>(),
      revisions: new Map<string, number>(),
      directories: new Map<string, number>(),
      generation: 0,
      raw,
    }
    if (typeof raw === "string" && Buffer.byteLength(raw) <= budget) {
      try {
        const value = JSON.parse(raw)
        if (value.version === 1 && Array.isArray(value.entries) && value.entries.length <= limit)
          for (const entry of value.entries)
            if (validEntry(entry)) next.entries.set(keyFor(entry.directory, entry.sessionID), entry)
      } catch {
        // Disposable cache corruption must not block opening a window.
      }
    }
    scopes.set(scope, next)
    return next
  }
  const serialize = (value: ReturnType<typeof state>) =>
    JSON.stringify({ version: 1, entries: [...value.entries.values()] })
  const persist = (scope: string) => {
    const value = state(scope)
    while (value.entries.size > limit || Buffer.byteLength(serialize(value)) > budget) {
      const key = value.entries.keys().next().value
      if (key === undefined) break
      value.entries.delete(key)
      value.revisions.set(key, ++value.generation)
    }
    const raw = serialize(value)
    storage.set(scope, raw)
    value.raw = raw
  }
  return {
    read(scope: string, client: number, indexOnly = false) {
      const value = state(scope)
      const owner = randomUUID()
      owners.set(owner, {
        client,
        scope,
        generation: value.generation,
        revisions: new Map(),
        directories: new Map(),
        boundaries: new Map(),
      })
      return JSON.stringify({ version: 1, entries: indexOnly ? [] : [...value.entries.values()], owner })
    },
    open(scope: string, client: number): { owner: string } {
      return { owner: JSON.parse(this.read(scope, client, true)).owner }
    },
    readPage(scope: string, client: number, token: string, directory: string, sessionID: string, before?: string) {
      const value = state(scope)
      const owner = owners.get(token)
      if (!owner || owner.client !== client || owner.scope !== scope || typeof directory !== "string" || typeof sessionID !== "string" || (before !== undefined && typeof before !== "string")) return
      const entry = value.entries.get(keyFor(directory, sessionID))
      if (!entry) return
      const end = before ? entry.session.findIndex((message) => transcriptCursor(message) === before) : entry.session.length
      if (end < 0 || end === 0 && !entry.complete) return
      const gaps = new Set(entry.gaps)
      const boundary = Math.max(0, entry.session.findLastIndex((message, index) => index <= end && gaps.has(message.id)))
      if (end > 0 && boundary === end) return
      const start = Math.max(boundary, end - 20)
      const session = entry.session.slice(start, end)
      const ids = new Set(session.map((message) => message.id))
      return structuredClone({ directory, sessionID, session, part: entry.part.filter((part) => ids.has(part.id)),
        cursor: start > 0 ? transcriptCursor(session[0]) : entry.cursor, complete: start === 0 && entry.complete, updated: entry.updated })
    },
    acquire(scope: string, client: number, token: string, directory: string, sessionID: string) {
      // Observe tombstones before network I/O without rebasing any stale snapshot.
      const value = state(scope)
      const owner = owners.get(token)
      if (
        !owner ||
        owner.client !== client ||
        owner.scope !== scope ||
        typeof directory !== "string" ||
        typeof sessionID !== "string" ||
        !sessionID
      )
        return
      const key = keyFor(directory, sessionID)
      const fresh = randomUUID()
      const revision = value.revisions.get(key) ?? 0
      const boundary = value.directories.get(directory) ?? 0
      grants.set(fresh, { owner: token, key, revision, directory: boundary })
      while (grants.size > 1000) grants.delete(grants.keys().next().value!)
      return {
        token: fresh,
        epoch: Math.max(revision, boundary),
        revalidate:
          revision > (owner.revisions.get(key) ?? owner.generation) ||
          boundary > Math.max(owner.boundaries.get(key) ?? 0, owner.directories.get(directory) ?? owner.generation),
      }
    },
    mutate(scope: string, client: number, token: string, operations: unknown) {
      const value = state(scope)
      const owner = owners.get(token)
      if (!owner || owner.client !== client || owner.scope !== scope || !validOperations(operations)) return
      for (const operation of operations) {
        if (operation.type === "clearDirectory") {
          value.directories.set(operation.directory, ++value.generation)
          owner.directories.set(operation.directory, value.generation)
          for (const [key, entry] of value.entries) {
            if (entry.directory !== operation.directory) continue
            value.entries.delete(key)
            value.revisions.set(key, value.generation)
            owner.revisions.set(key, value.generation)
          }
          continue
        }
        const entry = operation.type === "write" ? operation.entry : operation
        const key = keyFor(entry.directory, entry.sessionID)
        const current = value.revisions.get(key) ?? 0
        const directory = value.directories.get(entry.directory) ?? 0
        const fresh = operation.type === "write" && operation.fresh ? grants.get(operation.fresh) : undefined
        if (operation.type === "write" && operation.fresh) grants.delete(operation.fresh)
        if (
          operation.type === "write" &&
          operation.fresh &&
          (!fresh ||
            fresh.owner !== token ||
            fresh.key !== key ||
            fresh.revision !== current ||
            fresh.directory !== directory)
        )
          continue
        if (
          !fresh &&
          operation.type !== "remove" &&
          (current > (owner.revisions.get(key) ?? owner.generation) ||
            directory >
              Math.max(owner.boundaries.get(key) ?? 0, owner.directories.get(entry.directory) ?? owner.generation))
        )
          continue
        if (operation.type === "touch") {
          const cached = value.entries.get(key)
          if (!cached) continue
          value.entries.delete(key)
          value.entries.set(key, cached)
          continue
        }
        const previous = value.entries.get(key)
        if (operation.type === "event" || operation.type === "removeMessage") {
          if (!previous) continue
          const next = structuredClone(previous)
          if (operation.type === "removeMessage") {
            const index = next.session.findIndex((message) => message.id === operation.messageID)
            const successor = index >= 0 ? next.session[index + 1] : undefined
            next.gaps = next.gaps?.flatMap((id) => id !== operation.messageID ? [id] : successor ? [successor.id] : [])
            next.session = next.session.filter((message) => message.id !== operation.messageID)
            next.part = next.part.filter((part) => part.id !== operation.messageID)
          }
          if (operation.type === "event") {
            const event = operation.event
            if (event.type === "message.updated") {
              next.session = [...next.session.filter((message) => message.id !== event.info.id), event.info].sort(compareMessages)
              if (!next.part.some((part) => part.id === event.info.id)) next.part.push({ id: event.info.id, part: [] })
            }
            const item = next.part.find((part) => part.id === (event.type === "message.part.updated" ? event.part.messageID : "messageID" in event ? event.messageID : undefined))
            if (item && event.type === "message.part.updated")
              item.part = [...item.part.filter((part) => part.id !== event.part.id), event.part].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            if (item && event.type === "message.part.removed") item.part = item.part.filter((part) => part.id !== event.partID)
            if (item && event.type === "message.part.delta") {
              const part = item.part.find((part) => part.id === event.partID)
              if (part && (part.type === "text" || part.type === "reasoning")) part.text += event.delta
            }
          }
          if (next.gaps) next.gaps = next.session.flatMap((message, index) => index > 0 && next.gaps!.includes(message.id) ? [message.id] : [])
          if (!validEntry(next)) continue
          value.entries.delete(key)
          value.entries.set(key, next)
          value.revisions.set(key, ++value.generation)
          owner.revisions.set(key, value.generation)
          continue
        }
        value.entries.delete(key)
        if (operation.type === "write") {
          const page = operation.page
          if (!page || !operation.range || !previous || operation.reset) value.entries.set(key, structuredClone(operation.entry))
          else {
            const before = operation.range.before
            const keep = previous.session.filter((message) =>
              !!before && compareMessages(message, before) >= 0 ||
              !page.complete && !!page.session[0] && compareMessages(message, page.session[0]) < 0 ||
              operation.entry.gaps?.some((id) => {
                const index = operation.entry.session.findIndex((item) => item.id === id)
                return index > 0 && compareMessages(message, operation.entry.session[index - 1]) > 0 &&
                  compareMessages(message, operation.entry.session[index]) < 0
              }))
            const messages = new Map([...keep, ...page.session].map((message) => [message.id, message]))
            const session = [...messages.values()].sort(compareMessages)
            const parts = new Map(previous.part.filter((part) => messages.has(part.id)).map((part) => [part.id, part]))
            for (const part of page.part) parts.set(part.id, part)
            const older = keep.some((message) => !page.session[0] || compareMessages(message, page.session[0]) < 0)
            const gaps = session.flatMap((message, index) => {
              if (!index) return []
              if (operation.entry.gaps?.includes(message.id) &&
                (!previous.session.some((item) => item.id === message.id) || previous.gaps?.includes(message.id))) return [message.id]
              const covered = (!before || compareMessages(message, before) <= 0) &&
                (page.complete || !!page.session[0] && compareMessages(message, page.session[0]) >= 0)
              if (previous.gaps?.includes(message.id) && !covered) return [message.id]
              if (message.id === page.session[0]?.id && older &&
                (!previous.session.some((item) => item.id === message.id) || previous.gaps?.includes(message.id))) return [message.id]
              return []
            })
            value.entries.set(key, structuredClone({ ...operation.entry, session, part: [...parts.values()],
              cursor: older ? previous.cursor : page.cursor, complete: older ? previous.complete : page.complete,
              ...(gaps.length ? { gaps } : { gaps: undefined }) }))
          }
        }
        value.revisions.set(key, ++value.generation)
        owner.revisions.set(key, value.generation)
        // Disjoint reads in one renderer may commit while its tail HTTP is still in flight.
        // Never rebase a grant across another owner, a removal or a directory tombstone.
        if (operation.type === "write" && !operation.reset) for (const grant of grants.values())
          if (grant.owner === token && grant.key === key && grant.revision === current && grant.directory === directory)
            grant.revision = value.generation
        if (fresh) owner.boundaries.set(key, directory)
      }
      persist(scope)
    },
    delete(scope: string) {
      const value = state(scope)
      for (const key of value.entries.keys()) value.revisions.set(key, ++value.generation)
      value.entries.clear()
      // Also invalidate writes to sessions absent from the deleted snapshot.
      for (const [token, owner] of owners) if (owner.scope === scope) releaseOwner(token)
      persist(scope)
    },
    release(client: number) {
      for (const [token, owner] of owners) if (owner.client === client) releaseOwner(token)
    },
  }
}

function validOperations(value: unknown): value is TranscriptMutation[] {
  if (!Array.isArray(value) || value.length > 1000 || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) return false
  return value.every((operation) => {
    if (!operation || typeof operation !== "object") return false
    if (operation.type === "event" || operation.type === "removeMessage") {
      if (typeof operation.directory !== "string" || typeof operation.sessionID !== "string" || !operation.sessionID) return false
      if (operation.type === "removeMessage") return Object.keys(operation).every((key) => ["type", "directory", "sessionID", "messageID"].includes(key)) &&
        typeof operation.messageID === "string" && /^[\w-]+$/.test(operation.messageID)
      if (!Object.keys(operation).every((key) => ["type", "directory", "sessionID", "event"].includes(key)) || !operation.event || typeof operation.event !== "object") return false
      const event = operation.event
      if (event.type === "message.updated") return Object.keys(event).every((key) => ["type", "info"].includes(key)) &&
        !!event.info && validEntry({ directory: operation.directory, sessionID: operation.sessionID, session: [event.info], part: [{ id: event.info.id, part: [] }], complete: true })
      if (event.type === "message.part.updated") return Object.keys(event).every((key) => ["type", "part"].includes(key)) &&
        !!event.part && event.part.sessionID === operation.sessionID
      if (!["message.part.removed", "message.part.delta"].includes(event.type)) return false
      return Object.keys(event).every((key) => ["type", "messageID", "partID", ...(event.type === "message.part.delta" ? ["delta"] : [])].includes(key)) &&
        typeof event.messageID === "string" && /^[\w-]+$/.test(event.messageID) && typeof event.partID === "string" && !!event.partID &&
        (event.type !== "message.part.delta" || typeof event.delta === "string")
    }
    if (operation.type === "write")
      return (
        Object.keys(operation).every((key) => ["type", "entry", "fresh", "page", "range", "reset"].includes(key)) &&
        (operation.reset === undefined || typeof operation.reset === "boolean") &&
        (operation.range === undefined || typeof operation.range === "object" && operation.range !== null &&
          Object.keys(operation.range).every((key) => key === "before") &&
          (operation.range.before === undefined || operation.range.before !== null && typeof operation.range.before === "object" && typeof operation.range.before.id === "string" && operation.range.before.sessionID === operation.entry.sessionID && Number.isFinite(operation.range.before.time?.created))) &&
        (operation.page === undefined || operation.page !== null && typeof operation.page === "object" &&
          Object.keys(operation.page).every((key) => ["session", "part", "cursor", "complete"].includes(key)) &&
          validEntry({ ...operation.entry, ...operation.page, gaps: undefined }) &&
          (operation.page.complete || operation.page.session.length > 0) &&
          (!operation.range?.before || operation.page.session.every((message: TranscriptEntry["session"][number]) => compareMessages(message, operation.range.before) < 0))) &&
        (operation.fresh === undefined || typeof operation.fresh === "string") &&
        validEntry(operation.entry) &&
        Object.keys(operation.entry).every((key) =>
          ["directory", "sessionID", "session", "part", "cursor", "complete", "updated", "gaps"].includes(key),
        )
      )
    if (
      !["touch", "remove", "evict", "clearDirectory"].includes(operation.type) ||
      typeof operation.directory !== "string"
    )
      return false
    if (!Object.keys(operation).every((key) => ["type", "directory", "sessionID"].includes(key))) return false
    return operation.type === "clearDirectory" || (typeof operation.sessionID === "string" && !!operation.sessionID)
  })
}
