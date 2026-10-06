import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { Schema } from "effect"
import type { Database } from "@/storage/db"
import type { MessageID, PartID, SessionID } from "./schema"
import {
  SessionTranscriptChangeTable as change,
  SessionTranscriptMetaTable as meta,
  SessionTranscriptStateTable as state,
} from "./session.sql"

export const Generation = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const Stamp = Schema.Struct({
  generation: Generation,
  seq: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
})

export function generation(position: { epoch: string; generation: string }) {
  return `${position.epoch}:${position.generation}`
}

export function head(db: Database.TxOrDb) {
  return db.select({ seq: meta.seq }).from(meta).where(eq(meta.id, 1)).get()?.seq
}

// Call in the same write transaction, immediately after the named mutation.
// A no-op or rejected write must not borrow a previous entity's revision.
export function stamp(
  db: Database.TxOrDb,
  input: {
    sessionID: SessionID
    messageID: MessageID
    partID?: PartID
  },
  after: number | undefined,
) {
  if (after === undefined) return
  const row = db
    .select({ seq: change.seq, epoch: meta.epoch, generation: state.generation })
    .from(change)
    .innerJoin(state, and(eq(state.session_id, change.session_id), eq(state.generation, change.generation)))
    .innerJoin(meta, eq(meta.id, 1))
    .where(
      and(
        eq(change.session_id, input.sessionID),
        eq(change.kind, input.partID ? "part" : "message"),
        eq(change.message_id, input.messageID),
        input.partID ? eq(change.part_id, input.partID) : isNull(change.part_id),
        gt(change.seq, after),
      ),
    )
    .orderBy(desc(change.seq))
    .get()
  if (!row) return
  return Schema.decodeUnknownSync(Stamp)({ generation: generation(row), seq: row.seq })
}

export * as SessionTranscript from "./transcript"
