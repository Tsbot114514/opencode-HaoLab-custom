import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Database } from "@/storage/db"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { Global } from "@opencode-ai/core/global"
import { desc, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { SessionID } from "@/session/schema"

const file = () => path.join(Global.Path.data, "bark-key")
const endpoint = "https://api.day.app/push"
const cooldown = 5_000
const keyPattern = /^[A-Za-z0-9_-]{1,256}$/

export async function configured() {
  return { configured: Boolean(await readKey()) }
}

async function readKey() {
  try {
    const key = await fs.readFile(file(), "utf8")
    return keyPattern.test(key) ? key : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Unable to read Bark configuration")
  }
}

export async function setKey(key: string) {
  if (!keyPattern.test(key)) return false
  const target = file()
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, key, { mode: 0o600, flag: "wx" })
    await fs.rename(temp, target)
    return true
  } catch {
    throw new Error("Unable to save Bark configuration")
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

export async function clearKey() {
  try {
    await fs.rm(file(), { force: true })
  } catch {
    throw new Error("Unable to clear Bark configuration")
  }
}

export async function send(title: string, body: string, fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
  const key = await readKey()
  if (!key) return false
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_key: key, title, body, group: "OpenCode" }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return false
    const result: unknown = await response.json()
    return typeof result === "object" && result !== null && "code" in result && result.code === 200
  } catch {
    return false
  }
}

export async function test(fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
  return { success: await send("OpenCode test", "Bark notifications are working.", fetcher) }
}

// Return only fixed text. Never include prompt, tool, permission, or question fields.
export function subscribe(sender: (title: string, body: string) => Promise<boolean> = send) {
  const active = new Set<string>()
  const recent = new Map<string, number>()
  const sent: number[] = []
  const handler = (event: GlobalEvent) => {
    const type = event.payload?.type
    const properties = event.payload?.properties
    const sessionID = Schema.decodeUnknownOption(SessionID)(properties?.sessionID)
    if (sessionID._tag === "None") return
    const idSession = sessionID.value

    if (type === "session.status") {
      if (properties.status?.type === "busy" || properties.status?.type === "retry") {
        active.add(idSession)
        return
      }
      if (properties.status?.type !== "idle" || !active.delete(idSession)) return
      // The status event follows message persistence. Check the final assistant message
      // to exclude failed and interrupted runs, and the session row to exclude children.
      try {
        const eligible = Database.use((db) => {
          const session = db.select({ parent: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, idSession)).get()
          if (!session || session.parent) return false
          const message = db.select({ data: MessageTable.data }).from(MessageTable)
            .where(eq(MessageTable.session_id, idSession)).orderBy(desc(MessageTable.time_created), desc(MessageTable.id)).get()
          return message?.data.role === "assistant" && !message.data.error && !!message.data.time.completed
        })
        if (!eligible) return
      } catch {
        return
      }
    } else if (type !== "permission.asked" && type !== "question.asked") return

    const id = type === "session.status" ? idSession : properties.id
    if (typeof id !== "string") return
    const dedupe = `${type}:${id}`
    const now = Date.now()
    if (type !== "session.status" && (recent.get(dedupe) ?? 0) + cooldown > now) return
    while (sent.length && sent[0] <= now - 60_000) sent.shift()
    if (sent.length >= 30) return
    sent.push(now)
    recent.set(dedupe, now)
    if (recent.size > 500) for (const [key, time] of recent) if (time + cooldown < now) recent.delete(key)
    const title = type === "permission.asked" ? "Permission needed" : type === "question.asked" ? "Question waiting" : "Task completed"
    void sender(title, "OpenCode needs your attention.").catch(() => {})
  }
  GlobalBus.on("event", handler)
  return () => GlobalBus.off("event", handler)
}

let listeners = 0
let unsubscribe: (() => void) | undefined
export const layer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      if (listeners++ === 0) unsubscribe = subscribe()
    }),
    () => Effect.sync(() => {
      if (--listeners === 0) {
        unsubscribe?.()
        unsubscribe = undefined
      }
    }),
  ),
)

export * as Bark from "./bark"
