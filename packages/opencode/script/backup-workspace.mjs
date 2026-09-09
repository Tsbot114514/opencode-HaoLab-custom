#!/usr/bin/env node
import fs from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import path from "node:path"
import os from "node:os"
import { parseArgs } from "node:util"
import { Readable, Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"

const help = `Independent workspace backup (Node.js 24+; installed workspace dependencies required)
Usage: node script/backup-workspace.mjs --directory <workspace> --output <existing-parent>
  --connection <sidecar.json>  Local desktop API connection file (platform default otherwise)
  --database <database.db>     Explicit trusted source DB (default: API paths.data/opencode.db)
  --name <safe-name>           Archive basename (default: workspace)
  --max-bytes <integer>        File and aggregate uncompressed limit (default: 10737418240)
  --help                      Show this help without accessing user data
Read backup-workspace.README.md before running. Unencrypted independent format v3;
NOT an installed-application import contract. Run only with source-read authorization.
`
const tables = ["project", "session", "message", "part", "todo", "session_message"]
const excluded = new Set([".git", "node_modules", ".cache", ".next", ".turbo", "__pycache__", ".venv", "venv"])
const q = (x) => '"' + x.replaceAll('"', '""') + '"'
const normalize = (x) => (process.platform === "win32" ? path.resolve(x).toLowerCase() : path.resolve(x))
const inside = (root, file) => {
  const relative = path.relative(normalize(root), normalize(file))
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
}
const hashFile = async (file) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}
const optionalStat = (file) =>
  fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
async function regular(file, directory = false) {
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    throw new Error(`Expected non-link ${directory ? "directory" : "file"}: ${file}`)
  return fs.realpath(file)
}
function digestRows(db, table, schema, ids, insert) {
  const hash = createHash("sha256")
  const order = schema
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => q(c.name))
    .join(",")
  if (!order) throw new Error(`Table needs a primary key: ${table}`)
  const key = table === "project" || table === "session" ? "id" : "session_id"
  const select = db.prepare(
    `SELECT ${schema.map((c) => q(c.name)).join(",")} FROM ${q(table)} WHERE ${q(key)}=? ORDER BY ${order}`,
  )
  select.setReadBigInts(true)
  select.setReturnArrays(true)
  let rows = 0,
    bytes = 0,
    maxRowBytes = 0,
    maxCellBytes = 0
  for (const id of ids)
    for (const row of select.iterate(id)) {
      hash.update(`R${row.length}:`)
      let rowBytes = 0
      for (const value of row) {
        const tag =
          value === null
            ? "N"
            : typeof value === "string"
              ? "T"
              : typeof value === "bigint"
                ? "I"
                : typeof value === "number"
                  ? "F"
                  : "B"
        const data = tag === "N" ? "" : tag === "I" ? value.toString() : tag === "F" ? Buffer.allocUnsafe(8) : value
        if (tag === "F") data.writeDoubleBE(value)
        const length = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
        hash.update(`${tag}${length}:`)
        hash.update(data)
        rowBytes += length
        maxCellBytes = Math.max(maxCellBytes, length)
      }
      if (insert) insert.run(...row)
      rows++
      bytes += rowBytes
      maxRowBytes = Math.max(maxRowBytes, rowBytes)
    }
  return { rows, rawBytes: bytes, maxRowBytes, maxCellBytes, sha256: hash.digest("hex") }
}

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["directory", "output", "connection", "database", "name", "max-bytes"]
        .map((key) => [key, { type: "string" }])
        .concat([["help", { type: "boolean" }]]),
    ),
  })
  if (values.help) {
    console.log(help)
    return
  }
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required")
  if (!values.directory || !values.output) throw new Error("--directory and --output are required; see --help")
  const name = values.name ?? "workspace"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))
    throw new Error("--name must be a safe filename (letters, digits, underscore, hyphen)")
  const cap = Number(values["max-bytes"] ?? 10 * 1024 ** 3)
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("--max-bytes must be a positive safe integer")
  const target = await regular(path.resolve(values.directory), true)
  const parent = await regular(path.resolve(values.output), true)
  if (inside(target, parent)) throw new Error("Output must be outside source workspace")
  const connectionPath =
    values.connection ??
    path.join(
      process.platform === "win32"
        ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support")
          : (process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")),
      "ai.opencode.desktop",
      "sidecar.json",
    )
  await regular(connectionPath)
  const connection = await fs.readFile(connectionPath, "utf8").then((text) => {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error("Connection file contains invalid JSON")
    }
  })
  if (!connection || typeof connection.url !== "string") throw new Error("Connection file needs an API URL")
  const base = new URL(connection.url)
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    typeof connection.username !== "string" ||
    typeof connection.password !== "string"
  )
    throw new Error("Connection must describe an authenticated local API")
  async function get(route, directory = target) {
    const url = new URL(route, base)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(directory),
      },
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) throw new Error(`API HTTP ${response.status} at ${route}`)
    return response.json()
  }
  const paths = await get("/path")
  if (typeof paths.data !== "string" || !path.isAbsolute(paths.data))
    throw new Error("API data path must be an absolute local directory")
  const dataRoot = await regular(paths.data, true)
  if (inside(dataRoot, parent) || inside(dataRoot, target) || inside(target, dataRoot))
    throw new Error("Workspace/output must not overlap global application data")
  const sourceDatabase = await regular(
    values.database ? path.resolve(values.database) : path.join(dataRoot, "opencode.db"),
  )
  if (inside(target, sourceDatabase)) throw new Error("Source database cannot be inside workspace")
  if (inside(target, await fs.realpath(connectionPath))) throw new Error("Connection file cannot be inside workspace")
  const sourceSessionRoot = path.join(dataRoot, "session")
  const sourceDiffRoot = path.join(dataRoot, "storage", "session_diff")
  for (const folder of [sourceSessionRoot, path.join(dataRoot, "storage"), sourceDiffRoot]) {
    if (await optionalStat(folder)) await regular(folder, true)
  }
  const api = await get("/session")
  if (!Array.isArray(api)) throw new Error("Invalid API session list")
  const { DatabaseSync } = await import("node:sqlite")
  const zip = createRequire(import.meta.url)("@zip.js/zip.js")
  zip.configure({ useWebWorkers: false })
  const started = Date.now()
  const warnings = [
    "SQLite rows share a read snapshot; filesystem metadata checks are not an atomic volume snapshot.",
    "Global credentials, session_share, event journals and unrelated sessions are excluded. Workspace and session files may still contain secrets.",
  ]
  const source = new DatabaseSync(sourceDatabase, { readOnly: true })
  let output
  try {
    source.exec("BEGIN")
    const sessionRows = source.prepare("SELECT id,directory,project_id,time_updated FROM session").all()
    const selected = sessionRows
      .filter((s) => path.isAbsolute(s.directory) && inside(target, s.directory))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const scopedApi = api.filter((s) => typeof s.directory === "string" && inside(target, s.directory))
    if (
      !selected.length ||
      !scopedApi.length ||
      scopedApi.some(
        (s) =>
          !selected.some(
            (r) =>
              r.id === s.id && normalize(r.directory) === normalize(s.directory) && r.time_updated === s.time?.updated,
          ),
      )
    )
      throw new Error(
        "API session IDs/directories/update times do not match database; explicit --database may be required",
      )
    const sessionIds = selected.map((s) => s.id)
    if (sessionIds.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("Unsafe session ID")
    const projectIds = [...new Set(selected.map((s) => s.project_id))].sort()
    const directories = [...new Set([target, ...selected.map((s) => s.directory)])]
    async function idle() {
      for (const directory of directories) {
        const status = await get("/session/status", directory)
        if (!status || typeof status !== "object" || Array.isArray(status))
          throw new Error("Invalid API status response")
        for (const [id, state] of Object.entries(status)) {
          if (state?.type === "idle") continue
          // Some servers return global statuses. Resolve unknown/new IDs rather than ignoring them.
          const session =
            sessionRows.find((s) => s.id === id) ?? (await get(`/session/${encodeURIComponent(id)}`, directory))
          if (typeof session.directory !== "string") throw new Error("Cannot resolve active session scope")
          if (inside(target, session.directory))
            throw new Error("Source or descendant has active sessions; backup refused")
        }
      }
    }
    await idle()
    const evidence = {
      sourceDatabase,
      apiDataRoot: dataRoot,
      liveTotalSessions: sessionRows.length,
      apiSessionsMatched: scopedApi.length,
      selectionSessions: selected.length,
      comparedFields: ["id", "directory", "time_updated"],
      checkedIdleAt: new Date().toISOString(),
    }
    const schema = Object.fromEntries(tables.map((t) => [t, source.prepare(`PRAGMA table_info(${q(t)})`).all()]))
    const ddl = Object.fromEntries(
      tables.map((t) => [t, source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t)?.sql]),
    )
    const preflight = {}
    for (const t of tables) {
      if (!ddl[t] || !schema[t].some((c) => c.pk)) throw new Error(`Unsupported source schema: ${t}`)
      const expression = schema[t].map((c) => `COALESCE(length(CAST(${q(c.name)} AS BLOB)),0)`).join("+")
      const stmt = source.prepare(
        `SELECT COUNT(*) rows, COALESCE(SUM(${expression}),0) bytes, COALESCE(MAX(${expression}),0) maxRowBytes FROM ${q(t)} WHERE ${q(t === "project" || t === "session" ? "id" : "session_id")}=?`,
      )
      preflight[t] = { rows: 0, bytes: 0, maxRowBytes: 0 }
      for (const id of t === "project" ? projectIds : sessionIds) {
        const row = stmt.get(id)
        preflight[t].rows += row.rows
        preflight[t].bytes += row.bytes
        preflight[t].maxRowBytes = Math.max(preflight[t].maxRowBytes, row.maxRowBytes)
      }
    }
    if (Object.values(preflight).reduce((sum, t) => sum + t.bytes, 0) > cap)
      throw new Error("Database raw bytes exceed aggregate cap")
    const files = [],
      folders = [],
      excludedPaths = [],
      missingSessionFolders = [],
      missingDiffs = []
    let totalBytes = 0
    async function walk(file, entry) {
      const stat = await fs.lstat(file)
      if (excluded.has(path.basename(file).toLowerCase()) && (stat.isDirectory() || stat.isSymbolicLink())) {
        excludedPaths.push(entry)
        return
      }
      if (stat.isSymbolicLink()) throw new Error(`Links are not supported: ${entry}`)
      if (stat.isDirectory()) {
        folders.push(entry + "/")
        for (const child of (await fs.readdir(file)).sort()) {
          if (child.includes("\\")) throw new Error("Backslash filenames are not portable ZIP paths")
          await walk(path.join(file, child), entry + "/" + child)
        }
        return
      }
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`Non-regular or hard-linked file: ${entry}`)
      totalBytes += stat.size
      if (stat.size > cap || totalBytes > cap) throw new Error("Filesystem payload exceeds cap")
      files.push({ source: file, path: entry, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
    }
    await walk(target, "workspace")
    for (const id of sessionIds) {
      const folder = path.join(sourceSessionRoot, id)
      if (await optionalStat(folder)) {
        await regular(folder, true)
        await walk(folder, `sessions/${id}`)
      }
      else missingSessionFolders.push(id)
      const diff = path.join(sourceDiffRoot, id + ".json")
      if (await optionalStat(diff)) {
        await regular(diff)
        await walk(diff, `diffs/${id}.json`)
      }
      else missingDiffs.push(id)
    }
    const marker = files.find((f) => f.path === "workspace/.opencode-project.json")
    if (marker?.bytes > 4096) throw new Error("Identity marker oversized")
    const identity = marker
      ? JSON.parse(await fs.readFile(marker.source, "utf8"))
      : { identity: randomUUID(), name: path.basename(target) }
    if (
      !identity ||
      typeof identity.identity !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.identity) ||
      typeof identity.name !== "string" ||
      !identity.name.length
    )
      throw new Error("Invalid identity marker")
    if (!marker) warnings.push("Generated identity exists only in backup; source marker was not written.")
    if (missingSessionFolders.length)
      warnings.push(
        `${missingSessionFolders.length} sessions have no source session directory; recorded, not fabricated.`,
      )
    if (missingDiffs.length)
      warnings.push(`${missingDiffs.length} sessions have no source diff file; recorded, not fabricated.`)
    output = await fs.mkdtemp(path.join(parent, `${name}-${new Date(started).toISOString().replace(/[:.]/g, "-")}-`))
    const databaseFile = path.join(output, "sessions.sqlite")
    const dest = new DatabaseSync(databaseFile)
    const captured = {}
    try {
      dest.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; BEGIN")
      // Only trusted SOURCE table DDL, never SQL supplied by an archive. No triggers copied.
      for (const t of tables) dest.exec(ddl[t])
      for (const t of tables) {
        const insert = dest.prepare(
          `INSERT INTO ${q(t)} (${schema[t].map((c) => q(c.name)).join(",")}) VALUES (${schema[t].map(() => "?").join(",")})`,
        )
        captured[t] = digestRows(source, t, schema[t], t === "project" ? projectIds : sessionIds, insert)
        if (captured[t].rows !== preflight[t].rows) throw new Error(`Preflight count mismatch: ${t}`)
        console.log(JSON.stringify({ phase: "table-copied", table: t, ...captured[t] }))
      }
      dest.exec("COMMIT")
    } finally {
      dest.close()
    }
    source.exec("ROLLBACK")
    function verifyDatabase(file) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        if (
          db
            .prepare("PRAGMA quick_check")
            .all()
            .some((r) => r.quick_check !== "ok") ||
          db.prepare("PRAGMA foreign_key_check").all().length
        )
          throw new Error("SQLite integrity check failed")
        for (const t of tables) {
          if (
            db.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n !== captured[t].rows ||
            JSON.stringify(digestRows(db, t, schema[t], t === "project" ? projectIds : sessionIds)) !==
              JSON.stringify(captured[t])
          )
            throw new Error(`Raw count/hash mismatch: ${t}`)
        }
      } finally {
        db.close()
      }
    }
    verifyDatabase(databaseFile)
    const database = {
      path: "sessions.sqlite",
      bytes: (await fs.stat(databaseFile)).size,
      sha256: await hashFile(databaseFile),
      tables: Object.fromEntries(tables.map((t) => [t, captured[t].rows])),
      checksums: captured,
      schema: ddl,
    }
    totalBytes += database.bytes
    if (totalBytes > cap) throw new Error("Aggregate uncompressed payload exceeds cap")
    const manifest = {
      format: "opencode-project",
      version: 3,
      transport: "sqlite",
      directory: target,
      sourceSessionRoot,
      platform: process.platform,
      package: {
        identity: identity.identity,
        name: identity.name,
        createdAt: started,
        sessions: sessionIds.length,
        messages: captured.message.rows,
        parts: captured.part.rows,
      },
      database,
      sessionIds,
      counts: {
        sessions: sessionIds.length,
        messages: captured.message.rows,
        parts: captured.part.rows,
        todos: captured.todo.rows,
        sessionMessages: captured.session_message.rows,
        workspaceFiles: files.filter((f) => f.path.startsWith("workspace/")).length + (marker ? 0 : 1),
        sessionFiles: files.filter((f) => f.path.startsWith("sessions/")).length,
        sessionFolders: sessionIds.length - missingSessionFolders.length,
        diffFiles: files.filter((f) => f.path.startsWith("diffs/")).length,
      },
      warnings,
      metadata: {
        sourceDatabase,
        sourceDiffRoot,
        snapshotEvidence: evidence,
        excludedDirectories: [...excluded],
        ordinaryFileMaxBytes: cap,
        aggregateMaxBytes: cap,
        identityGenerated: !marker,
        hashFormat: "framed-cells-v1",
        nativePreflight: preflight,
      },
    }
    const manifestText = JSON.stringify(manifest, null, 2)
    await fs.writeFile(path.join(output, "manifest.json"), manifestText, { flag: "wx" })
    const final = path.join(output, `${name}.opencode-project.zip`)
    const partial = final + ".partial"
    const out = createWriteStream(partial, { flags: "wx" })
    const writer = new zip.ZipWriter(Writable.toWeb(out), { useWebWorkers: false, level: 1 })
    const expected = new Map()
    for (const entry of folders) {
      await writer.add(entry, undefined, { directory: true })
      expected.set(entry, { bytes: 0, directory: true })
    }
    async function addText(entry, text) {
      const bytes = Buffer.byteLength(text)
      totalBytes += bytes
      if (totalBytes > cap) throw new Error("Metadata exceeds aggregate cap")
      await writer.add(entry, new zip.TextReader(text))
      expected.set(entry, { bytes, sha256: createHash("sha256").update(text).digest("hex") })
    }
    await addText("manifest.json", manifestText)
    if (!marker) await addText("workspace/.opencode-project.json", JSON.stringify(identity, null, 2))
    const dbstat = await fs.stat(databaseFile)
    for (const item of [
      {
        source: databaseFile,
        path: "sessions.sqlite",
        bytes: dbstat.size,
        mtimeMs: dbstat.mtimeMs,
        ctimeMs: dbstat.ctimeMs,
      },
      ...files,
    ]) {
      const before = await fs.lstat(item.source)
      if (
        !before.isFile() ||
        before.nlink > 1 ||
        before.size !== item.bytes ||
        before.mtimeMs !== item.mtimeMs ||
        before.ctimeMs !== item.ctimeMs
      )
        throw new Error(`File changed before archive: ${item.path}`)
      const hash = createHash("sha256")
      let bytes = 0
      const stream = Readable.toWeb(createReadStream(item.source)).pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            hash.update(chunk)
            bytes += chunk.byteLength
            controller.enqueue(chunk)
          },
        }),
      )
      await writer.add(item.path, stream, { lastModDate: before.mtime })
      const after = await fs.lstat(item.source)
      if (
        bytes !== item.bytes ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error(`File changed during archive: ${item.path}`)
      item.sha256 = hash.digest("hex")
      expected.set(item.path, { bytes, sha256: item.sha256 })
      if (item.path === "sessions.sqlite" && item.sha256 !== database.sha256)
        throw new Error("Manifest database hash mismatch")
    }
    await writer.close()
    await finished(out)
    class FileReader extends zip.Reader {
      constructor(handle, size) {
        super()
        this.handle = handle
        this.size = size
      }
      async readUint8Array(index, length) {
        if (
          !Number.isSafeInteger(index) ||
          !Number.isSafeInteger(length) ||
          index < 0 ||
          length < 0 ||
          index + length > this.size
        )
          throw new Error("Invalid ZIP read")
        const buffer = new Uint8Array(length)
        let offset = 0
        while (offset < length) {
          const { bytesRead } = await this.handle.read(buffer, offset, length - offset, index + offset)
          if (!bytesRead) throw new Error("Short ZIP read")
          offset += bytesRead
        }
        return buffer
      }
    }
    const handle = await fs.open(partial, "r")
    const reader = new zip.ZipReader(new FileReader(handle, (await handle.stat()).size), {
      useWebWorkers: false,
      checkSignature: true,
    })
    const extracted = path.join(output, "verified-extracted-sessions.sqlite")
    let verified = 0
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        const match = expected.get(entry.filename)
        if (!match || entry.directory !== !!match.directory) throw new Error("Unexpected/duplicate ZIP entry")
        if (!entry.directory) {
          const hash = createHash("sha256")
          let bytes = 0
          const dbout = entry.filename === "sessions.sqlite" ? await fs.open(extracted, "wx") : null
          try {
            await entry.getData(
              new WritableStream({
                async write(chunk) {
                  hash.update(chunk)
                  bytes += chunk.byteLength
                  if (dbout) {
                    let offset = 0
                    while (offset < chunk.byteLength) {
                      const result = await dbout.write(chunk, offset, chunk.byteLength - offset)
                      if (!result.bytesWritten) throw new Error("Short extraction write")
                      offset += result.bytesWritten
                    }
                  }
                },
              }),
              { checkSignature: true, useWebWorkers: false },
            )
            if (dbout) await dbout.sync()
          } finally {
            if (dbout) await dbout.close()
          }
          if (bytes !== match.bytes || hash.digest("hex") !== match.sha256)
            throw new Error(`ZIP hash mismatch: ${entry.filename}`)
        }
        expected.delete(entry.filename)
        verified++
      }
    } finally {
      await reader.close()
      await handle.close()
    }
    if (expected.size || (await hashFile(extracted)) !== database.sha256)
      throw new Error("ZIP incomplete or extracted database hash mismatch")
    verifyDatabase(extracted)
    await idle()
    for (const item of files) {
      const stat = await fs.lstat(item.source)
      if (
        !stat.isFile() ||
        stat.nlink > 1 ||
        stat.size !== item.bytes ||
        stat.mtimeMs !== item.mtimeMs ||
        stat.ctimeMs !== item.ctimeMs
      )
        throw new Error(`Source file changed after archive: ${item.path}`)
    }
    const report = {
      success: true,
      archive: final,
      archiveBytes: (await fs.stat(partial)).size,
      archiveSha256: await hashFile(partial),
      output,
      createdAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds: (Date.now() - started) / 1000,
      evidence,
      counts: manifest.counts,
      database,
      uncompressedBytes: totalBytes,
      zipEntriesVerified: verified,
      verification: {
        snapshotReadOnly: true,
        quickCheck: true,
        foreignKeyCheck: true,
        sourceVsDestinationRowsAndFramedCellHashes: true,
        fullZipCRC: true,
        allEntrySha256: true,
        extractedDatabaseQuickCheck: true,
        extractedDatabaseRowsAndHashes: true,
        manifestDatabaseSha256: true,
        sourceFileMetadataStable: true,
        targetIdleBeforeAndAfter: true,
      },
      missingSessionFolders,
      missingDiffs,
      excludedPaths,
      warnings,
      files: files.map(({ source, ctimeMs, ...file }) => file),
    }
    await fs.writeFile(final + ".report.json", JSON.stringify(report, null, 2), { flag: "wx" })
    // Unique private output directory prevents collisions; final archive appears only after verification.
    if (await optionalStat(final)) throw new Error("Refusing existing destination")
    await fs.rename(partial, final)
    console.log(
      JSON.stringify({
        phase: "SUCCESS",
        archive: final,
        report: final + ".report.json",
        archiveSha256: report.archiveSha256,
      }),
    )
  } catch (error) {
    if (output)
      await fs
        .writeFile(path.join(output, "FAILED.json"), JSON.stringify({ success: false, error: error.message }), {
          flag: "wx",
        })
        .catch(() => {})
    throw error
  } finally {
    source.close()
  }
}

main().catch((error) => {
  console.error(`BACKUP_FAILED: ${error.message}`)
  process.exitCode = 1
})
