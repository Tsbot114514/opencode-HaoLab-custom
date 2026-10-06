import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { cleanupDroppedSessionCaches } from "./event-reducer"
import { trimSessions } from "./session-trim"
import type { State } from "./types"

type Title = Pick<Session, "id" | "slug" | "title" | "directory" | "projectID" | "version"> & {
  time: { created: number; updated: number }
}
type Change = { seq: number; type: "upsert"; session: Title } | { seq: number; type: "remove"; id: string }
export type SidebarNext = { updated: number; id: string }

export async function loadSidebarFeed(input: { sdk: OpencodeClient; directory: string; cursor?: string; limit?: number; snapshot?: boolean }) {
  const limit = "200"
  const unavailable = (result: { response: Response; data?: unknown }) =>
    result.response.status === 404 || (result.response.ok &&
      (!result.response.headers.get("content-type")?.includes("json") || typeof result.data === "string"))
  const request = async <T>(call: () => Promise<{ response: Response; data?: T; error?: unknown }>, resetOnBadCursor = false) => {
    const result = await call().catch((error: unknown) => {
      if (error instanceof Error && error.message === "Request is not supported by this version of OpenCode Server (Server responded with text/html)") return undefined
      throw error
    })
    if (!result) return undefined
    if (!result.response) throw result.error ?? new Error("Sidebar feed unavailable")
    if (unavailable(result)) return undefined
    if (result.response.status === 410 || (resetOnBadCursor && result.response.status === 400)) return "expired" as const
    if (!result.response.ok || !result.data) throw result.error ?? new Error("Invalid sidebar feed response")
    return result.data
  }
  if (input.cursor && !input.snapshot) {
    const changes: Change[] = []
    let cursor = Number(input.cursor)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid sidebar cursor")
    for (;;) {
      const page = await request(() => input.sdk.session.sidebarChanges({ directory: input.directory, limit, cursor: String(cursor) }, { throwOnError: false }), true)
      if (!page || page === "expired") return page
      if (!Array.isArray(page.changes) || typeof page.cursor !== "number" || !Number.isSafeInteger(page.cursor) || page.cursor < cursor ||
        typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.more !== "boolean" ||
        (page.more && page.cursor === cursor)) throw new Error("Invalid sidebar changes")
      changes.push(...page.changes as Change[])
      cursor = page.cursor as number
      if (!page.more) return { kind: "changes" as const, cursor: String(cursor), total: page.total as number, changes }
    }
  }
  const items: Title[] = []
  let next: SidebarNext | null | undefined
  let cursor: number | undefined
  let total: number | undefined
  for (;;) {
    const count = Math.min(200, Math.max(1, (input.limit ?? 55) - items.length))
    const page = await request(() => input.sdk.session.sidebarSnapshot({ directory: input.directory, limit: String(count), ...(cursor === undefined ? {} : { cursor: String(cursor) }), ...(next ? { afterUpdated: String(next.updated), afterID: next.id } : {}) }, { throwOnError: false }))
    if (!page || page === "expired") return page
    if (!Array.isArray(page.items) || typeof page.cursor !== "number" || !Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
      typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0 ||
      (cursor !== undefined && page.cursor !== cursor) || (page.next !== null &&
        (!page.next || typeof page.next.updated !== "number" || !Number.isFinite(page.next.updated) ||
          typeof page.next.id !== "string" || !page.next.id || !page.items.length ||
          (page.next.id === next?.id && page.next.updated === next.updated))))
      throw new Error("Invalid sidebar snapshot")
    items.push(...page.items as Title[])
    cursor = page.cursor as number
    total = page.total as number
    next = page.next as SidebarNext | null
    if (!next || items.length >= (input.limit ?? 55))
      return { kind: "snapshot" as const, cursor: String(cursor), total: total!, items }
  }
}

export function applySidebarFeed(input: {
  store: Store<State>
  setStore: SetStoreFunction<State>
  feed: { kind: "snapshot"; items: Title[]; total: number } | { kind: "changes"; changes: Change[]; total: number }
  recentLimit?: number
  clearTodo: (id: string) => void
}) {
  const roots = new Map(input.feed.kind === "snapshot" ? [] : input.store.session.filter((s) => !s.parentID).map((s) => [s.id, s] as const))
  if (input.feed.kind !== "changes") for (const item of input.feed.items) roots.set(item.id, { ...roots.get(item.id), ...item } as Session)
  if (input.feed.kind !== "snapshot") {
    for (const change of input.feed.changes) {
      if (change.type === "remove") roots.delete(change.id)
      else roots.set(change.session.id, { ...roots.get(change.session.id), ...change.session, time: change.session.time } as Session)
    }
  }
  const sessions = trimSessions([...roots.values(), ...input.store.session.filter((s) => !!s.parentID)], {
    limit: input.store.limit, permission: input.store.permission, recentLimit: input.recentLimit,
  })
  batch(() => {
    input.setStore("sessionTotal", input.feed.total)
    input.setStore("session", reconcile(sessions, { key: "id" }))
    cleanupDroppedSessionCaches(input.store, input.setStore, sessions, input.clearTodo)
  })
}

export function applySessionReconciliation(input: {
  store: Store<State>
  setStore: SetStoreFunction<State>
  changes: { upserts: Session[]; removed: string[]; limited: boolean }
  recentLimit?: number
  clearTodo: (id: string) => void
}) {
  const known = new Set(input.store.session.filter((s) => !s.parentID).map((s) => s.id))
  const removed = new Set(input.changes.removed)
  const upserts = new Map(input.changes.upserts.filter((s) => s.id && !s.parentID && !s.time.archived).map((s) => [s.id, s]))
  const roots = input.store.session.filter((s) => !s.parentID && !removed.has(s.id) && !upserts.has(s.id))
  const sessions = trimSessions([...roots, ...upserts.values(), ...input.store.session.filter((s) => !!s.parentID)], {
    limit: input.store.limit,
    permission: input.store.permission,
    recentLimit: input.recentLimit,
  })
  const delta = [...upserts.keys()].filter((id) => !known.has(id)).length - [...removed].filter((id) => known.has(id)).length
  const total = input.changes.limited ? input.store.sessionTotal + delta : known.size + delta
  batch(() => {
    input.setStore("sessionTotal", Math.max(total, sessions.filter((s) => !s.parentID).length, input.changes.limited ? input.store.limit + 1 : 0))
    input.setStore("session", reconcile(sessions, { key: "id" }))
    cleanupDroppedSessionCaches(input.store, input.setStore, sessions, (id) => input.clearTodo(id))
  })
}
