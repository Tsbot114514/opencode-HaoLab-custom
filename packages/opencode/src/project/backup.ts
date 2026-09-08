import fs from "node:fs/promises"
import { mkdirSync, renameSync, rmSync, rmdirSync, existsSync, writeFileSync, fsyncSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Writable } from "node:stream"
import { createReadStream, createWriteStream } from "node:fs"
import { Reader, ZipReader, ZipWriter, TextReader, type Entry } from "@zip.js/zip.js"
import { getTableColumns, sql } from "drizzle-orm"
import { z } from "zod"
import { Database } from "@/storage/db"
import { SessionTable, MessageTable, PartTable, TodoTable, SessionMessageTable } from "@/session/session.sql"
import { Global } from "@opencode-ai/core/global"
import type { Project } from "./project"
import { ProjectTable } from "./project.sql"

const tables = {
  session: SessionTable,
  message: MessageTable,
  part: PartTable,
  todo: TodoTable,
  session_message: SessionMessageTable,
}
const row = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]))
const identitySchema = z.object({ identity: z.string().uuid(), name: z.string().min(1).max(200) })
const markerName = ".opencode-project.json"
const summarySchema = z.object({
  filesUpdatedAt: z.number().nullable(),
  sessionsUpdatedAt: z.number().nullable(),
  files: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
})
const packageSchema = identitySchema.extend({ createdAt: z.number().finite(), ...summarySchema.shape })
const manifestSchema = z.object({
  format: z.literal("opencode-project"),
  version: z.literal(1),
  directory: z.string(),
  sourceSessionRoot: z.string(),
  platform: z.string(),
  package: packageSchema,
  rows: z.object({
    session: z.array(row),
    message: z.array(row),
    part: z.array(row),
    todo: z.array(row),
    session_message: z.array(row),
  }),
  warnings: z.array(z.string()),
})
type Manifest = z.infer<typeof manifestSchema>
type Row = z.infer<typeof row>
const maxEntries = 100_000
const maxFile = 1024 ** 3
const maxTotal = 10 * 1024 ** 3
const maxManifest = 64 * 1024 ** 2
const excluded = new Set([".git", "node_modules", ".cache", ".next", ".turbo", "__pycache__", ".venv", "venv"])
const warnings = [
  "Git metadata, node_modules, .cache, .next, .turbo, __pycache__, .venv and venv directories are excluded. Linked Git worktrees are not supported.",
  "Snapshots are not included; restored revert pointers, sharing, workspace bindings and session permissions are reset.",
  "Only workspace and included session-folder attachment paths are remapped. External attachments are not copied. Transcript text and arbitrary tool input/output are preserved without path substitution.",
  "Project configuration, session assemble.ts and session tools/skills/plugins are quarantined in backup-disabled directories; review before enabling. Project startup commands and global permissions are not imported.",
  "Restore supports the same operating system only; workspace and session data locations may differ between devices. Cross-OS path conversion is not supported.",
  "Filesystem capture is not a filesystem snapshot. Stop other writers before backing up; active sessions in the current instance are refused.",
  "Timestamps are advisory, not an automatic conflict policy. Confirmed replacement removes all portable workspace content and scoped sessions, including local-only items; local root .git is preserved. Excluded dependencies/caches are removed after commit.",
]

export function contains(root: string, target: string) {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
}

export function safeName(name: string) {
  if (!name || name.length > 1024 || name.includes("\\")) throw new Error(`Unsafe archive path: ${name}`)
  const parts = name.replace(/\/$/, "").split("/")
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[<>:"|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(`Unsafe archive path: ${name}`)
  return parts.join("/")
}

async function absolute(input: string) {
  if (!path.isAbsolute(input)) throw new Error("Paths must be absolute server filesystem paths")
  const full = path.resolve(input)
  for (let current = full; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`)
    if (path.dirname(current) === current) break
  }
  return full
}

async function exists(input: string) {
  return fs.lstat(input).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}

function migrations() {
  return path.join(Global.Path.data, "project-migrations")
}

async function marker(directory: string, create = false) {
  const file = path.join(directory, markerName)
  if (!(await exists(file))) {
    if (!create) return
    await fs
      .writeFile(
        file,
        JSON.stringify(
          { identity: crypto.randomUUID(), name: path.basename(directory).slice(0, 200) || "Project" },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
  }
  await absolute(file)
  if ((await fs.stat(file)).size > 4096) throw new Error("Project identity marker is oversized")
  return identitySchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
}

async function register(directory: string, identity: z.infer<typeof identitySchema>) {
  const registry = path.join(migrations(), "registry")
  await fs.mkdir(registry, { recursive: true, mode: 0o700 })
  await absolute(registry)
  const file = path.join(registry, `${createHash("sha256").update(directory).digest("hex")}.json`)
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ ...identity, directory }), { flag: "wx", mode: 0o600 })
  await fs.rename(temp, file)
}

function sessionTime(rows: Manifest["rows"]) {
  const times = Object.values(rows).flatMap((rows) =>
    rows.flatMap((r) =>
      [r.time_updated, r.time_created, r.time_archived].filter((time): time is number => typeof time === "number"),
    ),
  )
  return times.length ? times.reduce((a, b) => Math.max(a, b), 0) : null
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)]),
  )
}

function databaseState(directory: string) {
  return Database.transaction((db) => {
    const rows = capture(directory)
    const extras: Row[] = []
    const ids = rows.session.map((r) => r.id)
    for (const name of ["event_sequence", "event", "session_share"]) {
      const key = name === "session_share" ? "session_id" : "aggregate_id"
      for (let offset = 0; offset < ids.length; offset += 500)
        extras.push(
          ...db.all<Row>(
            sql`SELECT * FROM ${sql.identifier(name)} WHERE ${sql.identifier(key)} IN (${sql.join(
              ids.slice(offset, offset + 500).map((id) => sql`${id}`),
              sql`, `,
            )}) ORDER BY ${sql.identifier(name === "event" ? "id" : key)}`,
          ),
        )
    }
    const text = JSON.stringify(canonical({ rows, extras }))
    if (Buffer.byteLength(text) > maxManifest) throw new Error("Local session state exceeds the preview limit")
    return { rows, hash: createHash("sha256").update(text).digest("hex") }
  })
}

async function fileHash(file: string) {
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size > maxTotal + maxEntries * 4096)
    throw new Error("File exceeds migration fingerprint bounds")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function destination(input: string) {
  if (!path.isAbsolute(input)) throw new Error("Destination must be an absolute server path")
  const directory = path.resolve(input)
  await absolute((await exists(directory)) ? directory : path.dirname(directory))
  if ((await exists(directory)) && !(await fs.stat(directory)).isDirectory())
    throw new Error("Destination must be a directory")
  if (
    [Global.Path.data, Global.Path.config, Global.Path.state].some(
      (global) => contains(directory, global) || contains(global, directory),
    )
  )
    throw new Error("Migration into application data or global configuration is forbidden")
  if (path.isAbsolute(Database.getPath()) && contains(directory, Database.getPath()))
    throw new Error("The target contains the live application database")
  if (path.dirname(directory) === directory) throw new Error("A filesystem root cannot be a migration target")
  if ((await exists(path.join(directory, ".git"))) && !(await fs.lstat(path.join(directory, ".git"))).isDirectory())
    throw new Error("Linked Git worktrees are not supported")
  return directory
}

async function localState(directory: string, wasMissing = false) {
  const db = databaseState(directory)
  const hash = createHash("sha256").update(db.hash)
  const present = await exists(directory)
  const names = present ? await fs.readdir(directory) : []
  hash.update(present && !(wasMissing && !names.length) ? "present" : "absent")
  let entries = 0
  let bytes = 0
  const summary = {
    filesUpdatedAt: null as number | null,
    sessionsUpdatedAt: sessionTime(db.rows),
    files: 0,
    sessions: db.rows.session.length,
  }
  async function walk(file: string, relative: string, portable: boolean, session: boolean): Promise<void> {
    const stat = await fs.lstat(file)
    if (++entries > maxEntries) throw new Error("Local state has too many files to preview safely")
    if (stat.isSymbolicLink() && !portable) {
      hash.update(JSON.stringify([relative, "excluded-link", await fs.readlink(file), stat.mtimeMs]))
      return
    }
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (portable && stat.isFile() && stat.nlink > 1)
    )
      throw new Error(`Links and special files are not supported: ${file}`)
    hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file", stat.mode]))
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort())
        await walk(path.join(file, name), `${relative}/${name}`, portable && !excluded.has(name.toLowerCase()), session)
      return
    }
    if ((bytes += stat.size) > maxTotal) throw new Error("Local state exceeds the preview size limit")
    hash.update(JSON.stringify([stat.size, stat.mtimeMs, await fileHash(file)]))
    if (!portable) return
    summary.files++
    if (session) summary.sessionsUpdatedAt = Math.max(summary.sessionsUpdatedAt ?? 0, stat.mtimeMs)
    else if (path.basename(file) !== markerName)
      summary.filesUpdatedAt = Math.max(summary.filesUpdatedAt ?? 0, stat.mtimeMs)
  }
  for (const name of names.sort())
    await walk(path.join(directory, name), `workspace/${name}`, !excluded.has(name.toLowerCase()), false)
  for (const r of db.rows.session) {
    for (const [file, name] of [
      [path.join(Global.Path.data, "session", String(r.id)), `sessions/${r.id}`],
      [path.join(Global.Path.data, "storage", "session_diff", `${r.id}.json`), `diffs/${r.id}.json`],
    ]) {
      if (await exists(file)) await walk(file, name, true, true)
      else hash.update(`missing:${name}`)
    }
  }
  if (databaseState(directory).hash !== db.hash)
    throw new Error("Local session state changed during preview; inspect again")
  return {
    hash: hash.digest("hex"),
    dbHash: db.hash,
    summary,
    rows: db.rows,
    present: present && !wasMissing,
    replace: names.length > 0 || db.rows.session.length > 0,
  }
}

const previews = new Map<
  string,
  {
    archive: string
    archiveHash: string
    directory: string
    stateHash: string
    expires: number
    present: boolean
    replace: boolean
  }
>()

export async function inspect(input: { path: string; directory?: string }) {
  const archive = await absolute(input.path)
  const archiveHash = await fileHash(archive)
  const opened = await openPackage(archive)
  try {
    const candidates = new Set<string>()
    const discoveryWarnings: string[] = []
    const known = new Set(
      Database.use((db) => [
        ...db
          .select()
          .from(ProjectTable)
          .all()
          .flatMap((r) => [r.worktree, ...r.sandboxes]),
        ...db.all<{ directory: string }>(sql`SELECT DISTINCT directory FROM session`).map((r) => r.directory),
      ]),
    )
    const registry = path.join(migrations(), "registry")
    if (await exists(registry)) {
      for (const name of await fs.readdir(registry)) {
        if (!name.endsWith(".json")) continue
        const item = z
          .object({ directory: z.string() })
          .parse(JSON.parse(await fs.readFile(path.join(registry, name), "utf8")))
        known.add(item.directory)
      }
    }
    for (const dir of known) {
      if (!path.isAbsolute(dir) || !(await exists(dir))) continue
      const identity = await marker(dir).catch((error: unknown) => {
        discoveryWarnings.push(`Skipped an unreadable known project marker at ${dir}: ${String(error)}`)
        return undefined
      })
      if (identity?.identity === opened.manifest.package.identity) candidates.add(path.resolve(dir))
    }
    const selected = input.directory ?? (candidates.size === 1 ? [...candidates][0] : undefined)
    const directory = selected ? await destination(selected) : null
    const local = directory ? await localState(directory) : null
    const identity = directory ? await marker(directory) : undefined
    if (identity && identity.identity !== opened.manifest.package.identity)
      throw new Error("Target is marked as a different project; choose its matching project or a new directory")
    if (directory) {
      if (contains(directory, archive)) throw new Error("The migration package must be outside the destination")
      collisions(opened.manifest, new Set(local?.rows.session.map((r) => String(r.id))))
    }
    if ((await fileHash(archive)) !== archiveHash) throw new Error("Package changed during inspection; inspect again")
    const previewToken = directory && local ? crypto.randomUUID() : null
    for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key)
    if (previews.size >= 128) previews.delete(previews.keys().next().value ?? "")
    if (previewToken && directory && local)
      previews.set(previewToken, {
        archive,
        archiveHash,
        directory,
        stateHash: local.hash,
        present: local.present,
        replace: local.replace,
        expires: Date.now() + 15 * 60_000,
      })
    return {
      package: opened.manifest.package,
      candidates: [...candidates].sort(),
      directory,
      action: !directory ? ("select-target" as const) : local?.replace ? ("replace" as const) : ("create" as const),
      local: local && (local.present || local.summary.sessions) ? local.summary : null,
      previewToken,
      warnings: [
        ...new Set([
          ...warnings,
          ...opened.manifest.warnings,
          ...discoveryWarnings,
          ...(directory && !identity
            ? [
                "The explicitly selected unmarked directory will be adopted as this project. Confirmation replaces any existing contents and scoped sessions.",
              ]
            : []),
        ]),
      ],
    }
  } finally {
    await opened.reader.close()
    await opened.handle.close()
  }
}

// Random-access ZIP reader avoids loading workspace files or the archive into RAM.
class FileReader extends Reader<fs.FileHandle> {
  constructor(
    readonly handle: fs.FileHandle,
    size: number,
  ) {
    super(handle)
    this.size = size
  }
  override async readUint8Array(offset: number, length: number) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size ||
      length > 256 * 1024 ** 2
    )
      throw new Error("Invalid or oversized archive read")
    const buffer = new Uint8Array(length)
    let read = 0
    while (read < length) {
      const chunk = await this.handle.read(buffer, read, length - read, offset + read)
      if (!chunk.bytesRead) throw new Error("File changed or archive is truncated")
      read += chunk.bytesRead
    }
    return buffer
  }
}

function capture(directory: string): Manifest["rows"] {
  return Database.transaction((db) => {
    const sessions = db
      .all<Row>(sql`SELECT * FROM session`)
      .filter((r) => typeof r.directory === "string" && contains(directory, r.directory))
    const ids = sessions.map((r) => r.id)
    const rows = {
      session: sessions,
      message: [] as Row[],
      part: [] as Row[],
      todo: [] as Row[],
      session_message: [] as Row[],
    }
    for (const name of ["message", "part", "todo", "session_message"] as const) {
      for (let offset = 0; offset < ids.length; offset += 500) {
        rows[name].push(
          ...db.all<Row>(
            sql`SELECT * FROM ${sql.identifier(name)} WHERE session_id IN (${sql.join(
              ids.slice(offset, offset + 500).map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
      }
    }
    return rows
  })
}

export async function backup(input: {
  directory: string
  path: string
  active?: ReadonlySet<string>
  safetyIdentity?: z.infer<typeof identitySchema>
}) {
  const present = await exists(input.directory)
  const directory =
    !present && input.safetyIdentity ? await destination(input.directory) : await absolute(input.directory)
  if (present && !(await fs.stat(directory)).isDirectory()) throw new Error("Source must be a directory")
  if (!path.isAbsolute(input.path)) throw new Error("Archive path must be absolute")
  const output = path.join(await absolute(path.dirname(input.path)), path.basename(input.path))
  if (contains(directory, output)) throw new Error("Archive must not be inside the source directory")
  if (
    [Global.Path.data, Global.Path.config, Global.Path.state].some(
      (global) => contains(directory, global) || contains(global, directory),
    )
  )
    throw new Error("Backing up application data or global configuration is forbidden")
  if (await exists(output)) throw new Error("Archive destination already exists")
  if (path.isAbsolute(Database.getPath()) && contains(directory, Database.getPath()))
    throw new Error("The source contains the live application database")
  const rows = capture(directory)
  if (rows.session.some((r) => input.active?.has(String(r.id))))
    throw new Error("Stop active sessions before backing up")
  const identity =
    (await marker(directory, !input.safetyIdentity)) ??
    (input.safetyIdentity ? identitySchema.parse(input.safetyIdentity) : undefined)
  if (!identity) throw new Error("Could not establish project migration identity")
  if (!input.safetyIdentity) await register(directory, identity)
  const manifest: Manifest = {
    format: "opencode-project",
    version: 1,
    directory,
    sourceSessionRoot: path.join(Global.Path.data, "session"),
    platform: process.platform,
    rows,
    warnings: [...warnings],
    package: {
      ...identity,
      createdAt: Date.now(),
      filesUpdatedAt: null,
      sessionsUpdatedAt: sessionTime(rows),
      files: 0,
      sessions: rows.session.length,
    },
  }
  const temp = await fs.mkdtemp(path.join(path.dirname(output), ".opencode-backup-"))
  const target = path.join(temp, "archive.zip")
  const stream = createWriteStream(target, { flags: "wx", mode: 0o600 })
  const zip = new ZipWriter(Writable.toWeb(stream))
  const seen = new Set<string>()
  let files = 0
  let total = 0
  async function add(local: string, name: string) {
    if ([Database.getPath(), `${Database.getPath()}-wal`, `${Database.getPath()}-shm`].includes(local))
      throw new Error("The live application database cannot be archived")
    const stat = await fs.lstat(local)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.nlink > 1 && stat.isFile()))
      throw new Error(`Links and special files are not supported: ${local}`)
    const safe = safeName(name)
    if (seen.has(safe.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`)
    seen.add(safe.toLowerCase())
    if (seen.size >= maxEntries) throw new Error("Too many archive entries")
    if (stat.isDirectory()) {
      await zip.add(`${safe}/`, undefined, { directory: true })
      for (const entry of await fs.readdir(local, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === ".git" && !entry.isDirectory())
          throw new Error("Linked Git worktrees (.git files) are not portable")
        if (entry.isDirectory() && excluded.has(entry.name.toLowerCase())) continue
        if (input.safetyIdentity && safe === "workspace" && entry.name === markerName) continue
        await add(path.join(local, entry.name), `${safe}/${entry.name}`)
      }
      return
    }
    if (stat.size > maxFile || (total += stat.size) > maxTotal) throw new Error("Archive size limit exceeded")
    if (name.startsWith("diffs/") && stat.size > maxManifest) throw new Error("Session diff exceeds the 64 MiB limit")
    const handle = await fs.open(local, "r")
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink > 1 || opened.ino !== stat.ino || opened.dev !== stat.dev)
        throw new Error(`File changed during backup: ${local}`)
      await zip.add(safe, new FileReader(handle, stat.size), {
        useWebWorkers: false,
        lastModDate: stat.mtime,
        extendedTimestamp: true,
      })
      const after = await handle.stat()
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error(`File changed during backup: ${local}`)
      files++
      if (safe.startsWith("workspace/") && safe !== `workspace/${markerName}`)
        manifest.package.filesUpdatedAt = Math.max(manifest.package.filesUpdatedAt ?? 0, stat.mtimeMs)
      if (safe.startsWith("sessions/") || safe.startsWith("diffs/"))
        manifest.package.sessionsUpdatedAt = Math.max(manifest.package.sessionsUpdatedAt ?? 0, stat.mtimeMs)
    } finally {
      await handle.close()
    }
  }
  try {
    if (present) await add(directory, "workspace")
    else await zip.add("workspace/", undefined, { directory: true })
    if (input.safetyIdentity) {
      await zip.add(`workspace/${markerName}`, new TextReader(JSON.stringify(identity)), { useWebWorkers: false })
      files++
    }
    for (const session of manifest.rows.session) {
      const id = String(session.id)
      safeName(id)
      if (id.includes("/")) throw new Error("Invalid session ID")
      const local = path.join(Global.Path.data, "session", id)
      if (await exists(local)) await add(local, `sessions/${id}`)
      const diff = path.join(Global.Path.data, "storage", "session_diff", `${id}.json`)
      if (await exists(diff)) await add(diff, `diffs/${id}.json`)
    }
    manifest.package.files = files
    const text = JSON.stringify(manifest)
    if (Buffer.byteLength(text) > maxManifest) throw new Error("Session data exceeds the 64 MiB manifest limit")
    if (total + Buffer.byteLength(text) > maxTotal) throw new Error("Archive size limit exceeded")
    await zip.add("manifest.json", new TextReader(text), { useWebWorkers: false })
    await zip.close()
    if (!input.safetyIdentity && JSON.stringify(await marker(directory)) !== JSON.stringify(identity))
      throw new Error("Project identity changed during export; retry")
    await fs.link(target, output)
    return { path: output, sessions: manifest.rows.session.length, files, warnings: manifest.warnings }
  } finally {
    stream.destroy()
    await fs.rm(temp, { recursive: true, force: true })
  }
}

function validate(manifest: Manifest) {
  const ids = new Set<string>()
  const messages = new Map<string, string>()
  for (const r of manifest.rows.session) {
    if (typeof r.id !== "string" || !/^ses_[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id))
      throw new Error("Invalid or duplicate session ID")
    if (typeof r.directory !== "string" || !path.isAbsolute(r.directory) || !contains(manifest.directory, r.directory))
      throw new Error("Session directory outside archive scope")
    ids.add(r.id)
  }
  for (const [name, rows] of Object.entries(manifest.rows)) {
    const columns = getTableColumns(tables[name as keyof typeof tables])
    const seen = new Set<string>()
    for (const r of rows) {
      if (Object.keys(r).some((key) => !Object.hasOwn(columns, key))) throw new Error(`Unsupported ${name} column`)
      if (name !== "session" && !ids.has(String(r.session_id))) throw new Error("Orphan session data")
      if (name !== "todo") {
        if (typeof r.id !== "string" || seen.has(r.id)) throw new Error(`Duplicate or invalid ${name} ID`)
        seen.add(r.id)
      }
      if (name === "message") messages.set(String(r.id), String(r.session_id))
    }
  }
  for (const r of manifest.rows.part) {
    if (messages.get(String(r.message_id)) !== r.session_id) throw new Error("Orphan or cross-session part")
  }
}

function collisions(manifest: Manifest, replace = new Set<string>()) {
  Database.use((db) => {
    for (const name of ["session", "message", "part", "session_message"] as const) {
      for (const r of manifest.rows[name]) {
        const existing = db.get<{ session_id: string }>(
          sql`SELECT ${sql.identifier(name === "session" ? "id" : "session_id")} AS session_id FROM ${sql.identifier(name)} WHERE id = ${r.id}`,
        )
        if (existing && !replace.has(existing.session_id)) throw new Error(`ID collision in ${name}: ${r.id}`)
      }
    }
    for (const r of manifest.rows.session) {
      if (
        !replace.has(String(r.id)) &&
        db.get(sql`SELECT aggregate_id FROM event_sequence WHERE aggregate_id = ${r.id}`)
      )
        throw new Error(`Event aggregate collision: ${r.id}`)
    }
  })
}

async function openPackage(archive: string) {
  const handle = await fs.open(archive, "r")
  const stat = await handle.stat()
  const reader = new ZipReader(new FileReader(handle, stat.size), { useWebWorkers: false })
  try {
    if (!stat.isFile() || stat.size > maxTotal + maxEntries * 4096)
      throw new Error("Archive must be a regular file within the size limit")
    const entries: Entry[] = []
    const seen = new Set<string>()
    const prefixes = new Map<string, string>()
    let total = 0
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries) throw new Error("Too many archive entries")
      entries.push(entry)
      const name = safeName(entry.filename)
      if (seen.has(name.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`)
      seen.add(name.toLowerCase())
      const parts = name.split("/")
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join("/")
        const previous = prefixes.get(prefix.toLowerCase())
        if (previous && previous !== prefix) throw new Error(`Case-ambiguous archive path: ${name}`)
        prefixes.set(prefix.toLowerCase(), prefix)
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      if ((mode && mode !== 0x8000 && mode !== 0x4000) || entry.externalFileAttributes & 0x400 || entry.encrypted)
        throw new Error("Archive links, special files and encryption are not supported")
      if (entry.uncompressedSize > maxFile || (total += entry.uncompressedSize) > maxTotal)
        throw new Error("Archive size limit exceeded")
      if (name.startsWith("diffs/") && entry.uncompressedSize > maxManifest)
        throw new Error("Session diff exceeds the 64 MiB limit")
    }
    const meta = entries.find((entry) => entry.filename === "manifest.json")
    if (!meta?.getData || meta.uncompressedSize > maxManifest) throw new Error("Missing or oversized backup manifest")
    const chunks: Uint8Array[] = []
    let size = 0
    await meta.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.length
          if (size > maxManifest || size > meta.uncompressedSize) throw new Error("Manifest exceeded size limit")
          chunks.push(chunk)
        },
      }),
      { checkSignature: true },
    )
    const manifest = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    if (manifest.platform !== process.platform) throw new Error("Restore supports the same operating system only")
    if (
      !path.isAbsolute(manifest.sourceSessionRoot) ||
      manifest.sourceSessionRoot.includes("\0") ||
      path.resolve(manifest.sourceSessionRoot) !== path.normalize(manifest.sourceSessionRoot)
    )
      throw new Error("Invalid source session root")
    if (
      !path.isAbsolute(manifest.directory) ||
      manifest.directory.includes("\0") ||
      path.resolve(manifest.directory) !== path.normalize(manifest.directory)
    )
      throw new Error("Invalid source directory")
    if (
      contains(manifest.directory, manifest.sourceSessionRoot) ||
      contains(manifest.sourceSessionRoot, manifest.directory)
    )
      throw new Error("Source workspace and session roots must not overlap")
    validate(manifest)
    const ids = new Set(manifest.rows.session.map((r) => String(r.id)))
    for (const entry of entries) {
      if (entry === meta) continue
      const parts = safeName(entry.filename).split("/")
      if (
        parts[0] !== "workspace" &&
        !(parts[0] === "sessions" && ids.has(parts[1])) &&
        !(parts[0] === "diffs" && parts.length === 2 && parts[1].endsWith(".json") && ids.has(parts[1].slice(0, -5)))
      )
        throw new Error(`Unexpected archive entry: ${entry.filename}`)
      if (parts.some((p) => p.toLowerCase() === ".git"))
        throw new Error("Git metadata is not supported in this archive version")
    }
    if (
      manifest.package.files !== entries.filter((entry) => entry !== meta && !entry.directory).length ||
      manifest.package.sessions !== ids.size
    )
      throw new Error("Package counts do not match its contents")
    return { reader, handle, entries, meta, manifest }
  } catch (error) {
    await reader.close()
    await handle.close()
    throw error
  }
}

// Only known structured path fields are remapped. Never replace strings in transcripts.
function remap(value: unknown, roots: readonly { source: string; destination: string }[], assistant = false): unknown {
  if (Array.isArray(value)) return value.map((x) => remap(x, roots))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // V2 assistant content contains typed tools; only those contain attachment metadata.
      if (assistant && key === "content" && Array.isArray(item))
        return [
          key,
          item.map((part: unknown) =>
            part && typeof part === "object" && "type" in part && part.type === "tool" ? remap(part, roots) : part,
          ),
        ]
      if (["input", "output", "structured", "text", "content"].includes(key)) return [key, item]
      if (key === "url" && typeof item === "string" && item.startsWith("file:")) {
        const file = fileURLToPath(item)
        const root = roots.find((root) => contains(root.source, file))
        if (root) return [key, pathToFileURL(path.join(root.destination, path.relative(root.source, file))).href]
      }
      if (
        ["directory", "cwd", "root", "file", "filePath", "filepath", "path", "filename"].includes(key) &&
        typeof item === "string" &&
        path.isAbsolute(item)
      ) {
        const root = roots.find((root) => contains(root.source, item))
        if (root) return [key, path.join(root.destination, path.relative(root.source, item))]
      }
      return [key, remap(item, roots)]
    }),
  )
}

export async function restore(input: {
  path: string
  directory: string
  previewToken: string
  overwrite: boolean
  resolveProject: (directory: string) => Promise<Project.Info>
  active?: () => Promise<ReadonlySet<string>>
  invalidate?: (directory: string) => Promise<void>
}) {
  const archive = await absolute(input.path)
  const directory = await destination(input.directory)
  const preview = previews.get(input.previewToken)
  if (!preview || preview.expires < Date.now() || preview.directory !== directory || preview.archive !== archive)
    throw new Error("Missing, expired or mismatched preview token; inspect the package again")
  if (preview.replace && input.overwrite !== true)
    throw new Error("Replacement requires explicit overwrite confirmation")
  await fs.mkdir(migrations(), { recursive: true, mode: 0o700 })
  await absolute(migrations())
  const journal = path.join(migrations(), "apply.lock")
  const lock = await fs.open(journal, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error(`Another migration is running or requires recovery. Review ${journal} before retrying`)
    throw error
  })
  previews.delete(input.previewToken)
  let stage: string | undefined
  let dataStage: string | undefined
  let handle: fs.FileHandle | undefined
  let reader: ZipReader<fs.FileHandle> | undefined
  const moved: string[] = []
  const preserved: [string, string][] = []
  let committed = false
  let created = false
  let recovered = true
  let safetyPath: string | null = null
  const resultWarnings: string[] = []
  function record(phase: string, details: Record<string, unknown> = {}) {
    writeFileSync(
      journal,
      JSON.stringify({ phase, directory, archive, safetyPath, stage, dataStage, ...details }, null, 2),
    )
    fsyncSync(lock.fd)
  }
  async function check() {
    const archiveHash = await fileHash(archive)
    const local = await localState(directory, created)
    if (local.hash !== preview?.stateHash || archiveHash !== preview.archiveHash)
      throw new Error("Stale preview: package, workspace, session data or session context changed; inspect again")
    const active = await input.active?.()
    if (local.rows.session.some((r) => active?.has(String(r.id))))
      throw new Error("Stop active target sessions before migration")
    return local
  }
  try {
    record("validating")
    const previous = await check()
    stage = await fs.mkdtemp(path.join(path.dirname(directory), ".opencode-restore-"))
    const opened = await openPackage(archive)
    handle = opened.handle
    reader = opened.reader
    const { entries, meta, manifest } = opened
    const replacing = new Set(previous.rows.session.map((r) => String(r.id)))
    collisions(manifest, replacing)
    if (previous.replace) {
      safetyPath = path.join(migrations(), `safety-${Date.now()}-${crypto.randomUUID()}.zip`)
      record("safety-backup")
      await backup({ directory, path: safetyPath, safetyIdentity: manifest.package })
      await check()
    }
    const ids = new Set(manifest.rows.session.map((r) => String(r.id)))
    const roots = [
      ...[...ids].map((id) => ({
        source: path.join(manifest.sourceSessionRoot, id),
        destination: path.join(Global.Path.data, "session", id),
      })),
      { source: manifest.directory, destination: directory },
    ]
    for (const id of ids) {
      for (const target of [
        path.join(Global.Path.data, "session", id),
        path.join(Global.Path.data, "storage", "session_diff", `${id}.json`),
      ]) {
        if (!replacing.has(id) && (await exists(target))) throw new Error(`Session storage collision: ${id}`)
      }
    }
    // Session storage can be on another volume: stage it beside its final home.
    if (ids.size || replacing.size)
      dataStage = await fs.mkdtemp(path.join(await absolute(Global.Path.data), ".project-restore-"))
    const state = dataStage ?? stage
    record("staging")
    let files = 0
    for (const entry of entries) {
      if (entry === meta) continue
      const name = safeName(entry.filename)
      const parts = name.split("/")
      const output = path.join(parts[0] === "workspace" ? stage : state, name)
      if (entry.directory) {
        await fs.mkdir(output, { recursive: true })
        continue
      }
      await fs.mkdir(path.dirname(output), { recursive: true })
      const stream = createWriteStream(output, { flags: "wx", mode: 0o600 })
      let bytes = 0
      const bound = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.length
          if (bytes > entry.uncompressedSize || bytes > maxFile) throw new Error("Archive entry exceeded declared size")
          controller.enqueue(chunk)
        },
      })
      const writing = bound.readable.pipeTo(Writable.toWeb(stream))
      try {
        if (!entry.getData) throw new Error("Invalid file entry")
        await Promise.all([entry.getData(bound.writable, { checkSignature: true }), writing])
        if (bytes !== entry.uncompressedSize) throw new Error("Archive entry size mismatch")
      } finally {
        stream.destroy()
      }
      if (entry.lastModDate && Number.isFinite(entry.lastModDate.getTime()))
        await fs.utimes(output, entry.lastModDate, entry.lastModDate)
      files++
    }
    await fs.mkdir(path.join(stage, "workspace"), { recursive: true })
    // Quarantine whole configuration trees, including plugins and permission settings.
    async function quarantine(root: string, recursive: boolean) {
      await fs.mkdir(root, { recursive: true })
      for (const name of await fs.readdir(root)) {
        const config = [".opencode", "opencode.json", "opencode.jsonc"]
        if (!recursive) config.push("assemble.ts", "tool", "skill", "skills", "plugin", "plugins")
        if (!config.includes(name.toLowerCase())) {
          if (recursive && (await fs.stat(path.join(root, name))).isDirectory())
            await quarantine(path.join(root, name), true)
          continue
        }
        const preferred = path.join(root, "backup-disabled", name)
        const disabled = (await exists(preferred))
          ? path.join(root, "backup-disabled", `import-${crypto.randomUUID()}`, name)
          : preferred
        await fs.mkdir(path.dirname(disabled), { recursive: true })
        await fs.rename(path.join(root, name), disabled)
      }
    }
    await quarantine(path.join(stage, "workspace"), true)
    for (const id of ids) await quarantine(path.join(state, "sessions", id), false)
    await fs.writeFile(
      path.join(stage, "workspace", markerName),
      JSON.stringify(identitySchema.parse(manifest.package), null, 2),
    )
    await check()
    if (!previous.present) {
      await fs.mkdir(directory)
      created = true
    }
    const project = await input.resolveProject(directory)
    for (const r of manifest.rows.session) {
      r.directory = path.join(directory, path.relative(manifest.directory, String(r.directory)))
      r.project_id = project.id
      r.path = path.relative(project.worktree, r.directory).replaceAll("\\", "/")
      r.parent_id = ids.has(String(r.parent_id)) ? r.parent_id : null
      r.workspace_id = null
      r.permission = null
      r.revert = null
      r.share_url = null
      r.time_compacting = null
      await fs.writeFile(
        path.join(state, "sessions", String(r.id), "metadata.json"),
        JSON.stringify(
          {
            id: r.id,
            project_id: r.project_id,
            parent_id: r.parent_id,
            directory: r.directory,
            path: r.path,
            title: r.title,
            session_local_tools: { path: path.join(Global.Path.data, "session", String(r.id), "tool", "README.md") },
            time: { created: r.time_created, updated: r.time_updated, archived: r.time_archived },
          },
          null,
          2,
        ),
      )
    }
    for (const [name, rows] of Object.entries(manifest.rows)) {
      for (const r of rows) {
        for (const key of name === "session" ? ["summary_diffs"] : ["data"]) {
          if (typeof r[key] === "string")
            r[key] = JSON.stringify(
              remap(JSON.parse(r[key]), roots, name === "session_message" && r.type === "assistant"),
            )
        }
      }
    }
    for (const id of ids) {
      const diff = path.join(state, "diffs", `${id}.json`)
      if (await exists(diff))
        await fs.writeFile(diff, JSON.stringify(remap(JSON.parse(await fs.readFile(diff, "utf8")), roots)))
    }
    const workspace = path.join(stage, "workspace")
    const moves = (await fs.readdir(workspace)).map((name) => [path.join(workspace, name), path.join(directory, name)])
    for (const id of ids) {
      moves.push([path.join(state, "sessions", id), path.join(Global.Path.data, "session", id)])
      if (await exists(path.join(state, "diffs", `${id}.json`)))
        moves.push([
          path.join(state, "diffs", `${id}.json`),
          path.join(Global.Path.data, "storage", "session_diff", `${id}.json`),
        ])
    }
    await absolute(directory)
    for (const [, target] of moves) {
      let parent = path.dirname(target)
      while (!(await exists(parent))) parent = path.dirname(parent)
      await absolute(parent)
    }
    const oldMoves: [string, string][] = []
    for (const name of await fs.readdir(directory)) {
      if (name.toLowerCase() === ".git") continue
      oldMoves.push([path.join(directory, name), path.join(stage, "previous-workspace", name)])
    }
    for (const id of replacing) {
      for (const [from, to] of [
        [path.join(Global.Path.data, "session", id), path.join(state, "previous-sessions", id)],
        [
          path.join(Global.Path.data, "storage", "session_diff", `${id}.json`),
          path.join(state, "previous-diffs", `${id}.json`),
        ],
      ])
        if (await exists(from)) oldMoves.push([from, to])
    }
    await check()
    record("committing", { oldMoves, newMoves: moves })
    // Synchronous moves inside the SQL transaction allow rollback on ordinary I/O/SQL errors.
    Database.transaction(
      (db) => {
        if (databaseState(directory).hash !== previous.dbHash)
          throw new Error("Stale preview: session data changed before commit; inspect again")
        collisions(manifest, replacing)
        // Originals remain on their own volumes until the SQL transaction succeeds.
        for (const [from, to] of oldMoves) {
          mkdirSync(path.dirname(to), { recursive: true })
          renameSync(from, to)
          preserved.push([from, to])
        }
        db.insert(ProjectTable)
          .values({
            id: project.id,
            worktree: project.worktree,
            vcs: project.vcs,
            time_created: project.time.created,
            time_updated: project.time.updated,
            sandboxes: project.sandboxes,
          })
          .onConflictDoNothing()
          .run()
        for (const id of replacing) {
          db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${id}`)
          db.run(sql`DELETE FROM session WHERE id = ${id}`)
        }
        for (const [name, rows] of Object.entries(manifest.rows)) {
          for (const r of rows) {
            db.run(
              sql`INSERT INTO ${sql.identifier(name)} (${sql.join(
                Object.keys(r).map((key) => sql.identifier(key)),
                sql`, `,
              )}) VALUES (${sql.join(
                Object.values(r).map((value) => sql`${value}`),
                sql`, `,
              )})`,
            )
          }
        }
        for (const [from, to] of moves) {
          if (existsSync(to)) throw new Error(`Restore destination collision: ${to}`)
          mkdirSync(path.dirname(to), { recursive: true })
          renameSync(from, to)
          moved.push(to)
        }
      },
      { behavior: "immediate" },
    )
    committed = true
    resultWarnings.push(...new Set([...warnings, ...manifest.warnings]))
    try {
      record("committed", { oldMoves, newMoves: moves })
    } catch (error) {
      resultWarnings.push(`Migration committed but its recovery journal could not be updated: ${String(error)}`)
    }
    await register(directory, identitySchema.parse(manifest.package)).catch((error: unknown) =>
      resultWarnings.push(`Migration succeeded but local identity registry update failed: ${String(error)}`),
    )
    await input
      .invalidate?.(directory)
      .catch((error: unknown) =>
        resultWarnings.push(
          `Migration succeeded but runtime invalidation failed; close and reopen this project: ${String(error)}`,
        ),
      )
    return { directory, sessions: ids.size, files, warnings: resultWarnings, safetyPath }
  } finally {
    try {
      if (!committed) {
        for (const target of moved.reverse()) rmSync(target, { recursive: true, force: true })
        for (const [original, saved] of preserved.reverse()) renameSync(saved, original)
        if (created) rmdirSync(directory)
      }
    } catch (error) {
      recovered = false
      throw new Error(
        `Migration rollback needs manual recovery; preserve ${journal} and its staging paths. ${String(error)}`,
      )
    } finally {
      await Promise.all([
        reader?.close(),
        handle?.close(),
        recovered && stage ? fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) : undefined,
        recovered && dataStage
          ? fs.rm(dataStage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          : undefined,
        lock.close().then(() => (recovered ? fs.rm(journal, { force: true }) : undefined)),
      ]).catch((error: unknown) => {
        if (!committed) throw error
        resultWarnings.push(
          `Migration committed, but temporary-file cleanup needs attention at ${journal}: ${String(error)}`,
        )
      })
    }
  }
}

export * as ProjectBackup from "./backup"
