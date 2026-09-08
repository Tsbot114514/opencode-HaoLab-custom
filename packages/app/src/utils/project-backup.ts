import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

type Connection = { server: ServerConnection.HttpBase; fetch?: typeof fetch; directory: string; path: string }
type Snapshot = { filesUpdatedAt: number | null; sessionsUpdatedAt: number | null; files: number; sessions: number }
export type ProjectPreview = {
  package: Snapshot & { name: string; identity: string; createdAt: number }
  candidates: string[]
  directory: string | null
  action: "select-target" | "create" | "replace"
  local: Snapshot | null
  previewToken: string | null
  warnings: string[]
}

export function isAbsoluteProjectPath(path: string) {
  return (
    !path.includes("\0") && (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path))
  )
}

export async function inspectProject(input: Connection & { destination?: string }) {
  return parseProjectPreview(
    await requestProject(input, "backup/inspect", {
      path: input.path,
      ...(input.destination ? { directory: input.destination } : {}),
    }),
  )
}

export async function transferProject(
  input: Connection &
    ({ mode: "backup" } | { mode: "restore"; destination: string; previewToken: string; overwrite: boolean }),
) {
  if (input.mode === "restore" && !input.previewToken.trim()) throw new Error("请先重新读取迁移包并确认预览。")
  const data = await requestProject(
    input,
    input.mode,
    input.mode === "backup"
      ? { path: input.path }
      : {
          path: input.path,
          directory: input.destination,
          previewToken: input.previewToken,
          overwrite: input.overwrite,
        },
  )
  if (!record(data) || !count(data.sessions) || !count(data.files) || !strings(data.warnings)) {
    throw new Error("服务器返回了无效的迁移结果。")
  }
  const target = input.mode === "backup" ? data.path : data.directory
  const safetyPath = input.mode === "restore" ? data.safetyPath : null
  if (!absolute(target) || (safetyPath !== null && !absolute(safetyPath))) {
    throw new Error("服务器返回了无效的目标或安全备份路径。")
  }
  return { target, sessions: data.sessions, files: data.files, warnings: data.warnings, safetyPath }
}

export function parseProjectPreview(data: unknown): ProjectPreview {
  if (
    !record(data) ||
    !snapshot(data.package) ||
    !text(data.package.name) ||
    !text(data.package.identity) ||
    !timestamp(data.package.createdAt) ||
    !strings(data.candidates) ||
    !data.candidates.every(absolute) ||
    (data.directory !== null && !absolute(data.directory)) ||
    (data.local !== null && !snapshot(data.local)) ||
    !strings(data.warnings) ||
    (data.action !== "select-target" && data.action !== "create" && data.action !== "replace") ||
    (data.action === "select-target"
      ? data.previewToken !== null
      : !text(data.previewToken) || !absolute(data.directory)) ||
    (data.action === "replace" && data.local === null)
  ) {
    throw new Error("服务器返回了无效的迁移预览，请重新读取迁移包。")
  }
  return {
    package: {
      name: data.package.name,
      identity: data.package.identity,
      createdAt: data.package.createdAt,
      files: data.package.files,
      sessions: data.package.sessions,
      filesUpdatedAt: data.package.filesUpdatedAt,
      sessionsUpdatedAt: data.package.sessionsUpdatedAt,
    },
    candidates: data.candidates,
    directory: data.directory,
    action: data.action,
    local: data.local,
    previewToken: data.previewToken as string | null,
    warnings: data.warnings,
  }
}

export function compareProjectTime(packageTime: number | null, localTime: number | null) {
  if (packageTime === null || localTime === null) return "unknown"
  if (packageTime === localTime) return "same"
  return packageTime > localTime ? "package" : "local"
}

export function compareProjectSnapshots(pack: Snapshot, local: Snapshot) {
  const files = compareProjectTime(pack.filesUpdatedAt, local.filesUpdatedAt)
  const sessions = compareProjectTime(pack.sessionsUpdatedAt, local.sessionsUpdatedAt)
  if ((files === "package" && sessions === "local") || (files === "local" && sessions === "package")) return "mixed"
  if (files === "unknown" || sessions === "unknown") return "unknown"
  if (files === "same") return sessions
  if (sessions === "same") return files
  return files
}

export function formatProjectTime(value: number | null) {
  return value === null ? "未知 / 无记录" : new Date(value).toISOString().replace("T", " ").replace("Z", " UTC")
}

async function requestProject(input: Connection, endpoint: string, body: object): Promise<unknown> {
  const url = new URL(`${input.server.url.replace(/\/+$/, "")}/project/${endpoint}`)
  url.searchParams.set("directory", input.directory)
  const headers = new Headers({ "Content-Type": "application/json" })
  if (input.server.password) {
    headers.set(
      "Authorization",
      `Basic ${authTokenFromCredentials({ ...input.server, password: input.server.password })}`,
    )
  }
  const response = await (input.fetch ?? fetch)(
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
  )
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(record(data) && typeof data.message === "string" ? data.message : `请求失败 (${response.status})`)
  }
  return data
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
function absolute(value: unknown): value is string {
  return text(value) && isAbsoluteProjectPath(value)
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}
function snapshot(value: unknown): value is Snapshot & Record<string, unknown> {
  return (
    record(value) &&
    count(value.files) &&
    count(value.sessions) &&
    (value.filesUpdatedAt === null || timestamp(value.filesUpdatedAt)) &&
    (value.sessionsUpdatedAt === null || timestamp(value.sessionsUpdatedAt))
  )
}
