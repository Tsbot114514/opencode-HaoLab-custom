import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export const transcriptRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const string = (value: unknown): value is string => typeof value === "string"
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value >= 0
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const boolean = (value: unknown) => typeof value === "boolean"
const strings = (value: unknown) => transcriptRecord(value) && Object.values(value).every(string)
const model = (value: unknown) =>
  transcriptRecord(value) && string(value.providerID) && string(value.modelID) && optional(value.variant, string)
const time = (value: unknown, end = false) =>
  transcriptRecord(value) &&
  integer(value.start) &&
  (end ? integer(value.end) : optional(value.end, integer)) &&
  optional(value.compacted, integer)

function tokens(value: unknown) {
  return (
    transcriptRecord(value) &&
    optional(value.total, number) &&
    number(value.input) &&
    number(value.output) &&
    number(value.reasoning) &&
    transcriptRecord(value.cache) &&
    number(value.cache.read) &&
    number(value.cache.write)
  )
}

function error(value: unknown) {
  if (!transcriptRecord(value) || !transcriptRecord(value.data)) return false
  if (value.name === "MessageOutputLengthError") return true
  if (!string(value.data.message)) return false
  switch (value.name) {
    case "ProviderAuthError":
      return string(value.data.providerID)
    case "UnknownError":
      return optional(value.data.ref, string)
    case "MessageAbortedError":
      return true
    case "StructuredOutputError":
      return number(value.data.retries)
    case "ContextOverflowError":
      return optional(value.data.responseBody, string)
    case "APIError":
      return (
        boolean(value.data.isRetryable) &&
        optional(value.data.statusCode, number) &&
        optional(value.data.responseBody, string) &&
        optional(value.data.responseHeaders, strings) &&
        optional(value.data.metadata, strings)
      )
    default:
      return false
  }
}

export function validTranscriptMessage(value: unknown): value is Message {
  if (
    !transcriptRecord(value) ||
    !string(value.id) ||
    !/^[\w-]+$/.test(value.id) ||
    !string(value.sessionID) ||
    !value.sessionID ||
    !transcriptRecord(value.time) ||
    !integer(value.time.created) ||
    !string(value.agent)
  )
    return false
  if (value.role === "user") {
    if (
      !model(value.model) ||
      !optional(value.system, string) ||
      !optional(value.tools, (tools) => transcriptRecord(tools) && Object.values(tools).every(boolean))
    )
      return false
    if (
      value.format !== undefined &&
      (!transcriptRecord(value.format) ||
        (value.format.type !== "text" &&
          (value.format.type !== "json_schema" ||
            !transcriptRecord(value.format.schema) ||
            !optional(value.format.retryCount, integer))))
    )
      return false
    if (
      value.summary !== undefined &&
      (!transcriptRecord(value.summary) ||
        !optional(value.summary.title, string) ||
        !optional(value.summary.body, string) ||
        !Array.isArray(value.summary.diffs) ||
        !value.summary.diffs.every(
          (diff) =>
            transcriptRecord(diff) &&
            optional(diff.file, string) &&
            optional(diff.patch, string) &&
            number(diff.additions) &&
            number(diff.deletions) &&
            optional(diff.status, (status) => ["added", "deleted", "modified"].includes(String(status))),
        ))
    )
      return false
    return true
  }
  return (
    value.role === "assistant" &&
    string(value.parentID) &&
    string(value.modelID) &&
    string(value.providerID) &&
    string(value.mode) &&
    transcriptRecord(value.path) &&
    string(value.path.cwd) &&
    string(value.path.root) &&
    number(value.cost) &&
    tokens(value.tokens) &&
    optional(value.time.completed, integer) &&
    optional(value.error, error) &&
    optional(value.summary, boolean) &&
    optional(value.variant, string) &&
    optional(value.finish, string)
  )
}

function sourceText(value: unknown) {
  return transcriptRecord(value) && string(value.value) && number(value.start) && number(value.end)
}

function fileSource(value: unknown) {
  if (!transcriptRecord(value) || !sourceText(value.text)) return false
  if (value.type === "resource") return string(value.clientName) && string(value.uri)
  if (!string(value.path)) return false
  if (value.type === "file") return true
  return (
    value.type === "symbol" &&
    string(value.name) &&
    integer(value.kind) &&
    transcriptRecord(value.range) &&
    [value.range.start, value.range.end].every(
      (point) => transcriptRecord(point) && integer(point.line) && integer(point.character),
    )
  )
}

export function validTranscriptPart(value: unknown): value is Part {
  if (
    !transcriptRecord(value) ||
    !string(value.id) ||
    !value.id ||
    !string(value.sessionID) ||
    !value.sessionID ||
    !string(value.messageID) ||
    !value.messageID ||
    !optional(value.metadata, transcriptRecord)
  )
    return false
  switch (value.type) {
    case "text":
      return (
        string(value.text) &&
        optional(value.synthetic, boolean) &&
        optional(value.ignored, boolean) &&
        optional(value.time, time)
      )
    case "reasoning":
      return string(value.text) && time(value.time)
    case "file":
      return (
        string(value.mime) &&
        string(value.url) &&
        optional(value.filename, string) &&
        optional(value.source, fileSource)
      )
    case "tool": {
      if (
        !string(value.tool) ||
        !string(value.callID) ||
        !transcriptRecord(value.state) ||
        !transcriptRecord(value.state.input)
      )
        return false
      const state = value.state
      if (state.status === "pending") return string(state.raw)
      if (!optional(state.metadata, transcriptRecord)) return false
      if (state.status === "running") return optional(state.title, string) && time(state.time)
      if (!time(state.time, true)) return false
      if (state.status === "error") return string(state.error)
      return (
        state.status === "completed" &&
        string(state.output) &&
        string(state.title) &&
        transcriptRecord(state.metadata) &&
        optional(
          state.attachments,
          (attachments) =>
            Array.isArray(attachments) &&
            attachments.every((part) => transcriptRecord(part) && part.type === "file" && validTranscriptPart(part)),
        )
      )
    }
    case "step-start":
      return optional(value.snapshot, string)
    case "step-finish":
      return string(value.reason) && optional(value.snapshot, string) && number(value.cost) && tokens(value.tokens)
    case "snapshot":
      return string(value.snapshot)
    case "patch":
      return string(value.hash) && Array.isArray(value.files) && value.files.every(string)
    case "agent":
      return (
        string(value.name) &&
        optional(
          value.source,
          (source) => sourceText(source) && transcriptRecord(source) && integer(source.start) && integer(source.end),
        )
      )
    case "subtask":
      return (
        string(value.prompt) &&
        string(value.description) &&
        string(value.agent) &&
        optional(value.model, model) &&
        optional(value.command, string)
      )
    case "retry":
      return (
        integer(value.attempt) &&
        transcriptRecord(value.error) &&
        value.error.name === "APIError" &&
        error(value.error) &&
        transcriptRecord(value.time) &&
        integer(value.time.created)
      )
    case "compaction":
      return (
        boolean(value.auto) &&
        optional(value.overflow, boolean) &&
        optional(value.tail_text_only, boolean) &&
        optional(value.tail_start_id, string) &&
        optional(value.tail_full_start_id, string)
      )
    default:
      return false
  }
}
