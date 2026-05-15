# assemble.ts Schema Reference

This file documents the input and return shape for the session-local assemble hook.
The hook runs before opencode converts internal messages into provider-specific model messages.

## Hook Signature

```ts
export default async function assemble(input) {
  return input.messages
}
```

`assemble(input)` may be sync or async. It must return `MessageV2.WithParts[]`.

## Input

```ts
type AssembleInput = {
  sessionID: string
  sessionDir: string
  workspaceRoot: string
  directory: string
  step: number
  messages: MessageV2.WithParts[]
  session: SessionInfo
  agent: { name: string }
  model: { id: string; providerID: string }
}
```

- `sessionID` is the current session id and starts with `ses`.
- `sessionDir` is the per-session data directory containing `assemble.ts` and this document.
- `workspaceRoot` is the project workspace root.
- `directory` is the current request directory.
- `step` is the current model step; `step === 1` is the first step for a user turn.
- `messages` is already filtered for compaction and includes opencode reminders inserted before assemble.

## Return Value

Return only this shape:

```ts
type WithParts = {
  info: UserInfo | AssistantInfo
  parts: Part[]
}
```

The returned value must be an array:

```ts
MessageV2.WithParts[]
```

Do not return provider messages:

```ts
// Invalid
return [{ role: "user", content: "hello" }]
```

Do not return strings, raw parts, or objects missing `{ info, parts }`.
If the return value is invalid, opencode ignores it, uses the original `input.messages`, and adds a temporary reminder telling the agent that `assemble.ts` is invalid.

## Default Discovery Behavior

The default template recursively reads JSON files under `input.sessionDir`.
It skips `llm-request/` so request payload logs are never injected by discovery.

Included files:

- `metadata.json` is always included as a synthetic `<session-metadata>` text message.
- Other JSON files are included only when they contain `"assemble": true` and a string `content` field.

Optional JSON fields:

- `position`: `"prefix"`, `"inline"`, or `"suffix"`; defaults to `"prefix"`.
- `timestamp` or `time`: numeric ordering timestamp for the synthetic message.
- `countdown`: when positive, content is included and decremented once per first step of a user turn; when `0`, `expired` is used instead if present.
- `expired`: optional replacement content for expired countdown files.

Recommended metadata for agent-managed files:

- `name`: stable human-readable id for this context file.
- `description`: what this context is for and when an agent should update it.
- `updated_at`: last update time, preferably epoch milliseconds or ISO string.
- `updated_by`: agent, user, or tool that last changed the file.
- `reason`: short explanation for the latest change.

Unknown fields are preserved by the default discovery behavior. Keeping metadata beside `content` makes it safer for future agents to decide whether to edit, replace, or delete a context file.

Only `content` is injected into the model context. Metadata fields such as `name`, `description`, `updated_at`, `updated_by`, and `reason` are for file maintenance only unless you also include them as text inside `content`.

Example agent-managed context file:

```json
{
  "assemble": true,
  "name": "session-goals",
  "description": "Persistent goals and constraints for this session. Update when the user changes priorities.",
  "updated_at": 1778817182731,
  "updated_by": "agent",
  "reason": "User asked the agent to manage session-local context.",
  "position": "prefix",
  "content": "Context file: session-goals
Description: Persistent goals and constraints for this session.
Last updated by: agent
Reason: User asked the agent to manage session-local context.

The user prefers concise implementation notes and wants session-local context managed with JSON files."
}
```

## IDs

IDs are strings with required prefixes:

```ts
type SessionID = string // starts with "ses"
type MessageID = string // starts with "msg"
type PartID = string    // starts with "prt"
```

When creating a synthetic message:

- `info.id` must start with `msg`.
- every `part.id` must start with `prt`.
- every `part.messageID` must equal the containing `info.id`.
- every `info.sessionID` and `part.sessionID` should normally equal `input.sessionID`.

## Message Info

`info` is a discriminated union. Use `info.role` to know which shape is valid.

### UserInfo

```ts
type UserInfo = {
  id: MessageID
  sessionID: SessionID
  role: "user"
  time: {
    created: number
  }
  agent: string
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
  format?:
    | { type: "text" }
    | { type: "json_schema"; schema: object; retryCount?: number }
  summary?: {
    title?: string
    body?: string
    diffs: unknown[]
  }
  system?: string
  tools?: Record<string, boolean>
}
```

### AssistantInfo

```ts
type AssistantInfo = {
  id: MessageID
  sessionID: SessionID
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID: MessageID
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  error?: unknown
  summary?: boolean
  structured?: unknown
  variant?: string
  finish?: string
}
```

## Parts

Every part has common IDs:

```ts
type PartBase = {
  id: PartID
  sessionID: SessionID
  messageID: MessageID
}
```

`Part` is one of the following `type` values:

- `text`
- `subtask`
- `reasoning`
- `file`
- `tool`
- `step-start`
- `step-finish`
- `snapshot`
- `patch`
- `agent`
- `retry`
- `compaction`

### TextPart

```ts
type TextPart = PartBase & {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}
```

Use `synthetic: true` for temporary context that was not directly typed by the user.

### ReasoningPart

```ts
type ReasoningPart = PartBase & {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time: {
    start: number
    end?: number
  }
}
```

### FilePart

```ts
type FilePart = PartBase & {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FileSource | SymbolSource | ResourceSource
}
```

```ts
type FileSource = {
  type: "file"
  path: string
  text: { value: string; start: number; end: number }
}

type SymbolSource = {
  type: "symbol"
  path: string
  range: unknown
  name: string
  kind: number
  text: { value: string; start: number; end: number }
}

type ResourceSource = {
  type: "resource"
  clientName: string
  uri: string
  text: { value: string; start: number; end: number }
}
```

### ToolPart

```ts
type ToolPart = PartBase & {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: Record<string, unknown>
}
```

```ts
type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
      attachments?: FilePart[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
```

### StepStartPart

```ts
type StepStartPart = PartBase & {
  type: "step-start"
  snapshot?: string
}
```

### StepFinishPart

```ts
type StepFinishPart = PartBase & {
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}
```

### SnapshotPart

```ts
type SnapshotPart = PartBase & {
  type: "snapshot"
  snapshot: string
}
```

### PatchPart

```ts
type PatchPart = PartBase & {
  type: "patch"
  hash: string
  files: string[]
}
```

### AgentPart

```ts
type AgentPart = PartBase & {
  type: "agent"
  name: string
  source?: {
    value: string
    start: number
    end: number
  }
}
```

### SubtaskPart

```ts
type SubtaskPart = PartBase & {
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: {
    providerID: string
    modelID: string
  }
  command?: string
}
```

### RetryPart

```ts
type RetryPart = PartBase & {
  type: "retry"
  attempt: number
  error: unknown
  time: {
    created: number
  }
}
```

### CompactionPart

```ts
type CompactionPart = PartBase & {
  type: "compaction"
  auto: boolean
  overflow?: boolean
  tail_start_id?: MessageID
}
```

## Minimal Synthetic Text Example

```ts
export default async function assemble(input) {
  const latest = [...input.messages].reverse().find((msg) => msg.info.role === "user")
  const created = Date.now()
  const id = "msg_assemble_" + created

  return [
    ...input.messages,
    {
      info: {
        id,
        sessionID: input.sessionID,
        role: "user",
        time: { created },
        agent: latest?.info.role === "user" ? latest.info.agent : input.agent.name,
        model:
          latest?.info.role === "user"
            ? latest.info.model
            : { providerID: input.model.providerID, modelID: input.model.id },
      },
      parts: [
        {
          id: "prt_assemble_" + created,
          sessionID: input.sessionID,
          messageID: id,
          type: "text",
          synthetic: true,
          text: "Temporary context for this request.",
        },
      ],
    },
  ]
}
```

## Safe Defaults

- To keep normal behavior, return `input.messages` unchanged.
- To add temporary text context, create a synthetic user message with a text part.
- Prefer preserving existing messages instead of rebuilding assistant/tool history unless necessary.
- If you filter messages, keep related assistant tool parts together so the model sees coherent history.
