import { sqliteTable, text, integer, index, primaryKey, real, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "@opencode-ai/core/session-message"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import { Timestamps } from "../storage/schema.sql"

type PartData<T extends MessageV2.Part = MessageV2.Part> = T extends unknown
  ? Omit<T, "id" | "sessionID" | "messageID">
  : never
type InfoData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown ? Omit<T, "id" | "sessionID"> : never
type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const SessionSidebarChangeTable = sqliteTable(
  "session_sidebar_change",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    session_id: text().$type<SessionID>().notNull(),
    old_project_id: text().$type<ProjectID>(),
    old_directory: text(),
    old_parent_id: text(),
    old_time_archived: integer(),
    project_id: text().$type<ProjectID>(),
    directory: text(),
    parent_id: text(),
    time_archived: integer(),
    title: text(),
    slug: text(),
    version: text(),
    time_created: integer(),
    time_updated: integer(),
  },
  (table) => [
    index("session_sidebar_change_session_seq_idx").on(table.session_id, table.seq),
    index("session_sidebar_change_project_directory_seq_idx").on(table.project_id, table.directory, table.seq),
    index("session_sidebar_change_old_project_directory_seq_idx").on(
      table.old_project_id,
      table.old_directory,
      table.seq,
    ),
  ],
)

export const SessionSidebarStateTable = sqliteTable("session_sidebar_state", {
  id: integer().primaryKey(),
  seq: integer().notNull(),
  floor: integer().notNull(),
})

export const SessionSidebarCountTable = sqliteTable(
  "session_sidebar_count",
  {
    project_id: text().$type<ProjectID>().notNull(),
    directory: text().notNull(),
    total: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.directory] }),
    check("session_sidebar_count_nonnegative", sql`${table.total} >= 0`),
  ],
)

export const SessionSidebarBaseTable = sqliteTable(
  "session_sidebar_base",
  {
    session_id: text().$type<SessionID>().primaryKey(),
    project_id: text().$type<ProjectID>().notNull(),
    directory: text().notNull(),
    title: text().notNull(),
    slug: text().notNull(),
    version: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("session_sidebar_base_project_directory_id_idx").on(table.project_id, table.directory, table.session_id),
    index("session_sidebar_base_project_directory_updated_id_idx").on(
      table.project_id,
      table.directory,
      table.time_updated,
      table.session_id,
    ),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const SessionTranscriptMetaTable = sqliteTable("session_transcript_meta", {
  id: integer().primaryKey(),
  epoch: text().notNull(),
  seq: integer().notNull(),
  floor: integer().notNull(),
})

// No foreign keys: deletion tombstones must outlive their source entities.
export const SessionTranscriptStateTable = sqliteTable("session_transcript_state", {
  session_id: text().$type<SessionID>().primaryKey(),
  project_id: text().$type<ProjectID>().notNull(),
  directory: text().notNull(),
  workspace_id: text().$type<WorkspaceID>(),
  generation: text().notNull(),
  deleted: integer().notNull().default(0),
})

export const SessionTranscriptChangeTable = sqliteTable(
  "session_transcript_change",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    session_id: text().$type<SessionID>().notNull(),
    generation: text().notNull(),
    kind: text().$type<"session" | "message" | "part">().notNull(),
    message_id: text().$type<MessageID>(),
    part_id: text().$type<PartID>(),
  },
  (table) => [
    index("session_transcript_change_session_generation_seq_idx").on(table.session_id, table.generation, table.seq),
    index("session_transcript_change_entity_seq_idx").on(
      table.session_id,
      table.generation,
      table.kind,
      table.message_id,
      table.part_id,
      table.seq,
    ),
  ],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    index("session_message_session_idx").on(table.session_id),
    index("session_message_session_type_idx").on(table.session_id, table.type),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})
