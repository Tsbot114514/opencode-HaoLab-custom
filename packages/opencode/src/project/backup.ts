import fs from "node:fs/promises"
import { mkdirSync, renameSync, rmSync, rmdirSync, existsSync, writeFileSync, fsyncSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { Writable } from "node:stream"
import { createReadStream, createWriteStream } from "node:fs"
import { Reader, ZipReader, ZipWriter, TextReader, type Entry } from "@zip.js/zip.js"
import { Database as SQLite } from "#sqlite"
import { getTableColumns, sql } from "drizzle-orm"
import { z } from "zod"
import { Database } from "@/storage/db"
import { SessionTable, MessageTable, PartTable, TodoTable, SessionMessageTable } from "@/session/session.sql"
import { Global } from "@opencode-ai/core/global"
import type { Project } from "./project"
import { ProjectTable } from "./project.sql"

const tableNames = ["project", "session", "message", "part", "todo", "session_message"] as const
type TableName = (typeof tableNames)[number]
type Cell = string | number | bigint | Uint8Array | null
type Row = Record<string, Cell>
const tableConfig: Record<
  TableName,
  {
    required: readonly string[]
    allowed: ReadonlySet<string>
    order: readonly string[]
    primaryKey: readonly string[]
    foreignKeys: readonly { from: string; table: TableName; to: string; onDelete: string }[]
  }
> = {
  project: {
    required: ["id", "worktree", "time_created", "time_updated", "sandboxes"],
    allowed: new Set(Object.keys(getTableColumns(ProjectTable))),
    order: ["id"],
    primaryKey: ["id"],
    foreignKeys: [],
  },
  session: {
    required: ["id", "project_id", "slug", "directory", "title", "version", "time_created", "time_updated"],
    allowed: new Set(Object.keys(getTableColumns(SessionTable))),
    order: ["id"],
    primaryKey: ["id"],
    foreignKeys: [{ from: "project_id", table: "project", to: "id", onDelete: "CASCADE" }],
  },
  message: {
    required: ["id", "session_id", "time_created", "time_updated", "data"],
    allowed: new Set(Object.keys(getTableColumns(MessageTable))),
    order: ["session_id", "id"],
    primaryKey: ["id"],
    foreignKeys: [{ from: "session_id", table: "session", to: "id", onDelete: "CASCADE" }],
  },
  part: {
    required: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
    allowed: new Set(Object.keys(getTableColumns(PartTable))),
    order: ["session_id", "id"],
    primaryKey: ["id"],
    foreignKeys: [{ from: "message_id", table: "message", to: "id", onDelete: "CASCADE" }],
  },
  todo: {
    required: ["session_id", "content", "status", "priority", "position", "time_created", "time_updated"],
    allowed: new Set(Object.keys(getTableColumns(TodoTable))),
    order: ["session_id", "position"],
    primaryKey: ["session_id", "position"],
    foreignKeys: [{ from: "session_id", table: "session", to: "id", onDelete: "CASCADE" }],
  },
  session_message: {
    required: ["id", "session_id", "type", "time_created", "time_updated", "data"],
    allowed: new Set(Object.keys(getTableColumns(SessionMessageTable))),
    order: ["session_id", "id"],
    primaryKey: ["id"],
    foreignKeys: [{ from: "session_id", table: "session", to: "id", onDelete: "CASCADE" }],
  },
}
const identitySchema = z.object({ identity: z.string().uuid(), name: z.string().min(1).max(200) })
const markerName = ".opencode-project.json"
const summarySchema = z.object({
  filesUpdatedAt: z.number().nullable(),
  sessionsUpdatedAt: z.number().nullable(),
  files: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
})
const packageSchema = identitySchema.extend({
  createdAt: z.number().finite(),
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  parts: z.number().int().nonnegative(),
})
const countSchema = z.object({
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  parts: z.number().int().nonnegative(),
  todos: z.number().int().nonnegative(),
  sessionMessages: z.number().int().nonnegative(),
  workspaceFiles: z.number().int().nonnegative(),
  sessionFiles: z.number().int().nonnegative(),
  sessionFolders: z.number().int().nonnegative(),
  diffFiles: z.number().int().nonnegative(),
})
const checksumSchema = z.object({
  rows: z.number().int().nonnegative(),
  rawBytes: z.number().int().nonnegative(),
  maxRowBytes: z.number().int().nonnegative(),
  maxCellBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const tableRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.object(Object.fromEntries(tableNames.map((name) => [name, value])) as Record<TableName, T>)
const manifestSchema = z.object({
  format: z.literal("opencode-project"),
  version: z.literal(3),
  transport: z.literal("sqlite"),
  directory: z.string(),
  sourceSessionRoot: z.string(),
  platform: z.enum(["win32", "darwin", "linux"]),
  package: packageSchema,
  database: z.object({
    path: z.literal("sessions.sqlite"),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    tables: tableRecord(z.number().int().nonnegative()),
    checksums: tableRecord(checksumSchema),
    schema: tableRecord(z.string().min(1)),
  }),
  sessionIds: z.array(z.string()),
  counts: countSchema,
  warnings: z.array(z.string()),
  metadata: z.object({ hashFormat: z.literal("framed-cells-v1") }).passthrough(),
})
type Manifest = z.infer<typeof manifestSchema>
const maxEntries = 100_000
const maxFile = 10 * 1024 ** 3
const maxTotal = 10 * 1024 ** 3
const maxManifest = 64 * 1024 ** 2
const maxRows = 1_000_000
const maxCell = 128 * 1024 ** 2
const maxRow = 256 * 1024 ** 2
const maxJsonNodes = 1_000_000
const maxJsonDepth = 128
const excluded = new Set([".git", "node_modules", ".cache", ".next", ".turbo", "__pycache__", ".venv", "venv"])
const warnings = [
  "Git metadata, node_modules, .cache, .next, .turbo, __pycache__, .venv and venv directories are excluded. Linked Git worktrees are not supported.",
  "Snapshots are not included; restored revert pointers, sharing, workspace bindings and session permissions are reset.",
  "Only workspace and included session-folder attachment paths are remapped. External attachments are not copied. Transcript text and arbitrary tool input/output are preserved without path substitution.",
  "Project configuration, session assemble.ts and session tools/skills/plugins are quarantined in backup-disabled directories; review before enabling. Project startup commands and global permissions are not imported.",
  "Version 3 SQLite packages restore across Windows, macOS and Linux; validated source paths are mapped to local destination paths.",
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

async function secureChild(root: string, ...segments: string[]) {
  const target = path.join(root, ...segments)
  if (!contains(root, target)) throw new Error("Application data path escaped its trusted root")
  let existing = target
  while (!(await exists(existing))) existing = path.dirname(existing)
  await absolute(existing)
  return target
}

async function applicationPaths() {
  // The configured root may use an OS-provided alias such as macOS /var. Trust only its canonical root.
  const data = await fs.realpath(Global.Path.data)
  await absolute(data)
  return {
    data,
    migrations: await secureChild(data, "project-migrations"),
    sessions: await secureChild(data, "session"),
    diffs: await secureChild(data, "storage", "session_diff"),
  }
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
  const registry = path.join((await applicationPaths()).migrations, "registry")
  await fs.mkdir(registry, { recursive: true, mode: 0o700 })
  await absolute(registry)
  const file = path.join(registry, `${createHash("sha256").update(directory).digest("hex")}.json`)
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ ...identity, directory }), { flag: "wx", mode: 0o600 })
  await fs.rename(temp, file)
}

type CapturedRows = Record<Exclude<TableName, "project">, Row[]>

function sessionTime(rows: CapturedRows) {
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
  const globals = await Promise.all(
    [Global.Path.data, Global.Path.config, Global.Path.state].map((item) => fs.realpath(item)),
  )
  if (globals.some((global) => contains(directory, global) || contains(global, directory)))
    throw new Error("Migration into application data or global configuration is forbidden")
  const database = Database.getPath()
  if (path.isAbsolute(database) && (await exists(database)) && contains(directory, await fs.realpath(database)))
    throw new Error("The target contains the live application database")
  if (path.dirname(directory) === directory) throw new Error("A filesystem root cannot be a migration target")
  if ((await exists(path.join(directory, ".git"))) && !(await fs.lstat(path.join(directory, ".git"))).isDirectory())
    throw new Error("Linked Git worktrees are not supported")
  return directory
}

async function localState(directory: string, wasMissing = false) {
  const application = await applicationPaths()
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
      [path.join(application.sessions, String(r.id)), `sessions/${r.id}`],
      [path.join(application.diffs, `${r.id}.json`), `diffs/${r.id}.json`],
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
    const registry = path.join((await applicationPaths()).migrations, "registry")
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
      collisions(opened.database, opened.databaseColumns, new Set(local?.rows.session.map((r) => String(r.id))))
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
      package: opened.package,
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
    const failures: unknown[] = []
    for (const cleanup of [
      () => opened.database.close(),
      () => fs.rm(opened.temp, { recursive: true, force: true }),
      () => opened.reader.close(),
      () => opened.handle.close(),
    ])
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    if (failures.length) throw new Error(`Backup inspection cleanup failed: ${failures.map(String).join("; ")}`)
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

function captureSessions(directory: string) {
  return Database.transaction((db) =>
    db
      .all<Row>(sql`SELECT * FROM session`)
      .filter((r) => typeof r.directory === "string" && contains(directory, r.directory)),
  )
}

function capture(directory: string): CapturedRows {
  return Database.transaction((db) => {
    const sessions = captureSessions(directory)
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

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

function columnType(column: string) {
  if (column === "cost") return "REAL"
  if (
    column.startsWith("time_") ||
    column.startsWith("tokens_") ||
    ["position", "summary_additions", "summary_deletions", "summary_files"].includes(column)
  )
    return "INTEGER"
  return "TEXT"
}

function columnRequired(table: TableName, column: string) {
  if (table === "project") return ["worktree", "time_created", "time_updated", "sandboxes"].includes(column)
  if (table === "session")
    return [
      "project_id",
      "slug",
      "directory",
      "title",
      "version",
      "time_created",
      "time_updated",
      "cost",
      "tokens_input",
      "tokens_output",
      "tokens_reasoning",
      "tokens_cache_read",
      "tokens_cache_write",
    ].includes(column)
  if (table === "message") return column !== "id"
  if (table === "part") return column !== "id"
  if (table === "todo") return true
  return column !== "id"
}

function columns(database: SQLite, name: TableName) {
  const result = database
    .query<
      { name: string; type: string; notnull: bigint; pk: bigint; hidden: bigint },
      []
    >(`PRAGMA table_xinfo(${quote(name)})`)
    .all()
  if (!result.length) throw new Error(`Missing SQLite table: ${name}`)
  const names = result.map((column) => column.name)
  if (new Set(names).size !== names.length) throw new Error(`Duplicate ${name} column`)
  if (names.some((column) => !tableConfig[name].allowed.has(column))) throw new Error(`Unsupported ${name} column`)
  if (tableConfig[name].required.some((column) => !names.includes(column)))
    throw new Error(`Missing required ${name} column`)
  if (result.some((column) => column.hidden !== 0n))
    throw new Error(`Hidden or generated ${name} columns are forbidden`)
  if (result.some((column) => column.type.toUpperCase() !== columnType(column.name)))
    throw new Error(`Unsupported ${name} column type`)
  if (result.some((column) => (column.notnull !== 0n) !== columnRequired(name, column.name)))
    throw new Error(`Unsupported ${name} column nullability`)
  const primaryKey = result
    .filter((column) => column.pk)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name)
  if (JSON.stringify(primaryKey) !== JSON.stringify(tableConfig[name].primaryKey))
    throw new Error(`Unsupported ${name} primary key`)
  const foreignKeys = database
    .query<{ from: string; table: string; to: string; on_delete: string }, []>(
      `PRAGMA foreign_key_list(${quote(name)})`,
    )
    .all()
    .map((key) => ({ from: key.from, table: key.table, to: key.to, onDelete: key.on_delete }))
    .sort((a, b) => a.from.localeCompare(b.from))
  if (
    JSON.stringify(foreignKeys) !==
    JSON.stringify([...tableConfig[name].foreignKeys].sort((a, b) => a.from.localeCompare(b.from)))
  )
    throw new Error(`Unsupported ${name} foreign keys`)
  return names
}

function orderedRows(database: SQLite, name: TableName, names: readonly string[]) {
  return database
    .query<
      Row,
      []
    >(`SELECT ${names.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${tableConfig[name].order.map(quote).join(",")}`)
    .iterate()
}

function checksum(database: SQLite, name: TableName, names: readonly string[]) {
  const hash = createHash("sha256")
  let rows = 0
  let rawBytes = 0
  let maxRowBytes = 0
  let maxCellBytes = 0
  let unsafeInteger = false
  for (const row of orderedRows(database, name, names)) {
    if (rows >= maxRows) throw new Error(`SQLite ${name} row count exceeds the safety limit`)
    hash.update(`R${names.length}:`)
    let rowBytes = 0
    for (const column of names) {
      const value = row[column]
      const encoded = (() => {
        if (value === null) return { tag: "N", bytes: Buffer.alloc(0) }
        if (typeof value === "string") return { tag: "T", bytes: Buffer.from(value) }
        if (typeof value === "bigint") {
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) unsafeInteger = true
          return { tag: "I", bytes: Buffer.from(value.toString()) }
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) throw new Error(`SQLite ${name}.${column} contains a non-finite real`)
          const bytes = Buffer.allocUnsafe(8)
          bytes.writeDoubleBE(value)
          return { tag: "F", bytes }
        }
        return { tag: "B", bytes: Buffer.from(value) }
      })()
      if (encoded.bytes.length > maxCell) throw new Error(`SQLite ${name}.${column} cell exceeds the safety limit`)
      hash.update(`${encoded.tag}${encoded.bytes.length}:`)
      hash.update(encoded.bytes)
      rowBytes += encoded.bytes.length
      maxCellBytes = Math.max(maxCellBytes, encoded.bytes.length)
    }
    rows++
    rawBytes += rowBytes
    if (rowBytes > maxRow) throw new Error(`SQLite ${name} row exceeds the safety limit`)
    maxRowBytes = Math.max(maxRowBytes, rowBytes)
  }
  return {
    result: { rows, rawBytes, maxRowBytes, maxCellBytes, sha256: hash.digest("hex") },
    unsafeInteger,
  }
}

function openSQLite(file: string) {
  const database = new SQLite(file, { readonly: true, strict: true, safeIntegers: true })
  try {
    // Bun does not expose SQLite's immutable URI flag. The private copy has no sidecars and is still constrained twice.
    database.run("PRAGMA query_only = ON")
    database.run("PRAGMA trusted_schema = OFF")
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function verifyDatabase(file: string, manifest?: Manifest) {
  const database = openSQLite(file)
  try {
    const quick = database.query<Record<string, string>, []>("PRAGMA quick_check").all()
    if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") throw new Error("SQLite quick_check failed")
    if (database.query("PRAGMA foreign_key_check").all().length) throw new Error("SQLite foreign key check failed")
    const objects = database
      .query<
        { type: string; name: string; tbl_name: string; sql: string | null },
        []
      >("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type = 'table' ORDER BY type,name")
      .all()
    const schemas = Object.fromEntries(
      objects.filter((object) => object.type === "table").map((object) => [object.name, object.sql]),
    ) as Record<string, string | null>
    if (
      objects.some((object) => object.type !== "table") ||
      Object.keys(schemas).length !== tableNames.length ||
      tableNames.some((name) => typeof schemas[name] !== "string")
    )
      throw new Error("SQLite contains unexpected schema objects")
    const tableColumns = Object.fromEntries(tableNames.map((name) => [name, columns(database, name)])) as Record<
      TableName,
      string[]
    >
    if (
      manifest &&
      tableNames.some(
        (name) =>
          manifest.database.tables[name] > maxRows ||
          manifest.database.checksums[name].rows > maxRows ||
          manifest.database.checksums[name].maxCellBytes > maxCell ||
          manifest.database.checksums[name].maxRowBytes > maxRow ||
          manifest.database.checksums[name].rawBytes > maxTotal,
      )
    )
      throw new Error("SQLite manifest descriptors exceed safety limits")
    const checksums = Object.fromEntries(
      tableNames.map((name) => [name, checksum(database, name, tableColumns[name])]),
    ) as Record<TableName, ReturnType<typeof checksum>>
    const tables = Object.fromEntries(tableNames.map((name) => [name, checksums[name].result.rows])) as Record<
      TableName,
      number
    >
    const sessionIds: string[] = []
    let sessionsUpdatedAt: number | null = null
    for (const row of orderedRows(database, "session", tableColumns.session)) {
      if (typeof row.id !== "string" || !/^ses_[a-zA-Z0-9_-]+$/.test(row.id)) throw new Error("Invalid session ID")
      sessionIds.push(row.id)
      for (const key of ["time_updated", "time_created", "time_archived"]) {
        const value = row[key]
        if (
          typeof value === "bigint" &&
          value <= BigInt(Number.MAX_SAFE_INTEGER) &&
          value >= BigInt(Number.MIN_SAFE_INTEGER)
        )
          sessionsUpdatedAt = Math.max(sessionsUpdatedAt ?? 0, Number(value))
      }
    }
    if (new Set(sessionIds).size !== sessionIds.length) throw new Error("Duplicate session ID")
    if (manifest) {
      for (const name of tableNames) {
        if (manifest.database.schema[name] !== schemas[name]) throw new Error(`SQLite ${name} schema mismatch`)
        if (manifest.database.tables[name] !== tables[name]) throw new Error(`SQLite ${name} count mismatch`)
        if (JSON.stringify(manifest.database.checksums[name]) !== JSON.stringify(checksums[name].result))
          throw new Error(`SQLite ${name} checksum mismatch`)
      }
      if (tableNames.some((name) => checksums[name].unsafeInteger))
        throw new Error("SQLite integer is outside the JavaScript safe integer range")
      if (JSON.stringify(manifest.sessionIds) !== JSON.stringify(sessionIds))
        throw new Error("Session ID list mismatch")
      const expected = {
        sessions: tables.session,
        messages: tables.message,
        parts: tables.part,
        todos: tables.todo,
        sessionMessages: tables.session_message,
      }
      for (const [key, value] of Object.entries(expected))
        if (manifest.counts[key as keyof typeof expected] !== value) throw new Error(`Manifest ${key} count mismatch`)
      if (
        manifest.package.sessions !== tables.session ||
        manifest.package.messages !== tables.message ||
        manifest.package.parts !== tables.part
      )
        throw new Error("Package database counts do not match")
      if (
        database
          .query("SELECT 1 FROM session s LEFT JOIN project p ON p.id=s.project_id WHERE p.id IS NULL LIMIT 1")
          .get()
      )
        throw new Error("Session references a missing project")
      if (
        database
          .query(
            "SELECT 1 FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE m.id IS NULL LIMIT 1",
          )
          .get()
      )
        throw new Error("Orphan or cross-session part")
    }
    return {
      database,
      columns: tableColumns,
      tables,
      checksums: Object.fromEntries(
        tableNames.map((name) => [name, checksums[name].result]),
      ) as Manifest["database"]["checksums"],
      schema: schemas as Manifest["database"]["schema"],
      sessionIds,
      sessionsUpdatedAt,
    }
  } catch (error) {
    database.close()
    throw error
  }
}

function sourcePaths(manifest: Manifest) {
  const api = manifest.platform === "win32" ? path.win32 : path.posix
  const valid = (value: string, label: string) => {
    if (value.includes("\0")) throw new Error(`Invalid ${label}`)
    if (manifest.platform === "win32") {
      if (/^(?:\\\\|\/\/|\\\\[?.]\\)/.test(value) || !/^[a-zA-Z]:\\/.test(value)) throw new Error(`Invalid ${label}`)
    } else if (!api.isAbsolute(value)) throw new Error(`Invalid ${label}`)
    if (api.normalize(value) !== value || api.dirname(value) === value) throw new Error(`Invalid ${label}`)
    return value
  }
  const directory = valid(manifest.directory, "source directory")
  const sessions = valid(manifest.sourceSessionRoot, "source session root")
  const fold = (value: string) => (manifest.platform === "win32" ? value.toLowerCase() : value)
  const containsSource = (root: string, target: string) => {
    const relative = api.relative(root, target)
    return relative === "" || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative))
  }
  if (containsSource(directory, sessions) || containsSource(sessions, directory))
    throw new Error("Source workspace and session roots must not overlap")
  const relative = (root: string, target: string, label: string) => {
    valid(target, label)
    if (!containsSource(fold(root), fold(target))) throw new Error(`${label} outside archive scope`)
    const value = api.relative(root, target)
    const segments = value ? value.split(api.sep) : []
    if (
      segments.some(
        (part) =>
          /[<>:"|?*\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
            part,
          ),
      )
    )
      throw new Error(`Unsafe ${label}`)
    return segments
  }
  return {
    api,
    directory,
    sessions,
    fold,
    contains: (root: string, target: string) => containsSource(fold(root), fold(target)),
    relative,
  }
}

function json(value: string, label: string) {
  if (Buffer.byteLength(value) > maxCell) throw new Error(`${label} JSON exceeds the safety limit`)
  const parsed: unknown = JSON.parse(value)
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()!
    if (++nodes > maxJsonNodes || current.depth > maxJsonDepth) throw new Error(`${label} JSON is too complex`)
    if (!current.value || typeof current.value !== "object") continue
    for (const item of Array.isArray(current.value) ? current.value : Object.values(current.value))
      pending.push({ value: item, depth: current.depth + 1 })
  }
  return parsed
}

function validateRows(
  database: SQLite,
  tableColumns: Record<TableName, string[]>,
  source: ReturnType<typeof sourcePaths>,
) {
  const paths = new Map<string, string[]>()
  const parents = new Map<string, string | null>()
  const todos = new Set<string>()
  const jsonColumns: Partial<Record<TableName, ReadonlySet<string>>> = {
    project: new Set(["sandboxes", "commands"]),
    session: new Set(["summary_diffs", "revert", "permission", "model"]),
    message: new Set(["data"]),
    part: new Set(["data"]),
    session_message: new Set(["data"]),
  }
  for (const name of tableNames) {
    for (const row of orderedRows(database, name, tableColumns[name])) {
      for (const column of tableColumns[name]) {
        const value = row[column]
        if (value === null) {
          if (columnRequired(name, column)) throw new Error(`SQLite ${name}.${column} must not be null`)
          continue
        }
        const validType =
          columnType(column) === "INTEGER"
            ? typeof value === "bigint" &&
              value <= BigInt(Number.MAX_SAFE_INTEGER) &&
              value >= BigInt(Number.MIN_SAFE_INTEGER)
            : columnType(column) === "REAL"
              ? typeof value === "number" && Number.isFinite(value)
              : typeof value === "string"
        if (!validType) throw new Error(`SQLite ${name}.${column} has an invalid storage class`)
        if (typeof value === "string" && columnRequired(name, column) && !value.length)
          throw new Error(`SQLite ${name}.${column} must not be empty`)
        if (typeof value === "string" && jsonColumns[name]?.has(column)) {
          const parsed = json(value, `SQLite ${name}.${column}`)
          if (column === "sandboxes" && (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")))
            throw new Error("SQLite project.sandboxes must be a string array")
          if (
            ["data", "commands", "revert", "model"].includes(column) &&
            (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          )
            throw new Error(`SQLite ${name}.${column} must contain a JSON object`)
          if (["summary_diffs", "permission"].includes(column) && !Array.isArray(parsed))
            throw new Error(`SQLite ${name}.${column} must contain a JSON array`)
        }
      }
      for (const column of ["id", "project_id", "session_id", "message_id", "parent_id"]) {
        const value = row[column]
        if (
          value !== undefined &&
          value !== null &&
          (typeof value !== "string" || !value.length || value.length > 1024 || value.includes("\0"))
        )
          throw new Error(`SQLite ${name}.${column} contains an invalid ID`)
      }
      if (name === "todo") {
        const key = `${String(row.session_id)}\0${String(row.position)}`
        if (todos.has(key)) throw new Error("SQLite todo contains a duplicate composite key")
        todos.add(key)
      }
      if (name !== "session") continue
      const id = String(row.id)
      if (!/^ses_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID")
      paths.set(id, source.relative(source.directory, String(row.directory), "session directory"))
      parents.set(id, row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id))
    }
  }
  for (const id of parents.keys()) {
    const seen = new Set<string>()
    for (let current: string | null = id; current && parents.has(current); current = parents.get(current) ?? null) {
      if (seen.has(current)) throw new Error("Session parent cycle")
      seen.add(current)
    }
  }
  if (
    database.query("SELECT 1 FROM part WHERE session_id NOT IN (SELECT id FROM session) LIMIT 1").get() ||
    database.query("SELECT 1 FROM todo GROUP BY session_id,position HAVING count(*) <> 1 LIMIT 1").get()
  )
    throw new Error("Invalid cross-table session data")
  return paths
}

function createBackupDatabase(directory: string, file: string) {
  return Database.transaction((db) => {
    const sessions = captureSessions(directory)
    const output = new SQLite(file, { create: true, strict: true })
    try {
      output.run("PRAGMA foreign_keys = ON")
      const schemas = Object.fromEntries(
        tableNames.map((name) => {
          const found = db.get<{ sql: string }>(
            sql`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ${name}`,
          )
          if (!found?.sql) throw new Error(`Missing live ${name} schema`)
          return [name, found.sql]
        }),
      ) as Record<TableName, string>
      for (const name of tableNames) output.run(schemas[name])
      const projects = [...new Set(sessions.map((row) => String(row.project_id)))].map((id) => {
        const found = db.get<Row>(sql`SELECT * FROM project WHERE id = ${id}`)
        if (!found) throw new Error(`Session references missing project: ${id}`)
        return found
      })
      const insert = (name: TableName, row: Row) => {
        const names = Object.keys(row)
        output
          .query(
            `INSERT INTO ${quote(name)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row))
      }
      output.transaction(() => {
        for (const row of projects) insert("project", row)
        for (const row of sessions) insert("session", row)
        for (const name of ["message", "part", "todo", "session_message"] as const)
          for (const session of sessions)
            for (const row of db.all<Row>(sql`SELECT * FROM ${sql.identifier(name)} WHERE session_id = ${session.id}`))
              insert(name, row)
      })()
      return sessions
    } finally {
      output.close()
    }
  })
}

export async function backup(input: {
  directory: string
  path: string
  active?: ReadonlySet<string>
  safetyIdentity?: z.infer<typeof identitySchema>
}) {
  const application = await applicationPaths()
  const present = await exists(input.directory)
  const directory =
    !present && input.safetyIdentity ? await destination(input.directory) : await absolute(input.directory)
  if (present && !(await fs.stat(directory)).isDirectory()) throw new Error("Source must be a directory")
  if (!path.isAbsolute(input.path)) throw new Error("Archive path must be absolute")
  const output = path.join(await absolute(path.dirname(input.path)), path.basename(input.path))
  if (contains(directory, output)) throw new Error("Archive must not be inside the source directory")
  const globals = await Promise.all(
    [Global.Path.data, Global.Path.config, Global.Path.state].map((item) => fs.realpath(item)),
  )
  if (globals.some((global) => contains(directory, global) || contains(global, directory)))
    throw new Error("Backing up application data or global configuration is forbidden")
  if (await exists(output)) throw new Error("Archive destination already exists")
  const database = Database.getPath()
  if (path.isAbsolute(database) && (await exists(database)) && contains(directory, await fs.realpath(database)))
    throw new Error("The source contains the live application database")
  const rows = captureSessions(directory)
  if (rows.some((r) => input.active?.has(String(r.id)))) throw new Error("Stop active sessions before backing up")
  const identity =
    (await marker(directory, !input.safetyIdentity)) ??
    (input.safetyIdentity ? identitySchema.parse(input.safetyIdentity) : undefined)
  if (!identity) throw new Error("Could not establish project migration identity")
  if (!input.safetyIdentity) await register(directory, identity)
  const temp = await fs.mkdtemp(path.join(path.dirname(output), ".opencode-backup-"))
  const sqlite = path.join(temp, "sessions.sqlite")
  let verified: ReturnType<typeof verifyDatabase> | undefined
  let manifest: Manifest
  try {
    createBackupDatabase(directory, sqlite)
    verified = verifyDatabase(sqlite)
    if (verified.sessionIds.some((id) => input.active?.has(id)))
      throw new Error("Stop active sessions before backing up")
    manifest = {
      format: "opencode-project",
      version: 3,
      transport: "sqlite",
      directory,
      sourceSessionRoot: application.sessions,
      platform: process.platform as "win32" | "darwin" | "linux",
      package: {
        ...identity,
        createdAt: Date.now(),
        sessions: verified.tables.session,
        messages: verified.tables.message,
        parts: verified.tables.part,
      },
      database: {
        path: "sessions.sqlite",
        bytes: (await fs.stat(sqlite)).size,
        sha256: await fileHash(sqlite),
        tables: verified.tables,
        checksums: verified.checksums,
        schema: verified.schema,
      },
      sessionIds: verified.sessionIds,
      counts: {
        sessions: verified.tables.session,
        messages: verified.tables.message,
        parts: verified.tables.part,
        todos: verified.tables.todo,
        sessionMessages: verified.tables.session_message,
        workspaceFiles: 0,
        sessionFiles: 0,
        sessionFolders: 0,
        diffFiles: 0,
      },
      warnings: [...warnings],
      metadata: { hashFormat: "framed-cells-v1" },
    }
    verified.database.close()
  } catch (error) {
    verified?.database.close()
    await fs.rm(temp, { recursive: true, force: true })
    throw error
  }
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
    } finally {
      await handle.close()
    }
  }
  try {
    await add(sqlite, "sessions.sqlite")
    if (present) await add(directory, "workspace")
    else await zip.add("workspace/", undefined, { directory: true })
    if (input.safetyIdentity) {
      await zip.add(`workspace/${markerName}`, new TextReader(JSON.stringify(identity)), { useWebWorkers: false })
      files++
    }
    for (const id of manifest.sessionIds) {
      safeName(id)
      if (id.includes("/")) throw new Error("Invalid session ID")
      const local = await secureChild(application.sessions, id)
      if (await exists(local)) {
        manifest.counts.sessionFolders++
        const before = files
        await add(local, `sessions/${id}`)
        manifest.counts.sessionFiles += files - before
      }
      const diff = await secureChild(application.diffs, `${id}.json`)
      if (await exists(diff)) {
        await add(diff, `diffs/${id}.json`)
        manifest.counts.diffFiles++
      }
    }
    manifest.counts.workspaceFiles = files - 1 - manifest.counts.sessionFiles - manifest.counts.diffFiles
    const text = JSON.stringify(manifest)
    if (Buffer.byteLength(text) > maxManifest) throw new Error("Session data exceeds the 64 MiB manifest limit")
    if (total + Buffer.byteLength(text) > maxTotal) throw new Error("Archive size limit exceeded")
    await zip.add("manifest.json", new TextReader(text), { useWebWorkers: false })
    await zip.close()
    if (!input.safetyIdentity && JSON.stringify(await marker(directory)) !== JSON.stringify(identity))
      throw new Error("Project identity changed during export; retry")
    await fs.link(target, output)
    return { path: output, sessions: manifest.sessionIds.length, files: files - 1, warnings: manifest.warnings }
  } finally {
    stream.destroy()
    await fs.rm(temp, { recursive: true, force: true })
  }
}

function validateScope(manifest: Manifest, database: SQLite, tableColumns: Record<TableName, string[]>) {
  const source = sourcePaths(manifest)
  const sessionPaths = validateRows(database, tableColumns, source)
  if (
    database
      .query("SELECT 1 FROM project p WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.project_id=p.id) LIMIT 1")
      .get()
  )
    throw new Error("SQLite contains an unrelated project row")
  return { source, sessionPaths }
}

function collisions(imported: SQLite, importedColumns: Record<TableName, string[]>, replace = new Set<string>()) {
  Database.use((db) => {
    for (const name of ["session", "message", "part", "session_message"] as const) {
      let batch: string[] = []
      for (const r of orderedRows(imported, name, importedColumns[name])) {
        batch.push(String(r.id))
        if (batch.length < 500) continue
        check(batch)
        batch = []
      }
      check(batch)
      function check(ids: string[]) {
        if (!ids.length) return
        const existing = db.all<{ id: string; session_id: string }>(
          sql`SELECT id, ${sql.identifier(name === "session" ? "id" : "session_id")} AS session_id FROM ${sql.identifier(name)} WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        const collision = existing.find((row) => !replace.has(row.session_id))
        if (collision) throw new Error(`ID collision in ${name}: ${collision.id}`)
      }
    }
    let batch: string[] = []
    for (const r of orderedRows(imported, "session", importedColumns.session)) {
      if (!replace.has(String(r.id))) batch.push(String(r.id))
      if (batch.length < 500) continue
      checkEvents(batch)
      batch = []
    }
    checkEvents(batch)
    function checkEvents(ids: string[]) {
      if (!ids.length) return
      const collision = db.get<{ aggregate_id: string }>(
        sql`SELECT aggregate_id FROM event_sequence WHERE aggregate_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}) LIMIT 1`,
      )
      if (collision) throw new Error(`Event aggregate collision: ${collision.aggregate_id}`)
    }
  })
}

async function openPackage(archive: string) {
  const handle = await fs.open(archive, "r")
  let reader: ZipReader<fs.FileHandle> | undefined
  let temp: string | undefined
  let imported: SQLite | undefined
  try {
    const stat = await handle.stat()
    reader = new ZipReader(new FileReader(handle, stat.size), { useWebWorkers: false })
    if (!stat.isFile() || stat.size > maxTotal + maxEntries * 4096)
      throw new Error("Archive must be a regular file within the size limit")
    const entries: Entry[] = []
    const seen = new Set<string>()
    const files = new Set<string>()
    const prefixes = new Map<string, string>()
    let total = 0
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= maxEntries) throw new Error("Too many archive entries")
      entries.push(entry)
      const name = safeName(entry.filename)
      if (seen.has(name.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`)
      seen.add(name.toLowerCase())
      const parts = name.split("/")
      for (let index = 1; index < parts.length; index++)
        if (files.has(parts.slice(0, index).join("/").toLowerCase()))
          throw new Error(`Archive file/directory prefix conflict: ${name}`)
      if (!entry.directory && prefixes.has(name.toLowerCase()))
        throw new Error(`Archive file/directory prefix conflict: ${name}`)
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
      if (!entry.directory) files.add(name.toLowerCase())
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
    sourcePaths(manifest)
    const ids = new Set(manifest.sessionIds)
    const sqliteEntry = entries.find((entry) => entry.filename === "sessions.sqlite")
    if (!sqliteEntry?.getData || sqliteEntry.directory) throw new Error("Missing sessions.sqlite")
    if (sqliteEntry.uncompressedSize !== manifest.database.bytes) throw new Error("SQLite byte count mismatch")
    for (const entry of entries) {
      if (entry === meta) continue
      const parts = safeName(entry.filename).split("/")
      if (
        entry !== sqliteEntry &&
        !(parts[0] === "workspace" && (entry.directory || parts.length > 1)) &&
        !(parts[0] === "sessions" && ids.has(parts[1]) && (entry.directory || parts.length > 2)) &&
        !(parts[0] === "diffs" && parts.length === 2 && parts[1].endsWith(".json") && ids.has(parts[1].slice(0, -5)))
      )
        throw new Error(`Unexpected archive entry: ${entry.filename}`)
      if (parts.some((p) => p.toLowerCase() === ".git"))
        throw new Error("Git metadata is not supported in this archive version")
    }
    const regular = entries.filter((entry) => entry !== meta && entry !== sqliteEntry && !entry.directory)
    const workspaceFiles = regular.filter((entry) => entry.filename.startsWith("workspace/")).length
    const sessionFiles = regular.filter((entry) => entry.filename.startsWith("sessions/")).length
    const diffFiles = regular.filter((entry) => entry.filename.startsWith("diffs/")).length
    const sessionFolders = new Set(
      entries
        .filter((entry) => entry.filename.startsWith("sessions/"))
        .map((entry) => safeName(entry.filename).split("/")[1]),
    ).size
    if (
      manifest.counts.workspaceFiles !== workspaceFiles ||
      manifest.counts.sessionFiles !== sessionFiles ||
      manifest.counts.diffFiles !== diffFiles ||
      manifest.counts.sessionFolders !== sessionFolders ||
      manifest.package.sessions !== ids.size
    )
      throw new Error("Package file counts do not match its contents")
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-package-"))
    const databaseFile = path.join(temp, "sessions.sqlite")
    const stream = createWriteStream(databaseFile, { flags: "wx", mode: 0o600 })
    const hash = createHash("sha256")
    let databaseBytes = 0
    const bound = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        databaseBytes += chunk.length
        if (databaseBytes > manifest.database.bytes) throw new Error("SQLite exceeded declared size")
        hash.update(chunk)
        controller.enqueue(chunk)
      },
    })
    const writing = bound.readable.pipeTo(Writable.toWeb(stream))
    try {
      await Promise.all([sqliteEntry.getData(bound.writable, { checkSignature: true }), writing])
    } finally {
      stream.destroy()
    }
    if (databaseBytes !== manifest.database.bytes || hash.digest("hex") !== manifest.database.sha256) {
      throw new Error("SQLite bytes or SHA-256 mismatch")
    }
    const verified = verifyDatabase(databaseFile, manifest)
    imported = verified.database
    const scope = validateScope(manifest, verified.database, verified.columns)
    if (
      (await exists(`${databaseFile}-wal`)) ||
      (await exists(`${databaseFile}-shm`)) ||
      (await exists(`${databaseFile}-journal`))
    )
      throw new Error("SQLite verification created a forbidden sidecar")
    let filesUpdatedAt: number | null = null
    let sessionsUpdatedAt = verified.sessionsUpdatedAt
    for (const entry of entries) {
      const time = entry.lastModDate?.getTime()
      if (entry.directory || time === undefined || !Number.isFinite(time)) continue
      if (entry.filename.startsWith("workspace/") && entry.filename !== `workspace/${markerName}`)
        filesUpdatedAt = Math.max(filesUpdatedAt ?? 0, time)
      if (entry.filename.startsWith("sessions/") || entry.filename.startsWith("diffs/"))
        sessionsUpdatedAt = Math.max(sessionsUpdatedAt ?? 0, time)
    }
    return {
      reader,
      handle,
      entries,
      meta,
      sqliteEntry,
      manifest,
      database: verified.database,
      databaseColumns: verified.columns,
      source: scope.source,
      sessionPaths: scope.sessionPaths,
      temp,
      package: {
        ...manifest.package,
        filesUpdatedAt,
        sessionsUpdatedAt,
        files: regular.length,
        sessions: verified.tables.session,
      },
    }
  } catch (error) {
    const cleanup: unknown[] = []
    try {
      imported?.close()
    } catch (failure) {
      cleanup.push(failure)
    }
    for (const close of [
      () => (temp ? fs.rm(temp, { recursive: true, force: true }) : undefined),
      () => reader?.close(),
      () => handle.close(),
    ])
      try {
        await close()
      } catch (failure) {
        cleanup.push(failure)
      }
    if (cleanup.length) throw new Error(`${String(error)}; package cleanup failed: ${cleanup.map(String).join("; ")}`)
    throw error
  }
}

// Only known structured path fields are remapped. Never replace strings in transcripts.
function remap(
  value: unknown,
  roots: readonly { source: string; destination: string }[],
  source: ReturnType<typeof sourcePaths>,
  assistant = false,
  state = { nodes: 0 },
  depth = 0,
): unknown {
  if (++state.nodes > maxJsonNodes || depth > maxJsonDepth) throw new Error("Structured path data is too complex")
  if (Array.isArray(value)) return value.map((x) => remap(x, roots, source, false, state, depth + 1))
  if (!value || typeof value !== "object") return value
  const mapped = (input: string) => {
    const root = roots.find((root) => source.contains(root.source, input))
    if (!root) return
    const relative = source.api.relative(root.source, input)
    return path.join(root.destination, ...relative.split(source.api.sep).filter(Boolean))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // V2 assistant content contains typed tools; only those contain attachment metadata.
      if (assistant && key === "content" && Array.isArray(item))
        return [
          key,
          item.map((part: unknown) =>
            part && typeof part === "object" && "type" in part && part.type === "tool"
              ? remap(part, roots, source, false, state, depth + 1)
              : part,
          ),
        ]
      if (["input", "output", "structured", "text", "content"].includes(key)) return [key, item]
      if (key === "url" && typeof item === "string" && item.startsWith("file:")) {
        if (!URL.canParse(item)) return [key, item]
        const url = new URL(item)
        if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return [key, item]
        const decoded = (() => {
          try {
            return decodeURIComponent(url.pathname)
          } catch {
            return
          }
        })()
        if (decoded === undefined) return [key, item]
        const file =
          source.api === path.win32 ? decoded.replace(/^\/([a-zA-Z]:\/)/, "$1").replaceAll("/", "\\") : decoded
        const output = mapped(file)
        if (output) return [key, pathToFileURL(output).href]
      }
      if (
        ["directory", "cwd", "root", "file", "filePath", "filepath", "path", "filename"].includes(key) &&
        typeof item === "string" &&
        source.api.isAbsolute(item)
      ) {
        const output = mapped(item)
        if (output) return [key, output]
      }
      return [key, remap(item, roots, source, false, state, depth + 1)]
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
  const application = await applicationPaths()
  await fs.mkdir(application.migrations, { recursive: true, mode: 0o700 })
  await absolute(application.migrations)
  const journal = path.join(application.migrations, "apply.lock")
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
  let imported: SQLite | undefined
  let importedTemp: string | undefined
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
    const { entries, meta, sqliteEntry, manifest, databaseColumns, source, sessionPaths } = opened
    imported = opened.database
    importedTemp = opened.temp
    const replacing = new Set(previous.rows.session.map((r) => String(r.id)))
    collisions(imported, databaseColumns, replacing)
    if (previous.replace) {
      safetyPath = path.join(application.migrations, `safety-${Date.now()}-${crypto.randomUUID()}.zip`)
      record("safety-backup")
      await backup({ directory, path: safetyPath, safetyIdentity: manifest.package })
      await check()
    }
    const ids = new Set(manifest.sessionIds)
    const roots = [
      ...[...ids].map((id) => ({
        source: source.api.join(manifest.sourceSessionRoot, id),
        destination: path.join(application.sessions, id),
      })),
      { source: manifest.directory, destination: directory },
    ]
    for (const id of ids) {
      for (const target of [
        await secureChild(application.sessions, id),
        await secureChild(application.diffs, `${id}.json`),
      ]) {
        if (!replacing.has(id) && (await exists(target))) throw new Error(`Session storage collision: ${id}`)
      }
    }
    // Session storage can be on another volume: stage it beside its final home.
    if (ids.size || replacing.size)
      dataStage = await fs.mkdtemp(path.join(await absolute(application.data), ".project-restore-"))
    const state = dataStage ?? stage
    record("staging")
    let files = 0
    for (const entry of entries) {
      if (entry === meta || entry === sqliteEntry) continue
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
    const transformRow = (name: Exclude<TableName, "project">, original: Row) => {
      const r = Object.fromEntries(
        Object.entries(original).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]),
      ) as Row
      if (name === "session") {
        const relative = sessionPaths.get(String(r.id))
        if (!relative) throw new Error(`Missing validated session path: ${String(r.id)}`)
        r.directory = path.join(directory, ...relative)
        r.project_id = project.id
        r.path = path.relative(project.worktree, String(r.directory)).replaceAll("\\", "/")
        r.parent_id = ids.has(String(r.parent_id)) ? r.parent_id : null
        for (const key of ["workspace_id", "permission", "revert", "share_url", "time_compacting"])
          if (databaseColumns.session.includes(key)) r[key] = null
      }
      for (const key of name === "session" ? ["summary_diffs"] : ["data"])
        if (typeof r[key] === "string")
          r[key] = JSON.stringify(
            remap(JSON.parse(r[key]), roots, source, name === "session_message" && r.type === "assistant"),
          )
      return r
    }
    for (const original of orderedRows(imported, "session", databaseColumns.session)) {
      const r = transformRow("session", original)
      const folder = path.join(state, "sessions", String(r.id))
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(
        path.join(folder, "metadata.json"),
        JSON.stringify(
          {
            id: r.id,
            project_id: r.project_id,
            parent_id: r.parent_id,
            directory: r.directory,
            path: r.path,
            title: r.title,
            session_local_tools: { path: path.join(application.sessions, String(r.id), "tool", "README.md") },
            time: { created: r.time_created, updated: r.time_updated, archived: r.time_archived },
          },
          null,
          2,
        ),
      )
    }
    for (const id of ids) {
      const diff = path.join(state, "diffs", `${id}.json`)
      if (await exists(diff))
        await fs.writeFile(diff, JSON.stringify(remap(JSON.parse(await fs.readFile(diff, "utf8")), roots, source)))
    }
    const workspace = path.join(stage, "workspace")
    const moves = (await fs.readdir(workspace)).map((name) => [path.join(workspace, name), path.join(directory, name)])
    for (const id of ids) {
      moves.push([path.join(state, "sessions", id), path.join(application.sessions, id)])
      if (await exists(path.join(state, "diffs", `${id}.json`)))
        moves.push([path.join(state, "diffs", `${id}.json`), path.join(application.diffs, `${id}.json`)])
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
        [path.join(application.sessions, id), path.join(state, "previous-sessions", id)],
        [path.join(application.diffs, `${id}.json`), path.join(state, "previous-diffs", `${id}.json`)],
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
        collisions(imported!, databaseColumns, replacing)
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
        for (const name of ["session", "message", "part", "todo", "session_message"] as const) {
          for (const original of orderedRows(imported!, name, databaseColumns[name])) {
            const r = transformRow(name, original)
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
    const failures: unknown[] = []
    try {
      if (!committed) {
        for (const target of moved.reverse()) rmSync(target, { recursive: true, force: true })
        for (const [original, saved] of preserved.reverse()) renameSync(saved, original)
        if (created) rmdirSync(directory)
      }
    } catch (error) {
      recovered = false
      failures.push(error)
    }
    const cleanup = async (run: () => void | Promise<void>) => {
      try {
        await run()
      } catch (error) {
        recovered = false
        failures.push(error)
      }
    }
    await cleanup(() => imported?.close())
    await cleanup(() => reader?.close())
    await cleanup(() => handle?.close())
    if (recovered && importedTemp) {
      const target = importedTemp
      await cleanup(() => fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    }
    if (recovered && stage) {
      const target = stage
      await cleanup(() => fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    }
    if (recovered && dataStage) {
      const target = dataStage
      await cleanup(() => fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    }
    await cleanup(() => lock.close())
    if (recovered) await cleanup(() => fs.rm(journal, { force: true }))
    if (failures.length && !committed)
      throw new Error(
        `Migration rollback needs manual recovery; preserve ${journal} and its staging paths. ${failures.map(String).join("; ")}`,
      )
    if (failures.length)
      resultWarnings.push(
        `Migration committed, but temporary-file cleanup needs attention at ${journal}: ${failures.map(String).join("; ")}`,
      )
  }
}

export * as ProjectBackup from "./backup"
