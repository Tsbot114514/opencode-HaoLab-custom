import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Project } from "@opencode-ai/sdk/v2/client"
import { createEffect, onCleanup } from "solid-js"
import { captureDirectory } from "./server-cache"
import type { DisplayCache } from "./server-cache"
import type { ServerConnection } from "../server"
import type { State } from "./types"

const STORE = "opencode.sidebar-display.dat"
const KEY = "sidecar.v1"
const MAX_BYTES = 256 * 1024
const MAX_DIRECTORIES = 30
const MAX_SESSIONS = 55

type Storage = SyncStorage | AsyncStorage

export function desktopCacheKey(connection: ServerConnection.Any | undefined) {
  if (connection?.type === "sidecar" && connection.variant === "base") return KEY
  if (connection?.type === "tunnel" && /^[a-f0-9]{64}$/.test(connection.cacheKey ?? ""))
    return `tunnel.v1.${connection.cacheKey}`
}

export function desktopCacheStorage(storage?: (name?: string) => Storage) {
  return storage?.(STORE)
}

export function encodeDesktopCache(cache: DisplayCache) {
  const value = {
    version: 1,
    projects: cache.projects.slice(0, 100).map((project) => ({
      id: project.id, worktree: project.worktree, name: project.name,
      time: { created: project.time.created, updated: project.time.updated },
      sandboxes: project.sandboxes.slice(0, 30),
    })),
    directories: [...cache.directories].slice(-MAX_DIRECTORIES).map(([directory, entry]) => ({
      directory, project: entry.project, total: entry.total,
      cursor: entry.cursor,
      sessions: entry.sessions.slice(0, MAX_SESSIONS).map((session) => ({
        id: session.id, slug: session.slug, projectID: session.projectID,
        directory: session.directory, parentID: session.parentID,
        title: session.title, version: session.version,
        time: { created: session.time.created, updated: session.time.updated ?? session.time.created },
      })),
    })),
  }
  const size = (json: string) => new TextEncoder().encode(json).length
  while (value.directories.length && size(JSON.stringify(value)) > MAX_BYTES) value.directories.shift()
  while (value.projects.length && size(JSON.stringify(value)) > MAX_BYTES) value.projects.pop()
  const json = JSON.stringify(value)
  return size(json) <= MAX_BYTES ? json : undefined
}

export function decodeDesktopCache(raw: string | null | undefined): Pick<DisplayCache, "projects" | "directories"> | undefined {
  if (!raw || new TextEncoder().encode(raw).length > MAX_BYTES) return
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return
  }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 100 ||
    !Array.isArray(value.directories) || value.directories.length > MAX_DIRECTORIES) return
  const projects: DisplayCache["projects"] = []
  for (const project of value.projects) {
    if (!record(project) || !text(project.id) || !text(project.worktree) ||
      (project.name !== undefined && !text(project.name)) || !record(project.time) ||
      !number(project.time.created) || !number(project.time.updated) ||
      !Array.isArray(project.sandboxes) || project.sandboxes.length > 30 || !project.sandboxes.every(text)) return
    projects.push({ id: project.id, worktree: project.worktree, name: project.name,
      time: { created: project.time.created, updated: project.time.updated }, sandboxes: project.sandboxes })
  }
  const directories: DisplayCache["directories"] = new Map()
  for (const entry of value.directories) {
    if (!record(entry) || !text(entry.directory) || typeof entry.project !== "string" ||
      !number(entry.total) || entry.total < 0 || !Number.isInteger(entry.total) ||
      (entry.cursor !== undefined && (!text(entry.cursor) || !/^(0|[1-9]\d*)$/.test(entry.cursor) ||
        !Number.isSafeInteger(Number(entry.cursor)))) ||
      !Array.isArray(entry.sessions) || entry.sessions.length > MAX_SESSIONS || directories.has(entry.directory)) return
    const sessions: NonNullable<DisplayCache["directories"] extends Map<string, infer T> ? T : never>["sessions"] = []
    for (const session of entry.sessions) {
      if (!record(session) || !text(session.id) || !text(session.slug) || !text(session.projectID) ||
        session.directory !== entry.directory || !text(session.title) || !text(session.version) ||
        (session.parentID !== undefined && !text(session.parentID)) || !record(session.time) ||
        !number(session.time.created) || !number(session.time.updated)) return
      sessions.push({ id: session.id, slug: session.slug, projectID: session.projectID,
        directory: entry.directory, title: session.title, version: session.version,
        ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
        time: { created: session.time.created, updated: session.time.updated } })
    }
    directories.set(entry.directory, { project: entry.project, total: entry.total, sessions,
      ...(entry.cursor === undefined ? {} : { cursor: entry.cursor }) })
  }
  return { projects, directories }
}

export async function loadDesktopCache(storage: Storage | undefined, cache: DisplayCache, key = KEY) {
  if (!storage || !validKey(key) || cache.projects.length || cache.directories.size) return
  const raw = await Promise.resolve().then(() => storage.getItem(key)).catch(() => null)
  const restored = decodeDesktopCache(raw)
  if (!restored || cache.projects.length || cache.directories.size) return
  cache.projects = restored.projects
  cache.directories = restored.directories
}

export async function saveDesktopCache(storage: Storage | undefined, cache: DisplayCache, key = KEY) {
  if (!storage || !validKey(key)) return
  const json = encodeDesktopCache(cache)
  if (!json) {
    await Promise.resolve().then(() => storage.removeItem(key)).catch(() => undefined)
    return
  }
  await Promise.resolve().then(() => storage.setItem(key, json)).catch(() => undefined)
}

function validKey(key: string) {
  return key === KEY || /^tunnel\.v1\.[a-f0-9]{64}$/.test(key)
}

export function watchDesktopCache(input: {
  storage: Storage | undefined
  key: string
  cache: DisplayCache
  projects: () => Project[]
  directories: () => Array<{ worktree: string }>
  peek: (directory: string) => State
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const capture = () => {
    input.cache.projects = input.projects().map((project) => ({
      ...project, time: { ...project.time }, sandboxes: [...project.sandboxes],
    }))
    for (const project of input.directories().slice(0, 30)) {
      if (!project.worktree) continue
      captureDirectory(input.cache, project.worktree, input.peek(project.worktree))
    }
  }
  createEffect(() => {
    capture()
    clearTimeout(timer)
    timer = setTimeout(() => void saveDesktopCache(input.storage, input.cache, input.key), 500)
  })
  onCleanup(() => {
    clearTimeout(timer)
    capture()
    void saveDesktopCache(input.storage, input.cache, input.key)
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
