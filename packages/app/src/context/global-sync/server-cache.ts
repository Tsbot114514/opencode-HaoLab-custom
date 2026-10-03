import type { Config, Path, Project, Session } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import type { QueryClient } from "@tanstack/solid-query"
import type { ServerConnection } from "../server"
import type { State } from "./types"

type Summary = Pick<Session, "id" | "slug" | "projectID" | "directory" | "parentID" | "title" | "version"> & {
  time: Pick<Session["time"], "created" | "updated">
}
type Directory = {
  sessions: Summary[]
  total: number
  project: string
  cursor?: string
  transcript?: { sessionID: string; messages: State["message"][string]; parts: State["part"] }
}
type Snapshot = {
  projects: Project[]
  directories: Map<string, Directory>
  config?: Config
  path?: Path
  provider?: NormalizedProviderListResponse
  directoryPaths: Map<string, Path>
  directoryProviders: Map<string, NormalizedProviderListResponse>
}
export type DisplayCache = Snapshot

const entries = new Map<string, {
  credentials: {
    url: string
    username?: string
    password?: string
    authToken?: boolean
    cacheKey?: string
  }
  snapshot: Snapshot
}>()

export function serverDisplayCache(key: string, connection?: ServerConnection.Any) {
  if (!connection) return
  const credentials = {
    url: connection.http.url,
    username: connection.http.username,
    password: connection.http.password,
    authToken: connection.type === "http" ? connection.authToken : undefined,
    cacheKey: connection.type === "tunnel" ? connection.cacheKey : undefined,
  }
  const cached = entries.get(key)
  if (
    cached && cached.credentials.url === credentials.url &&
    cached.credentials.username === credentials.username && cached.credentials.password === credentials.password &&
    cached.credentials.authToken === credentials.authToken && cached.credentials.cacheKey === credentials.cacheKey
  ) {
    entries.delete(key)
    entries.set(key, cached)
    return cached.snapshot
  }
  const snapshot: Snapshot = {
    projects: [], directories: new Map(), directoryPaths: new Map(), directoryProviders: new Map(),
  }
  entries.set(key, { credentials, snapshot })
  while (entries.size > 3) entries.delete(entries.keys().next().value!)
  return snapshot
}

export function captureDirectory(snapshot: Snapshot, directory: string, store: State) {
  const sessions = store.session
    .filter((session) => session.id && session.directory === directory && !session.time.archived)
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .slice(0, 55)
    .map((session) => ({
      id: session.id, slug: session.slug, projectID: session.projectID, directory: session.directory,
      parentID: session.parentID, title: session.title, version: session.version,
      time: { created: session.time.created, updated: session.time.updated },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const sessionID = Object.keys(store.message).at(-1)
  const recent = sessionID ? store.message[sessionID]?.slice(-20) : undefined
  const transcript = recent?.length
    ? JSON.stringify({
        sessionID,
        messages: recent,
        parts: Object.fromEntries(recent.flatMap((message) =>
          store.part[message.id] ? [[message.id, store.part[message.id]]] : [])),
      })
    : undefined
  const cursor = snapshot.directories.get(directory)?.cursor
  snapshot.directories.delete(directory)
  snapshot.directories.set(directory, {
    sessions,
    total: store.sessionTotal,
    project: store.project,
    cursor,
    ...(transcript && transcript.length <= 128 * 1024
      ? { transcript: JSON.parse(transcript) as NonNullable<Directory["transcript"]> }
      : {}),
  })
  while (snapshot.directories.size > 30) {
    const oldest = snapshot.directories.keys().next().value!
    snapshot.directories.delete(oldest)
    snapshot.directoryPaths.delete(oldest)
    snapshot.directoryProviders.delete(oldest)
  }
}

export function restoreDirectory(snapshot: Snapshot | undefined, directory: string) {
  return snapshot?.directories.get(directory)
}

export function captureQueries(snapshot: Snapshot, client: QueryClient) {
  // Only display queries are copied. Never retain the QueryClient (it also holds session/message queries).
  snapshot.config = scrubSecrets(client.getQueryData<Config>(["config"]))
  snapshot.path = client.getQueryData<Path>([null, "path"])
  snapshot.provider = safeProvider(client.getQueryData<NormalizedProviderListResponse>([null, "providers"]))
  snapshot.directoryPaths.clear()
  snapshot.directoryProviders.clear()
  for (const directory of snapshot.directories.keys()) {
    const path = client.getQueryData<Path>([directory, "path"])
    const provider = safeProvider(client.getQueryData<NormalizedProviderListResponse>([directory, "providers"]))
    if (path) snapshot.directoryPaths.set(directory, path)
    if (provider) snapshot.directoryProviders.set(directory, provider)
  }
}

export function restoreQueries(snapshot: Snapshot, client: QueryClient) {
  if (snapshot.projects.length) client.setQueryData(["project"], snapshot.projects)
  if (snapshot.config) client.setQueryData(["config"], snapshot.config)
  if (snapshot.path) client.setQueryData([null, "path"], snapshot.path)
  if (snapshot.provider) client.setQueryData([null, "providers"], snapshot.provider)
  for (const [directory, path] of snapshot.directoryPaths) client.setQueryData([directory, "path"], path)
  for (const [directory, provider] of snapshot.directoryProviders) client.setQueryData([directory, "providers"], provider)
}

function safeProvider(provider: NormalizedProviderListResponse | undefined) {
  if (!provider) return
  return {
    ...scrubSecrets({ ...provider, all: undefined }),
    all: new Map([...provider.all].map(([key, value]) => [key, scrubSecrets(value)!])),
  } as NormalizedProviderListResponse
}

function scrubSecrets<T>(value: T | undefined): T | undefined {
  if (!value) return
  // Provider and config responses can contain credentials; snapshots must not retain them.
  return JSON.parse(JSON.stringify(value, (key, field) =>
    /(?:api.?key|token|secret|password|credential|authorization)/i.test(key) ? undefined : field)) as T
}
