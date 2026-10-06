# Transcript Feed

`session.transcriptSnapshot` reads `GET /session/{sessionID}/transcript/snapshot`
with optional `directory`, `workspace`, and `limit` (default 20, maximum 100).
It returns `{ session, status, items, cursor, generation, version, next }`. Messages, parts,
session metadata, and the cursor/version share a SQLite read transaction. Status
is sampled separately from the in-memory status service. Items are chronological;
`next` is an older-history `before` cursor for `session.messages`, not a change
cursor. Older history remains demand-paged.

`session.transcriptChanges` reads `GET /session/{sessionID}/transcript/changes`
with the same routing fields, a required opaque `cursor`, and optional `limit`
(default 100, maximum 200). It returns `{ cursor, highwater, generation, more, changes,
session?, status }`. A session metadata marker adds `session`. Status is sampled
separately on each response.

Changes have a numeric `seq` and one of these shapes:

- `{ type: "message.upsert", info }`: replace info, preserving existing parts.
- `{ type: "part.upsert", info, part }`: replace only this part; info identifies
  its owning message. Unchanged sibling parts are never returned.
- `{ type: "message.remove", sessionID, messageID }`: remove the message and all
  cached parts.
- `{ type: "part.remove", sessionID, messageID, partID }`: remove only this key.

`seq` is the most recent retained revision of the current entity replacement
group. A part-upsert group includes the owner's message revision. It can exceed
the consumed raw prefix when hydration sees newer mutations. Clients must apply
responses in request order, guard entity replacements by sequence, and persist
changes plus the returned cursor atomically. Snapshot `version` is the watermark
for every entity in that snapshot. Never derive a cursor from entity sequences.
Do not advance to `highwater`; it is informational. Request the returned cursor
immediately while `more` is true. Repeated current-state replacements are normal.
The feed includes mutations to old messages outside the latest snapshot window;
it never scans message history to discover changes.

Both responses require `generation`, an opaque database-epoch/session-generation
token bounded to 256 characters. Compare it for equality only; it is neither a
cursor nor authorization. It remains stable across pages and changes whenever
the database incarnation or session generation changes.

All five live message/part mutation events (`message.updated`, `message.removed`,
`message.part.updated`, `message.part.removed`, `message.part.delta`) optionally
include `properties.transcript: { generation, seq }`. A stamped event refers to
its own committed mutation, not the head at delivery time. Projectors capture
stamps transactionally, and queued sync payloads are cloned before projection so
later mutations cannot change an earlier event's payload. Incoming/replayed
stamps are discarded and replaced only when a local mutation produces a matching
journal record. Rejected/no-op writes and externally published bus events do not
invent stamps. The optional field preserves compatibility with existing event
producers and consumers, including older servers.

Delta publication also uses the database's after-commit queue, sharing its FIFO
with full-part sync events. Nested transactions enqueue into the enclosing
transaction; an outer rollback discards their events as well as their journal
entries. Delta payloads and stamps are captured before enqueueing, never reread
from the later committed head. No full-part sync-event payload is stored per token.

When using this feed, clients must only apply a stamped live mutation if its
generation matches the current feed generation and its sequence is newer than
the relevant entity watermark. Snapshot `version` initializes those watermarks.
A late delta already represented by an HTTP replacement must not be appended a
second time, and a late full upsert must not roll back newer state. Unstamped
events cannot safely mutate checkpointed feed state; treat them as recovery hints.
Live event sequences never acknowledge or advance a transcript cursor.

Journal entries contain IDs, scope-generation references, and mutation kinds,
not entity payloads. SQL triggers capture regular writes, raw SQL imports,
restore, removals, and cascades. Streaming text/reasoning deltas update the stored
part before the existing live bus delta is published; they do not append full
part payloads to the sync-event log. Final full-part updates remain authoritative.

Each request scans at most 2,048 raw journal entries and coalesces their entity
keys. Only a consumed prefix is acknowledged. Responses target 256 KiB of UTF-8
JSON, with one oversized whole entity group allowed to guarantee progress.
This is a soft target, not a hard payload cap; output is never silently truncated.
The journal retains at most 65,536 entries globally. Old cursors can therefore
expire sooner when unrelated sessions generate substantial traffic.

Cursors bind database epoch, session generation, session, project, directory,
and workspace. Opening a database rotates its epoch, deliberately invalidating
pre-restart cursors, including after database-file rollback. Restarting only the
client does not rotate this epoch. Recreated/restored sessions and session scope
changes receive fresh generations. Portable backups exclude destination journals
and cursor metadata; restore's transactional delete/reinsert initializes fresh
destination generations. A reset retaining the session row must call the
transactional `SessionTranscriptFeed.reset` operation.

Malformed/cross-scope/future cursors return 400. Expired cursors return 410 with
`{ _tag: "TranscriptCursorExpiredError", message, reason }`, where reason is
`retention`, `session-reset`, or `database-reset`. Discard the old transcript
generation and replace it from a fresh snapshot. A supported session-not-found
404 uses `{ name: "NotFoundError", data: { message } }` and requires clearing the
session's in-memory and persisted transcript/parts/cursor. Snapshot and changes
responses, including domain errors, carry `X-Opencode-Transcript-Feed: 1` exposed
to cross-origin clients. A route-not-supported response lacks that marker; older
server fallback must not interpret an unmarked route 404 as session deletion.

Authentication and routing use the existing session-group middleware. Cursors
are not credentials or authorization. The server verifies exact session scope
inside each read transaction before returning entity data.
