import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { compareMessages } from "./message-order"
import {
  feedText,
  feedGeneration,
  validEntry,
  validFeedSession,
  type TranscriptChange,
  type TranscriptPage,
} from "../context/global-sync/transcript-cache"

export type TranscriptSnapshot = {
  generation: string
  cursor: string
  version: number
  next: string | null
  session: Session
  status: SessionStatus
  page: TranscriptPage
}
export type TranscriptChanges = {
  generation: string
  cursor: string
  highwater: string
  more: boolean
  changes: TranscriptChange[]
  session?: Session
  status: SessionStatus
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function status(value: unknown): value is SessionStatus {
  return (
    record(value) &&
    (value.type === "idle" ||
      value.type === "busy" ||
      (value.type === "retry" &&
        Number.isSafeInteger(value.attempt) &&
        typeof value.message === "string" &&
        Number.isFinite(value.next)))
  )
}

export function decodeTranscriptSnapshot(value: unknown, directory: string, sessionID: string): TranscriptSnapshot {
  if (
    !record(value) ||
    !feedText(value.cursor) ||
    !feedGeneration(value.generation) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !validFeedSession(value.session, directory, sessionID) ||
    !status(value.status) ||
    (value.next !== null && !feedText(value.next)) ||
    !Array.isArray(value.items) ||
    value.items.length > 20
  ) {
    throw new Error("Invalid transcript snapshot response")
  }
  const page = {
    session: value.items.map((item) => item?.info),
    part: value.items.map((item) => ({ id: item?.info?.id, part: item?.parts })),
    complete: value.next === null,
    cursor: value.next === null ? undefined : (value.next as string),
  }
  if (!validEntry({ ...page, directory, sessionID })) throw new Error("Invalid transcript snapshot entities")
  if (
    page.session.some((message, index) => index > 0 && compareMessages(page.session[index - 1], message) >= 0) ||
    (!page.session.length && value.next !== null)
  )
    throw new Error("Invalid transcript snapshot order")
  return {
    generation: value.generation,
    cursor: value.cursor,
    version: value.version as number,
    next: value.next as string | null,
    session: value.session,
    status: value.status,
    page,
  }
}

export function decodeTranscriptChanges(value: unknown, directory: string, sessionID: string): TranscriptChanges {
  if (
    !record(value) ||
    !feedText(value.cursor) ||
    !feedGeneration(value.generation) ||
    !feedText(value.highwater) ||
    typeof value.more !== "boolean" ||
    !status(value.status) ||
    (value.session !== undefined && !validFeedSession(value.session, directory, sessionID)) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 4096
  )
    throw new Error("Invalid transcript changes response")
  for (const change of value.changes) {
    if (!record(change) || !Number.isSafeInteger(change.seq) || (change.seq as number) < 0)
      throw new Error("Invalid transcript change version")
    if (change.type === "message.upsert" || change.type === "part.upsert") {
      const info = change.info
      if (
        !record(info) ||
        !validEntry({
          directory,
          sessionID,
          complete: true,
          session: [info],
          part: [{ id: info.id, part: change.type === "part.upsert" ? [change.part] : [] }],
        })
      )
        throw new Error("Invalid transcript change entities")
      continue
    }
    if (
      (change.type !== "message.remove" && change.type !== "part.remove") ||
      change.sessionID !== sessionID ||
      !feedText(change.messageID) ||
      (change.type === "part.remove" && !feedText(change.partID))
    )
      throw new Error("Invalid transcript removal")
  }
  return value as unknown as TranscriptChanges
}
