import { randomUUID } from "node:crypto"
import {
  validEntry,
  type TranscriptEntry,
  type TranscriptMutation,
} from "../../../app/src/context/global-sync/transcript-cache"

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
    read(scope: string, client: number) {
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
      return JSON.stringify({ version: 1, entries: [...value.entries.values()], owner })
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
      for (const [fresh, grant] of grants) if (grant.owner === token && grant.key === key) grants.delete(fresh)
      const fresh = randomUUID()
      const revision = value.revisions.get(key) ?? 0
      const boundary = value.directories.get(directory) ?? 0
      grants.set(fresh, { owner: token, key, revision, directory: boundary })
      while (grants.size > 1000) grants.delete(grants.keys().next().value!)
      return {
        token: fresh,
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
        value.entries.delete(key)
        if (operation.type === "write") value.entries.set(key, structuredClone(operation.entry))
        value.revisions.set(key, ++value.generation)
        owner.revisions.set(key, value.generation)
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
    if (operation.type === "write")
      return (
        Object.keys(operation).every((key) => ["type", "entry", "fresh"].includes(key)) &&
        (operation.fresh === undefined || typeof operation.fresh === "string") &&
        validEntry(operation.entry) &&
        Object.keys(operation.entry).every((key) =>
          ["directory", "sessionID", "session", "part", "cursor", "complete", "updated"].includes(key),
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
