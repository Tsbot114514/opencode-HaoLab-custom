import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import { Option, Schema } from "effect"
import { Database } from "@/storage/db"
import { ProjectID } from "@/project/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { MessageID, PartID, SessionID } from "./schema"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTranscript } from "./transcript"
import {
  MessageTable,
  PartTable,
  SessionTable,
  SessionTranscriptChangeTable as change,
  SessionTranscriptMetaTable as meta,
  SessionTranscriptStateTable as state,
} from "./session.sql"

export type Scope = { projectID: ProjectID; directory: string; sessionID: SessionID; workspaceID?: WorkspaceID }
export type Change =
  | { seq: number; type: "message.upsert"; info: typeof MessageV2.Info.Type }
  | { seq: number; type: "part.upsert"; info: typeof MessageV2.Info.Type; part: typeof MessageV2.Part.Type }
  | { seq: number; type: "message.remove"; sessionID: SessionID; messageID: MessageID }
  | { seq: number; type: "part.remove"; sessionID: SessionID; messageID: MessageID; partID: PartID }

const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  epoch: Schema.String,
  generation: Schema.String,
  projectID: ProjectID,
  directory: Schema.String,
  workspaceID: Schema.NullOr(WorkspaceID),
  sessionID: SessionID,
  position: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))
const info = Schema.decodeUnknownSync(MessageV2.Info)
const part = Schema.decodeUnknownSync(MessageV2.Part)

export const rawLimit = 2048
export const byteTarget = 256 * 1024

export function reset(scope: Scope) {
  return Database.transaction(
    (db) => {
      if (!scopedSession(db, scope)) return false
      db.update(state)
        .set({ generation: sql`lower(hex(randomblob(16)))` })
        .where(eq(state.session_id, scope.sessionID))
        .run()
      db.run(sql`INSERT INTO session_transcript_change (session_id,generation,kind)
      SELECT session_id,generation,'session' FROM session_transcript_state WHERE session_id=${scope.sessionID}`)
      return true
    },
    { behavior: "immediate" },
  )
}

export function snapshot(scope: Scope, input: { limit: number }) {
  return Database.transaction((db) => {
    const session = scopedSession(db, scope)
    if (!session) return { error: "not-found" as const }
    const position = requirePosition(db, scope)
    const rows = db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, scope.sessionID))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all()
    const selected = rows.slice(0, input.limit)
    const parts = selected.length
      ? db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, scope.sessionID),
              inArray(
                PartTable.message_id,
                selected.map((row) => row.id),
              ),
            ),
          )
          .orderBy(asc(PartTable.id))
          .all()
      : []
    const tail = selected.at(-1)
    return {
      session: Session.fromRow(session),
      items: selected.reverse().map((row) => ({
        info: info({ ...row.data, id: row.id, sessionID: row.session_id }),
        parts: parts
          .filter((item) => item.message_id === row.id)
          .map((item) => part({ ...item.data, id: item.id, messageID: item.message_id, sessionID: item.session_id })),
      })),
      cursor: encode(scope, position, position.seq),
      generation: SessionTranscript.generation(position),
      version: position.seq,
      next:
        rows.length > input.limit && tail ? MessageV2.cursor.encode({ id: tail.id, time: tail.time_created }) : null,
    }
  })
}

export function changes(scope: Scope, input: { cursor: string; limit: number }) {
  return Database.transaction((db) => {
    if (input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) return { error: "invalid" as const }
    const parsed = decode(Buffer.from(input.cursor, "base64url").toString("utf8"))
    if (Option.isNone(parsed)) return { error: "invalid" as const }
    const cursor = parsed.value
    if (
      cursor.projectID !== scope.projectID ||
      cursor.directory !== scope.directory ||
      cursor.sessionID !== scope.sessionID ||
      cursor.workspaceID !== (scope.workspaceID ?? null)
    )
      return { error: "invalid" as const }
    const session = scopedSession(db, scope)
    if (!session) return { error: "not-found" as const }
    const position = requirePosition(db, scope)
    if (cursor.epoch !== position.epoch) return { error: "expired" as const, reason: "database-reset" as const }
    if (cursor.generation !== position.generation)
      return { error: "expired" as const, reason: "session-reset" as const }
    if (cursor.position > position.seq) return { error: "invalid" as const }
    if (cursor.position < position.floor) return { error: "expired" as const, reason: "retention" as const }
    const rows = db
      .select()
      .from(change)
      .where(
        and(
          eq(change.session_id, scope.sessionID),
          eq(change.generation, position.generation),
          gt(change.seq, cursor.position),
          lte(change.seq, position.seq),
        ),
      )
      .orderBy(asc(change.seq))
      .limit(rawLimit + 1)
      .all()
    const groups = new Map<string, typeof change.$inferSelect>()
    rows.slice(0, rawLimit).forEach((row) => groups.set(JSON.stringify([row.kind, row.message_id, row.part_id]), row))
    const ordered = [...groups.values()].sort((a, b) => a.seq - b.seq)
    const result: Change[] = []
    let metadata: Session.Info | undefined
    let bytes = 512
    let consumed = cursor.position
    let stopped = false
    for (const row of ordered) {
      const entity = hydrate(db, scope, position.generation, row)
      const size = Buffer.byteLength(JSON.stringify(entity ?? Session.fromRow(session)))
      // Whole entities cannot be truncated. One oversized group is allowed so
      // large tool output never makes this cursor permanently unpageable.
      if (consumed !== cursor.position && ((entity && result.length >= input.limit) || bytes + size > byteTarget)) {
        stopped = true
        break
      }
      if (entity) result.push(entity)
      if (!entity) metadata = Session.fromRow(session)
      bytes += size
      consumed = row.seq
    }
    const more = stopped || rows.length > rawLimit
    const next = more ? consumed : position.seq
    return {
      cursor: encode(scope, position, next),
      highwater: encode(scope, position, position.seq),
      generation: SessionTranscript.generation(position),
      more,
      changes: result,
      ...(metadata ? { session: metadata } : {}),
    }
  })
}

function scopedSession(db: Database.TxOrDb, scope: Scope) {
  return db
    .select()
    .from(SessionTable)
    .where(
      and(
        eq(SessionTable.id, scope.sessionID),
        eq(SessionTable.project_id, scope.projectID),
        eq(SessionTable.directory, scope.directory),
        scope.workspaceID ? eq(SessionTable.workspace_id, scope.workspaceID) : isNull(SessionTable.workspace_id),
      ),
    )
    .get()
}

function requirePosition(db: Database.TxOrDb, scope: Scope) {
  const head = db.select().from(meta).where(eq(meta.id, 1)).get()
  const session = db.select().from(state).where(eq(state.session_id, scope.sessionID)).get()
  if (!head || !session) throw new Error("Transcript cursor metadata missing")
  return { ...head, generation: session.generation }
}

function encode(scope: Scope, position: { epoch: string; generation: string }, seq: number) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      epoch: position.epoch,
      generation: position.generation,
      projectID: scope.projectID,
      directory: scope.directory,
      workspaceID: scope.workspaceID ?? null,
      sessionID: scope.sessionID,
      position: seq,
    }),
  ).toString("base64url")
}

function hydrate(
  db: Database.TxOrDb,
  scope: Scope,
  generation: string,
  row: typeof change.$inferSelect,
): Change | undefined {
  if (row.kind === "session") return
  if (!row.message_id) throw new Error("Transcript message ID missing")
  const latest =
    db
      .select({ seq: sql<number>`max(${change.seq})` })
      .from(change)
      .where(
        and(
          eq(change.session_id, scope.sessionID),
          eq(change.generation, generation),
          eq(change.kind, row.kind),
          eq(change.message_id, row.message_id),
          row.part_id ? eq(change.part_id, row.part_id) : isNull(change.part_id),
        ),
      )
      .get()?.seq ?? row.seq
  const message = db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, row.message_id), eq(MessageTable.session_id, scope.sessionID)))
    .get()
  if (row.kind === "message") {
    if (!message) return { seq: latest, type: "message.remove", sessionID: scope.sessionID, messageID: row.message_id }
    return {
      seq: latest,
      type: "message.upsert",
      info: info({ ...message.data, id: message.id, sessionID: message.session_id }),
    }
  }
  if (!row.part_id) throw new Error("Transcript part ID missing")
  const current = db
    .select()
    .from(PartTable)
    .where(
      and(
        eq(PartTable.id, row.part_id),
        eq(PartTable.message_id, row.message_id),
        eq(PartTable.session_id, scope.sessionID),
      ),
    )
    .get()
  if (!message || !current)
    return {
      seq: latest,
      type: "part.remove",
      sessionID: scope.sessionID,
      messageID: row.message_id,
      partID: row.part_id,
    }
  // The part and its owner form one replacement group; its version includes
  // owner changes that may already be newer than this raw journal window.
  const owner =
    db
      .select({ seq: sql<number>`max(${change.seq})` })
      .from(change)
      .where(
        and(
          eq(change.session_id, scope.sessionID),
          eq(change.generation, generation),
          eq(change.kind, "message"),
          eq(change.message_id, row.message_id),
        ),
      )
      .get()?.seq ?? 0
  return {
    seq: Math.max(latest, owner),
    type: "part.upsert",
    info: info({ ...message.data, id: message.id, sessionID: message.session_id }),
    part: part({ ...current.data, id: current.id, messageID: current.message_id, sessionID: current.session_id }),
  }
}

export * as SessionTranscriptFeed from "./transcript-feed"
