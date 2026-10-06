import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { ProjectID } from "@/project/schema"
import { MessageV2 } from "@/session/message-v2"
import { SessionTranscript } from "@/session/transcript"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError, InvalidCursorError, SessionBusyError } from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const ReconcilePayload = Schema.Struct({
  known: Schema.Array(
    Schema.Struct({
      id: SessionID,
      title: Schema.String,
      updated: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ).check(Schema.isMaxLength(200)),
  limit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
})
export const ReconcileResult = Schema.Struct({
  upserts: Schema.Array(Session.Info),
  removed: Schema.Array(SessionID),
  limit: ReconcilePayload.fields.limit,
  limited: Schema.Boolean,
})
export const SidebarTitle = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  projectID: ProjectID,
  version: Schema.String,
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export class SidebarCursorExpiredError extends Schema.ErrorClass<SidebarCursorExpiredError>(
  "SidebarCursorExpiredError",
)({ message: Schema.String }, { httpApiStatus: 410 }) {}
export const SidebarSnapshotQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  afterUpdated: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  afterID: Schema.optional(SessionID),
  limit: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(200),
  ),
})
export const SidebarChangesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  limit: SidebarSnapshotQuery.fields.limit,
})
export const SidebarSnapshotResult = Schema.Struct({
  cursor: Schema.Number,
  total: Schema.Number,
  items: Schema.Array(SidebarTitle),
  next: Schema.NullOr(Schema.Struct({ updated: Schema.Number, id: SessionID })),
})
export const SidebarChangesResult = Schema.Struct({
  cursor: Schema.Number,
  total: Schema.Number,
  changes: Schema.Array(
    Schema.Union([
      Schema.Struct({ seq: Schema.Number, type: Schema.Literal("upsert"), session: SidebarTitle }),
      Schema.Struct({ seq: Schema.Number, type: Schema.Literal("remove"), id: SessionID }),
    ]),
  ),
  more: Schema.Boolean,
})
export class TranscriptCursorExpiredError extends Schema.TaggedErrorClass<TranscriptCursorExpiredError>()(
  "TranscriptCursorExpiredError",
  {
    message: Schema.String,
    reason: Schema.Literals(["retention", "session-reset", "database-reset"]),
  },
  { httpApiStatus: 410 },
) {}
const TranscriptLimit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(200),
)
export const TranscriptSnapshotQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})
export const TranscriptChangesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  limit: Schema.optional(TranscriptLimit),
})
export const TranscriptSnapshotResult = Schema.Struct({
  session: Session.Info,
  status: SessionStatus.Info,
  items: Schema.Array(MessageV2.WithParts),
  cursor: Schema.String,
  generation: SessionTranscript.Generation,
  version: Schema.Number,
  next: Schema.NullOr(Schema.String),
})
export const TranscriptChangesResult = Schema.Struct({
  cursor: Schema.String,
  highwater: Schema.String,
  generation: SessionTranscript.Generation,
  more: Schema.Boolean,
  changes: Schema.Array(
    Schema.Union([
      Schema.Struct({ seq: Schema.Number, type: Schema.Literal("message.upsert"), info: MessageV2.Info }),
      Schema.Struct({
        seq: Schema.Number,
        type: Schema.Literal("part.upsert"),
        info: MessageV2.Info,
        part: MessageV2.Part,
      }),
      Schema.Struct({
        seq: Schema.Number,
        type: Schema.Literal("message.remove"),
        sessionID: SessionID,
        messageID: MessageID,
      }),
      Schema.Struct({
        seq: Schema.Number,
        type: Schema.Literal("part.remove"),
        sessionID: SessionID,
        messageID: MessageID,
        partID: PartID,
      }),
    ]),
  ),
  session: Schema.optional(Session.Info),
  status: SessionStatus.Info,
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  permission: Schema.optional(Permission.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelID,
  providerID: ProviderID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: Permission.Reply,
})

export const SessionPaths = {
  list: root,
  reconcile: `${root}/sidebar/reconcile`,
  sidebarSnapshot: `${root}/sidebar/snapshot`,
  sidebarChanges: `${root}/sidebar/changes`,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  transcriptSnapshot: `${root}/:sessionID/transcript/snapshot`,
  transcriptChanges: `${root}/:sessionID/transcript/changes`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.post("reconcile", SessionPaths.reconcile, {
          query: WorkspaceRoutingQuery,
          payload: ReconcilePayload,
          success: described(ReconcileResult, "Session sidebar changes"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.reconcile",
            summary: "Reconcile session sidebar",
            description:
              "Compare bounded root session summaries with the current directory, including known sessions outside the newest window. Return new or changed sessions and IDs that were deleted or archived.",
          }),
        ),
        HttpApiEndpoint.get("sidebarSnapshot", SessionPaths.sidebarSnapshot, {
          query: SidebarSnapshotQuery,
          success: described(SidebarSnapshotResult, "Session sidebar snapshot page"),
          error: [HttpApiError.BadRequest, SidebarCursorExpiredError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.sidebarSnapshot", summary: "Page session sidebar snapshot" }),
        ),
        HttpApiEndpoint.get("sidebarChanges", SessionPaths.sidebarChanges, {
          query: SidebarChangesQuery,
          success: described(SidebarChangesResult, "Session sidebar changes page"),
          error: [HttpApiError.BadRequest, SidebarCursorExpiredError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.sidebarChanges", summary: "Page session sidebar changes" }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(MessageV2.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("transcriptSnapshot", SessionPaths.transcriptSnapshot, {
          params: { sessionID: SessionID },
          query: TranscriptSnapshotQuery,
          success: described(TranscriptSnapshotResult, "Atomic latest transcript snapshot and cursor"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.transcriptSnapshot",
            summary: "Snapshot session transcript",
            description:
              "Read the latest 20 messages by default, session metadata and an opaque change cursor in one database transaction. generation identifies the database/session incarnation; version initializes entity watermarks. Deduplicate live events using properties.transcript.generation and seq; unstamped events are recovery hints, not checkpointable mutations. Status is sampled separately. next is a history cursor for session.messages. Database restarts invalidate change cursors. Responses include X-Opencode-Transcript-Feed: 1, including a session-not-found error, to distinguish unsupported routes.",
          }),
        ),
        HttpApiEndpoint.get("transcriptChanges", SessionPaths.transcriptChanges, {
          params: { sessionID: SessionID },
          query: TranscriptChangesQuery,
          success: described(TranscriptChangesResult, "Coalesced current transcript entity changes"),
          error: [HttpApiError.BadRequest, InvalidCursorError, ApiNotFoundError, TranscriptCursorExpiredError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.transcriptChanges",
            summary: "Page session transcript changes",
            description:
              "Page durable message and part mutations without scanning message history. Apply changes and cursor atomically. generation identifies the database/session incarnation and must match live properties.transcript.generation before applying a newer seq. Upserts replace only the named entity, never unchanged sibling parts. seq versions the current replacement group, possibly newer than the consumed raw prefix. highwater is informational; never skip to it or advance a cursor from live event sequences. Pages target 256 KiB and permit one oversized whole entity group for progress. 410 requires a fresh snapshot; a supported-route 404 requires clearing the cached transcript. Status is sampled separately.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(MessageV2.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: Schema.optional(ForkPayload),
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Prompt accepted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: MessageV2.Part,
          success: described(MessageV2.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
