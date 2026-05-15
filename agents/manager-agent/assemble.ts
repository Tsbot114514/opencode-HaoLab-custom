// Runs before opencode converts messages to provider-specific model messages.
// Edit this file to customize this session's context; changes apply on the next request.
//
// Call contract:
// - input.sessionID: current session id, always starts with "ses".
// - input.sessionDir: per-session data directory that contains this assemble.ts file.
// - input.workspaceRoot: project workspace root.
// - input.directory: current working directory for this request.
// - input.step: current model step number; step === 1 is the first step for a user turn.
// - input.session, input.agent, and input.model describe the current session, agent, and model.
// - input.messages is MessageV2.WithParts[] after compaction filtering and reminder insertion.
//
// MessageV2.WithParts[] format:
// - return an array; every item must be { info, parts }.
// - info is MessageV2.Info, discriminated by info.role.
// - parts is MessageV2.Part[], a list of typed content/tool/file/reasoning parts for that message.
//
// User message info shape:
// - info.id: MessageID string, starts with "msg".
// - info.sessionID: SessionID string, normally input.sessionID, starts with "ses".
// - info.role: "user".
// - info.time: { created: non-negative number }.
// - info.agent: string.
// - info.model: { providerID: string, modelID: string, variant?: string }.
// - optional: format, summary, system, tools.
//
// Assistant message info shape:
// - info.id: MessageID string, starts with "msg".
// - info.sessionID: SessionID string, normally input.sessionID, starts with "ses".
// - info.role: "assistant".
// - info.time: { created: non-negative number, completed?: non-negative number }.
// - required: parentID, modelID, providerID, mode, agent, path, cost, tokens.
// - optional: error, summary, structured, variant, finish.
//
// Part shape:
// - every part has id, sessionID, messageID, and type.
// - part.id must be a PartID string starting with "prt".
// - part.sessionID must be a SessionID string, normally input.sessionID.
// - part.messageID must reference the containing message info.id.
// - valid part.type values include text, tool, file, reasoning, step-start, step-finish,
//   snapshot, patch, agent, subtask, retry, and compaction.
// - text parts are { type: "text", text: string, synthetic?: boolean, ignored?: boolean,
//   time?: { start: number, end?: number }, metadata?: object } plus the common ids.
// - tool parts are { type: "tool", callID: string, tool: string, state: ToolState,
//   metadata?: object } plus the common ids.
// - file parts are { type: "file", mime: string, url: string, filename?: string,
//   source?: object } plus the common ids.
//
// Return contract:
// - return MessageV2.WithParts[] only.
// - do not return provider messages like [{ role: "user", content: "..." }].
// - do not return strings, plain parts, or objects without { info, parts }.
// - new synthetic context should still be wrapped as a valid user or assistant message.
// - invalid returns are ignored by opencode; the original input.messages is used instead.
// - see assemble-schema.md in this session directory for the full schema reference.
//
export default async function assemble(input) {
  const all = Array.isArray(input.messages) ? input.messages : []
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const sessionID = typeof input.sessionID === "string" ? input.sessionID : ""
  const sessionDir = typeof input.sessionDir === "string" ? input.sessionDir : ""
  const step = typeof input.step === "number" ? input.step : 0
  const latest = [...all].reverse().find((msg) => msg?.info?.role === "user")
  const model =
    latest?.info?.model && typeof latest.info.model === "object"
      ? latest.info.model
      : { providerID: input.model?.providerID ?? "", modelID: input.model?.id ?? "" }
  const agent = typeof latest?.info?.agent === "string" ? latest.info.agent : input.agent?.name ?? "build"

  const readJSON = async (file) => {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      if (value && typeof value === "object") return value
    } catch {}
  }

  const scanJSON = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name === "llm-request") return []
        if (entry.isDirectory()) return scanJSON(file)
        if (entry.isFile() && entry.name.endsWith(".json")) return [file]
        return []
      }),
    )
    return nested.flat()
  }

  const makeText = (text, created, index) => {
    const messageID = "msg_assemble_" + created + "_" + index
    return {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created },
        agent,
        model,
      },
      parts: [
        {
          id: "prt_assemble_" + created + "_" + index,
          sessionID,
          messageID,
          type: "text",
          synthetic: true,
          text,
        },
      ],
    }
  }

  const sessionContextGuide = [
    "Session-local context discovery is available in this directory.",
    "To persist context for future turns, create or update JSON files with assemble: true and a string content field.",
    "Include metadata fields like name, description, updated_at, and updated_by so future agents know how to edit them.",
    "Only content is injected into the model; include any metadata the model should see inside content as text.",
    "See assemble-schema.md in this directory for the full format.",
  ].join("\n")

  const discovered = []
  for (const file of await scanJSON(sessionDir)) {
    const data = await readJSON(file)
    if (!data) continue
    const rel = path.relative(sessionDir, file).replaceAll("\\", "/")
    const isMetadata = rel === "metadata.json"
    if (!isMetadata && data.assemble !== true) continue

    const countdown = typeof data.countdown === "number" ? Math.max(0, Math.floor(data.countdown)) : undefined
    const content = isMetadata
      ? ["<session-metadata>", JSON.stringify(data, null, 2), "", sessionContextGuide, "</session-metadata>"].join("\n")
      : typeof data.content === "string"
        ? data.content.trim()
        : ""
    const expired = typeof data.expired === "string" ? data.expired.trim() : ""
    const text = countdown === undefined ? content : countdown > 0 ? content : countdown === 0 ? expired : ""
    if (text) {
      discovered.push({
        text,
        timestamp:
          typeof data.timestamp === "number" ? data.timestamp : typeof data.time === "number" ? data.time : Date.now(),
        position: data.position === "inline" || data.position === "suffix" ? data.position : "prefix",
      })
    }
    if (!isMetadata && step === 1 && typeof countdown === "number" && countdown > 0) {
      await fs.writeFile(file, JSON.stringify({ ...data, countdown: countdown - 1 }, null, 2)).catch(() => {})
    }
  }

  const prefix = discovered
    .filter((item) => item.position === "prefix")
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item, index) => makeText(item.text, item.timestamp || Date.now(), index))
  const inline = discovered
    .filter((item) => item.position === "inline")
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item, index) => makeText(item.text, item.timestamp || Date.now(), index + 10_000))
  const suffix = discovered
    .filter((item) => item.position === "suffix")
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item, index) => makeText(item.text, item.timestamp || Date.now(), index + 20_000))

  return [
    ...prefix,
    ...[...all, ...inline]
      .map((msg) => ({ msg, time: typeof msg?.info?.time?.created === "number" ? msg.info.time.created : 0 }))
      .sort((a, b) => a.time - b.time)
      .map((item) => item.msg),
    ...suffix,
  ]
}
