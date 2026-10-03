import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Database } from "@/storage/db"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { Global } from "@opencode-ai/core/global"
import { desc, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { Effect, Layer, Schema } from "effect"
import { SessionID } from "@/session/schema"

const file = () => path.join(Global.Path.data, "bark-key")
const endpointFile = () => path.join(Global.Path.data, "bark-endpoint")
const defaultEndpoint = "https://www.ggsuper.com.cn/push/api/v1/sendMsg3_New.php"
const cooldown = 5_000
const keyPattern = /^[A-Za-z0-9_-]{1,256}$/
const execFile = promisify(execFileCallback)
const secured = new Set<string>()

export async function configured() {
  const endpoint = await readEndpoint()
  return { configured: Boolean(await readKey()) || Boolean(parseCurl(endpoint) && !endpoint.includes("{{token}}")), endpoint }
}

function validEndpoint(value: string) {
  if (!value.trim() || value !== value.trim() || value.length > 8192) return false
  const request = parseCurl(value)
  const address = request ? request.url : value
  try {
    const url = new URL(address.replace(/\{\{(?:token|title|body)\}\}/g, "sample"))
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname)
  } catch {
    return false
  }
}

function parseCurl(value: string) {
  if (!/^curl(?:\.exe)?\s/i.test(value)) return
  const args: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let started = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === "\\" && quote !== "'" && i + 1 < value.length && (quote === '"' || /[\s"'\\]/.test(value[i + 1]))) {
      current += value[++i]
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      if (!quote) { quote = char; started = true; continue }
      if (quote === char) { quote = undefined; continue }
    }
    if (!quote && /\s/.test(char)) {
      if (started) args.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (quote) return
  if (started) args.push(current)
  if (!/^curl(?:\.exe)?$/i.test(args[0])) return
  let url: string | undefined
  let method: "GET" | "POST" = "GET"
  let body: string | undefined
  let redirect: RequestRedirect = "manual"
  const headers: Record<string, string> = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-X" || arg === "--request") {
      const next = args[++i]?.toUpperCase()
      if (next !== "GET" && next !== "POST") return
      method = next
      continue
    }
    if (arg === "-H" || arg === "--header") {
      const header = args[++i]
      const colon = header?.indexOf(":") ?? -1
      if (colon < 1) return
      headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim()
      continue
    }
    if (["-d", "--data", "--data-raw", "--data-binary"].includes(arg)) {
      body = args[++i]
      if (body === undefined) return
      method = "POST"
      continue
    }
    if (arg === "-L" || arg === "--location") { redirect = "follow"; continue }
    if (arg === "-s" || arg === "--silent") continue
    if (arg === "-G" || arg === "--get") { method = "GET"; continue }
    if (arg === "--url") { url = args[++i]; continue }
    if (arg.startsWith("-") || url) return
    url = arg
  }
  if (!url || (method === "GET" && body !== undefined)) return
  return { url, method, headers, body, redirect }
}

async function readEndpoint() {
  const target = endpointFile()
  const value = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return defaultEndpoint
    throw error
  })
  if (!validEndpoint(value)) throw new Error("Invalid Bark endpoint configuration")
  if (value !== defaultEndpoint && !secured.has(target)) {
    if (process.platform === "win32") await protectKey(target)
    else await fs.chmod(target, 0o600)
    secured.add(target)
  }
  return value
}

export async function setEndpoint(value: string) {
  if (!validEndpoint(value)) return false
  const target = endpointFile()
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, value, { flag: "wx", mode: 0o600 })
    await protectKey(temp)
    await fs.rename(temp, target)
    secured.add(target)
    return true
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

async function readKey() {
  try {
    const target = file()
    const key = await fs.readFile(target, "utf8")
    if (process.platform === "win32" && !secured.has(target)) {
      await protectKey(target)
      secured.add(target)
    }
    return keyPattern.test(key) ? key : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Unable to read Bark configuration")
  }
}

async function protectKey(target: string) {
  if (process.platform !== "win32") return
  const identity = await execFile("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5_000 })
  const sid = identity.stdout.match(/S-\d-(?:\d+-)+\d+/)?.[0]
  if (!sid) throw new Error("Unable to protect Bark configuration")
  await execFile("icacls", [target, "/grant:r", `*${sid}:F`, "/inheritance:r", "/Q"], {
    windowsHide: true,
    timeout: 5_000,
  })
}

export async function setKey(key: string) {
  if (!keyPattern.test(key)) return false
  const target = file()
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, key, { mode: 0o600, flag: "wx" })
    await protectKey(temp)
    await fs.rename(temp, target)
    secured.add(target)
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
    secured.delete(file())
  } catch {
    throw new Error("Unable to clear Bark configuration")
  }
}

export async function send(title: string, body: string, fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
  return (await deliver(title, body, fetcher)).success
}

export async function test(fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
  return deliver("OpenCode test", "Bark notifications are working.", fetcher)
}

async function deliver(title: string, body: string, fetcher: (input: string, init?: RequestInit) => Promise<Response>) {
  const key = await readKey()
  try {
    const endpoint = await readEndpoint()
    const request = parseCurl(endpoint)
    if (!key && (!request || endpoint.includes("{{token}}"))) return { success: false }
    const values = { token: key ?? "", title, body }
    const render = (text: string, encode: (value: string) => string) => text.replace(/\{\{(token|title|body)\}\}/g, (_, field: keyof typeof values) => encode(values[field]))
    const response = await fetcher(request ? render(request.url, encodeURIComponent) : endpoint, {
      method: request?.method ?? "POST",
      redirect: request?.redirect ?? "manual",
      headers: request ? Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, render(value, (part) => part)])) : { "content-type": "application/json" },
      body: request ? request.body === undefined ? undefined : render(request.body, (part) => JSON.stringify(part).slice(1, -1))
        : JSON.stringify({ token: key, title, msg: body, url: "", issecure: 0, sender: "OpenCode" }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return { success: false }
    const text = await response.text()
    const result: unknown = (() => { try { return JSON.parse(text) as unknown } catch { return undefined } })()
    if (typeof result !== "object" || result === null || !("code" in result)) return { success: true }
    if (result.code === 80000000 || result.code === "80000000" || result.code === 200 || result.code === "200") return { success: true }
    if ((result.code === 300 || result.code === "300") && "message" in result &&
      typeof result.message === "string" && result.message.includes("请求过于频繁")) {
      return { success: false, reason: "rate_limit" as const }
    }
    return { success: false }
  } catch {
    return { success: false }
  }
}

// Include session identity, but never send message bodies or raw error/permission/question payloads.
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

    if (type === "session.status" && (properties.status?.type === "busy" || properties.status?.type === "retry")) {
      active.add(idSession)
      return
    }
    if (type !== "session.status" && type !== "session.error" && type !== "permission.asked" && type !== "question.asked") return
    const session = (() => {
      try {
        return Database.use((db) => db.select({ title: SessionTable.title, parent: SessionTable.parent_id })
          .from(SessionTable).where(eq(SessionTable.id, idSession)).get())
      } catch {
        return undefined
      }
    })()
    if (!session) return
    let title = type === "permission.asked" ? "请求权限" : type === "question.asked" ? "等待回答" : "运行出错"
    let detail = type === "permission.asked" ? "请打开会话审批权限请求。" : type === "question.asked" ? "有问题需要你回答。" : "运行发生错误，请打开会话查看详情。"

    if (type === "session.status") {
      if (properties.status?.type !== "idle" || !active.delete(idSession)) return
      if (session.parent) return
      try {
        const message = Database.use((db) => db.select({ data: MessageTable.data }).from(MessageTable)
          .where(eq(MessageTable.session_id, idSession)).orderBy(desc(MessageTable.time_created), desc(MessageTable.id)).get())
        if (message?.data.role !== "assistant") return
        if (message.data.error?.name === "MessageAbortedError") {
          title = "已中断"
          detail = "本轮运行已停止，未正常完成。"
        } else if (!message.data.error) {
          if (!message.data.time.completed) return
          title = "本轮完成"
          detail = "本轮回复已完成，请打开会话查看结果。"
        }
      } catch {
        return
      }
    }
    if (type === "session.error") {
      active.delete(idSession)
      if (session.parent) return
      if (properties.error?.name === "MessageAbortedError") {
        title = "已中断"
        detail = "本轮运行已停止，未正常完成。"
      }
    }

    const id = type === "session.status" || type === "session.error" ? idSession : properties.id
    if (typeof id !== "string") return
    const dedupe = `${type}:${id}`
    const now = Date.now()
    if (type !== "session.status" && (recent.get(dedupe) ?? 0) + cooldown > now) return
    while (sent.length && sent[0] <= now - 60_000) sent.shift()
    if (sent.length >= 30) return
    sent.push(now)
    recent.set(dedupe, now)
    if (recent.size > 500) for (const [key, time] of recent) if (time + cooldown < now) recent.delete(key)
    const name = session.title.replace(/[\r\n\t]/g, " ").slice(0, 120)
    void sender(`OpenCode · ${title}`, `会话：${name}\n标识：${idSession.slice(-8)}\n${detail}`).catch(() => {})
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
