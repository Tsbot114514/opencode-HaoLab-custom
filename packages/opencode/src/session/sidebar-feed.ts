import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SessionSidebarBaseTable as base, SessionSidebarChangeTable as change, SessionSidebarCountTable as count, SessionSidebarStateTable as state } from "./session.sql"
import type { ProjectID } from "@/project/schema"
import type { SessionID } from "./schema"

export type Scope = { projectID: ProjectID; directory: string }
export type Title = {
  id: SessionID
  slug: string
  title: string
  directory: string
  projectID: ProjectID
  version: string
  time: { created: number; updated: number }
}

function active(row: typeof change.$inferSelect, scope: Scope) {
  return row.project_id === scope.projectID && row.directory === scope.directory && row.parent_id === null && row.time_archived === null
}

function title(row: typeof change.$inferSelect): Title {
  return {
    id: row.session_id,
    slug: row.slug!,
    title: row.title!,
    directory: row.directory!,
    projectID: row.project_id!,
    version: row.version!,
    time: { created: row.time_created!, updated: row.time_updated! },
  }
}

export function snapshot(scope: Scope, input: { cursor?: number; afterUpdated?: number; afterID?: SessionID; limit: number }) {
  return Database.transaction((db) => {
    const position = db.select().from(state).get()!
    const cursor = input.cursor ?? position.seq
    if (cursor < position.floor) return "expired" as const
    if (cursor > position.seq) return "invalid" as const
    const history = and(
      eq(change.project_id, scope.projectID),
      eq(change.directory, scope.directory),
      isNull(change.parent_id),
      isNull(change.time_archived),
      lte(change.seq, cursor),
      sql`NOT EXISTS (SELECT 1 FROM session_sidebar_change newer WHERE newer.session_id = ${change.session_id} AND newer.seq > ${change.seq} AND newer.seq <= ${cursor})`,
    )
    const checkpoint = and(
      eq(base.project_id, scope.projectID),
      eq(base.directory, scope.directory),
      sql`NOT EXISTS (SELECT 1 FROM session_sidebar_change newer WHERE newer.session_id = ${base.session_id} AND newer.seq <= ${cursor})`,
    )
    const total = db.select({ count: sql<number>`count(*)` }).from(change).where(history).get()!.count +
      db.select({ count: sql<number>`count(*)` }).from(base).where(checkpoint).get()!.count
    const rows = db.select().from(change).where(and(history,
      input.afterUpdated !== undefined ? or(
        lt(change.time_updated, input.afterUpdated),
        and(eq(change.time_updated, input.afterUpdated), lt(change.session_id, input.afterID!)),
      ) : undefined,
    )).orderBy(desc(change.time_updated), desc(change.session_id)).limit(input.limit + 1).all().map(title)
    const baseline = db.select().from(base).where(and(checkpoint,
      input.afterUpdated !== undefined ? or(
        lt(base.time_updated, input.afterUpdated),
        and(eq(base.time_updated, input.afterUpdated), lt(base.session_id, input.afterID!)),
      ) : undefined,
    )).orderBy(desc(base.time_updated), desc(base.session_id)).limit(input.limit + 1).all().map((row) => ({
      id: row.session_id,
      slug: row.slug,
      title: row.title,
      directory: row.directory,
      projectID: row.project_id,
      version: row.version,
      time: { created: row.time_created, updated: row.time_updated },
    }))
    const items = [...rows, ...baseline].sort((a, b) => b.time.updated - a.time.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const last = items[input.limit - 1]
    return {
      cursor,
      total,
      items: items.slice(0, input.limit),
      next: items.length > input.limit ? { updated: last!.time.updated, id: last!.id } : null,
    }
  })
}

export function changes(scope: Scope, input: { cursor: number; limit: number }) {
  return Database.transaction((db) => {
    const position = db.select().from(state).get()!
    if (input.cursor < position.floor) return "expired" as const
    if (input.cursor > position.seq) return "invalid" as const
    const rows = db.select().from(change).where(and(
      gt(change.seq, input.cursor),
      or(
        and(eq(change.project_id, scope.projectID), eq(change.directory, scope.directory)),
        and(eq(change.old_project_id, scope.projectID), eq(change.old_directory, scope.directory)),
      ),
    )).orderBy(asc(change.seq)).limit(input.limit + 1).all()
    const page = rows.slice(0, input.limit)
    return {
      cursor: rows.length > input.limit ? page.at(-1)!.seq : position.seq,
      total: db.select({ total: count.total }).from(count).where(and(
        eq(count.project_id, scope.projectID), eq(count.directory, scope.directory),
      )).get()?.total ?? 0,
      changes: page.filter((row) => active(row, scope) || (row.old_parent_id === null && row.old_time_archived === null && row.old_project_id === scope.projectID && row.old_directory === scope.directory)).map((row) =>
        active(row, scope)
          ? { seq: row.seq, type: "upsert" as const, session: title(row) }
          : { seq: row.seq, type: "remove" as const, id: row.session_id },
      ),
      more: rows.length > input.limit,
    }
  })
}

export * as SessionSidebarFeed from "./sidebar-feed"
