import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Database as SQLite } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { BlobReader, BlobWriter, ZipReader, ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js"
import { ProjectBackup as Backend } from "@/project/backup"
import { Project } from "@/project/project"
import { Database, sql } from "@/storage/db"
import { Global } from "@opencode-ai/core/global"
import { tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Project.defaultLayer, CrossSpawnSpawner.defaultLayer))
// Legacy archive-safety cases also go through the mandatory preview flow.
const ProjectBackup = {
  ...Backend,
  restore: async (input: Omit<Parameters<typeof Backend.restore>[0], "previewToken" | "overwrite">) => {
    const preview = await Backend.inspect(input)
    if (!preview.previewToken) throw new Error("Expected a target preview")
    return Backend.restore({ ...input, previewToken: preview.previewToken, overwrite: false })
  },
}
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

async function fixtureArchive(root: string) {
  const source = path.join(root, `source-${crypto.randomUUID()}`)
  const archive = path.join(root, `${crypto.randomUUID()}.zip`)
  await fs.mkdir(source)
  await Backend.backup({ directory: source, path: archive })
  return { source, archive }
}

async function rewriteArchive(
  archive: string,
  mutate: (manifest: Record<string, unknown>) => void,
  additions: readonly string[] = [],
  mutateDatabase?: (database: SQLite) => void,
) {
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(await fs.readFile(archive))])), {
    useWebWorkers: false,
  })
  const entries = await Promise.all(
    (await reader.getEntries()).map(async (entry) => ({
      name: entry.filename,
      directory: entry.directory,
      data: entry.getData ? await entry.getData(new BlobWriter(), { useWebWorkers: false }) : undefined,
    })),
  )
  const metadata = entries.find((entry) => entry.name === "manifest.json")
  if (!metadata?.data) throw new Error("Fixture manifest is missing")
  const manifest = JSON.parse(await metadata.data.text()) as Record<string, unknown>
  mutate(manifest)
  if (mutateDatabase) {
    const entry = entries.find((entry) => entry.name === "sessions.sqlite")
    if (!entry?.data) throw new Error("Fixture SQLite is missing")
    const file = path.join(path.dirname(archive), `${crypto.randomUUID()}.sqlite`)
    await fs.writeFile(file, Buffer.from(await entry.data.arrayBuffer()))
    const database = new SQLite(file, { strict: true, safeIntegers: true })
    mutateDatabase(database)
    database.close()
    entry.data = new Blob([Uint8Array.from(await fs.readFile(file))])
    await updateDatabaseManifest(manifest, file, entry.data)
    await fs.rm(file)
  }
  const writer = new ZipWriter(new BlobWriter())
  for (const entry of entries) {
    if (entry.directory) {
      await writer.add(entry.name, undefined, { directory: true })
      continue
    }
    if (!entry.data) throw new Error("Fixture ZIP entry has no data")
    await writer.add(
      entry.name,
      entry.name === "manifest.json" ? new TextReader(JSON.stringify(manifest)) : new BlobReader(entry.data),
      { useWebWorkers: false },
    )
  }
  for (const name of additions) await writer.add(name, new TextReader("evil"), { useWebWorkers: false })
  const output = path.join(path.dirname(archive), `${crypto.randomUUID()}.zip`)
  await fs.writeFile(output, Buffer.from(await (await writer.close()).arrayBuffer()))
  await reader.close()
  return output
}

async function updateDatabaseManifest(manifest: Record<string, unknown>, file: string, blob: Blob) {
  const descriptor = manifest.database as Record<string, unknown>
  const database = new SQLite(file, { readonly: true, strict: true, safeIntegers: true })
  const checksums = descriptor.checksums as Record<string, unknown>
  const tables = descriptor.tables as Record<string, number>
  const schema = descriptor.schema as Record<string, string>
  for (const name of ["project", "session", "message", "part", "todo", "session_message"]) {
    schema[name] = database
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
      .get(name)!.sql
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info("${name}")`)
      .all()
      .map((item) => item.name)
    const order =
      name === "project" || name === "session" ? "id" : name === "todo" ? "session_id,position" : "session_id,id"
    const hash = createHash("sha256")
    let rows = 0
    let rawBytes = 0
    let maxRowBytes = 0
    let maxCellBytes = 0
    for (const row of database
      .query<
        Record<string, string | number | bigint | Uint8Array | null>,
        []
      >(`SELECT ${columns.map((column) => `"${column}"`).join(",")} FROM "${name}" ORDER BY ${order}`)
      .iterate()) {
      hash.update(`R${columns.length}:`)
      let rowBytes = 0
      for (const column of columns) {
        const value = row[column]
        const encoded = (() => {
          if (value === null) return { tag: "N", bytes: Buffer.alloc(0) }
          if (typeof value === "string") return { tag: "T", bytes: Buffer.from(value) }
          if (typeof value === "bigint") return { tag: "I", bytes: Buffer.from(value.toString()) }
          if (typeof value === "number") {
            const bytes = Buffer.allocUnsafe(8)
            bytes.writeDoubleBE(value)
            return { tag: "F", bytes }
          }
          return { tag: "B", bytes: Buffer.from(value) }
        })()
        hash.update(`${encoded.tag}${encoded.bytes.length}:`)
        hash.update(encoded.bytes)
        rowBytes += encoded.bytes.length
        maxCellBytes = Math.max(maxCellBytes, encoded.bytes.length)
      }
      rows++
      rawBytes += rowBytes
      maxRowBytes = Math.max(maxRowBytes, rowBytes)
    }
    tables[name] = rows
    checksums[name] = { rows, rawBytes, maxRowBytes, maxCellBytes, sha256: hash.digest("hex") }
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  descriptor.bytes = bytes.length
  descriptor.sha256 = createHash("sha256").update(bytes).digest("hex")
  database.close()
}

describe("project archive", () => {
  test("portable names reject traversal, device names, ADS and ambiguous names", () => {
    for (const name of [
      "../escape",
      "/absolute",
      "a\\b",
      "a/../b",
      "a//b",
      "a:stream",
      "NUL.txt",
      "COM1",
      "a. ",
      "a/./b",
      "a\u0000b",
    ])
      expect(() => ProjectBackup.safeName(name)).toThrow("Unsafe archive path")
    expect(ProjectBackup.safeName(".hidden/sub/file.txt")).toBe(".hidden/sub/file.txt")
  })

  test("directory scope does not match sibling prefixes", () => {
    expect(ProjectBackup.contains(path.resolve("source"), path.resolve("source/child"))).toBe(true)
    expect(ProjectBackup.contains(path.resolve("source"), path.resolve("source-other"))).toBe(false)
  })

  it.live(
    "roundtrip includes children, archives, both message formats and local state without importing permissions",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const service = yield* Project.Service
        const source = path.join(root, "source")
        const dest = path.join(root, "destination")
        yield* Effect.promise(() => Promise.all([fs.mkdir(source), fs.mkdir(dest)]))
        const project = yield* service.fromDirectory(source)
        yield* Effect.promise(async () => {
          const suffix = crypto.randomUUID().replaceAll("-", "")
          const parent = `ses_backup${suffix}`
          const child = `ses_child${suffix}`
          const outside = `ses_outside${suffix}`
          const mid = `msg_${suffix}`
          const pid = `prt_${suffix}`
          const v2 = `v2_${suffix}`
          const archive = path.join(root, "backup.zip")
          const local = (id: string) => path.join(Global.Path.data, "session", id)
          const diff = path.join(Global.Path.data, "storage", "session_diff", `${parent}.json`)
          const resolveProject = (directory: string) =>
            Effect.runPromise(service.fromDirectory(directory)).then((r) => r.project)
          try {
            await fs.mkdir(path.join(source, "child"))
            await fs.mkdir(path.join(source, "node_modules"))
            await fs.writeFile(path.join(source, ".hidden"), "hidden")
            await fs.writeFile(path.join(source, "node_modules", "ignored"), "dependency")
            await fs.writeFile(path.join(source, "opencode.json"), '{"permission":"allow","plugin":["evil"]}')
            await fs.writeFile(path.join(source, "child", "opencode.json"), '{"permission":"allow"}')
            await fs.mkdir(path.join(local(parent), "tool"), { recursive: true })
            await fs.writeFile(path.join(local(parent), "tool", "example.ts"), "throw new Error('do not run')")
            await fs.writeFile(path.join(local(parent), "notes.json"), '{"assemble":true,"content":"original"}')
            await fs.writeFile(path.join(local(parent), "metadata.json"), '{"directory":"old"}')
            await fs.mkdir(path.dirname(diff), { recursive: true })
            await fs.writeFile(diff, JSON.stringify([{ file: path.join(source, "file.txt") }]))
            Database.use((db) => {
              for (const [id, directory, parentID, archived] of [
                [parent, source, null, null],
                [child, path.join(source, "child"), parent, 123],
                [outside, `${source}-other`, null, null],
              ] as const)
                db.run(
                  sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,parent_id,time_archived,permission,revert) VALUES (${id},${project.project.id},'test',${directory},'Backup test','1',1,1,${parentID},${archived},'[{"permission":"*","pattern":"*","action":"allow"}]','{"snapshot":"missing"}')`,
                )
              db.run(
                sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${mid},${parent},1,1,${JSON.stringify({ role: "assistant", path: { cwd: source, root: source } })})`,
              )
              db.run(
                sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${pid},${mid},${parent},1,1,${JSON.stringify({ type: "text", text: source })})`,
              )
              db.run(
                sql`INSERT INTO todo (session_id,content,status,priority,position,time_created,time_updated) VALUES (${child},'task','pending','high',0,1,1)`,
              )
              db.run(
                sql`INSERT INTO session_message (id,session_id,type,time_created,time_updated,data) VALUES (${v2},${child},'text',1,1,'{"text":"v2 transcript"}')`,
              )
            })
            await expect(
              ProjectBackup.backup({ directory: source, path: archive, active: new Set([child]) }),
            ).rejects.toThrow("active sessions")
            const result = await ProjectBackup.backup({ directory: source, path: archive })
            expect(result.sessions).toBe(2)
            expect(result.warnings.length).toBeGreaterThan(0)
            await expect(ProjectBackup.restore({ path: archive, directory: dest, resolveProject })).rejects.toThrow(
              "ID collision",
            )
            expect(await fs.readdir(dest)).toEqual([])
            Database.use((db) => {
              db.run(sql`DELETE FROM session WHERE id IN (${parent}, ${child})`)
            })
            await expect(ProjectBackup.restore({ path: archive, directory: dest, resolveProject })).rejects.toThrow(
              "storage collision",
            )
            expect(await fs.readdir(dest)).toEqual([])
            await fs.rm(local(parent), { recursive: true, force: true })
            await fs.rm(diff)
            const restored = await ProjectBackup.restore({ path: archive, directory: dest, resolveProject })
            expect(restored.sessions).toBe(2)
            expect(restored.files).toBe(result.files)
            expect(await fs.readFile(path.join(dest, ".hidden"), "utf8")).toBe("hidden")
            expect(await exists(path.join(dest, "node_modules"))).toBe(false)
            expect(await exists(path.join(dest, "opencode.json"))).toBe(false)
            expect(await exists(path.join(dest, "backup-disabled", "opencode.json"))).toBe(true)
            expect(await exists(path.join(dest, "child", "opencode.json"))).toBe(false)
            expect(await exists(path.join(local(parent), "tool"))).toBe(false)
            expect(await exists(path.join(local(parent), "backup-disabled", "tool", "example.ts"))).toBe(true)
            expect(JSON.parse(await fs.readFile(path.join(local(parent), "metadata.json"), "utf8")).directory).toBe(
              dest,
            )
            Database.use((db) => {
              const restored = db.get<Record<string, unknown>>(sql`SELECT * FROM session WHERE id = ${child}`)
              expect(restored?.directory).toBe(path.join(dest, "child"))
              expect(restored?.time_archived).toBe(123)
              expect(restored?.parent_id).toBe(parent)
              expect(restored?.permission).toBeNull()
              expect(restored?.revert).toBeNull()
              expect(db.get(sql`SELECT * FROM todo WHERE session_id = ${child}`)).toBeDefined()
              expect(db.get(sql`SELECT * FROM session_message WHERE id = ${v2}`)).toBeDefined()
              expect(db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = ${pid}`)?.data).toContain(
                source.replaceAll("\\", "\\\\"),
              )
              expect(
                JSON.parse(db.get<{ data: string }>(sql`SELECT data FROM message WHERE id = ${mid}`)?.data ?? "null")
                  .path.cwd,
              ).toBe(dest)
              expect(
                db.get<{ directory: string }>(sql`SELECT directory FROM session WHERE id = ${outside}`)?.directory,
              ).toBe(`${source}-other`)
            })
            expect(JSON.parse(await fs.readFile(diff, "utf8"))[0].file).toBe(path.join(dest, "file.txt"))
          } finally {
            Database.use((db) => db.run(sql`DELETE FROM session WHERE id IN (${parent},${child},${outside})`))
            await Promise.all([parent, child].map((id) => fs.rm(local(id), { recursive: true, force: true })))
            await fs.rm(diff, { force: true })
          }
        })
      }),
  )

  test("backup refuses inside-source archive, linked worktrees and symlinks", async () => {
    await using root = await tmpdir()
    const source = path.join(root.path, "source")
    await fs.mkdir(source)
    await expect(ProjectBackup.backup({ directory: source, path: path.join(source, "archive.zip") })).rejects.toThrow(
      "inside",
    )
    await fs.writeFile(path.join(source, ".git"), "gitdir: ../private")
    await expect(
      ProjectBackup.backup({ directory: source, path: path.join(root.path, "archive.zip") }),
    ).rejects.toThrow("Linked Git")
    await fs.rm(path.join(source, ".git"))
    await fs.symlink(root.path, path.join(source, "link"), "junction")
    await expect(
      ProjectBackup.backup({ directory: source, path: path.join(root.path, "archive.zip") }),
    ).rejects.toThrow("Links")
    expect((await fs.readdir(root.path)).sort()).toEqual(["source"])
  })

  test("inspect rejects destination and archive parents containing symlinks", async () => {
    await using root = await tmpdir()
    const fixture = await fixtureArchive(root.path)
    const real = path.join(root.path, "real")
    const link = path.join(root.path, "linked")
    await fs.mkdir(real)
    await fs.symlink(real, link, "junction")
    await expect(Backend.backup({ directory: link, path: path.join(root.path, "source-link.zip") })).rejects.toThrow(
      "Symbolic links",
    )
    await expect(Backend.backup({ directory: fixture.source, path: path.join(link, "archive.zip") })).rejects.toThrow(
      "Symbolic links",
    )
    await expect(Backend.inspect({ path: fixture.archive, directory: link })).rejects.toThrow("Symbolic links")
    await expect(Backend.inspect({ path: fixture.archive, directory: path.join(link, "child") })).rejects.toThrow(
      "Symbolic links",
    )
    const archiveLink = path.join(root.path, "archive-link")
    await fs.symlink(root.path, archiveLink, "junction")
    await expect(Backend.inspect({ path: path.join(archiveLink, path.basename(fixture.archive)) })).rejects.toThrow(
      "Symbolic links",
    )
  })

  it.live("rejects hostile SQLite row values before destination mutation", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const service = yield* Project.Service
      const source = path.join(root, "source")
      const destination = path.join(root, "destination")
      yield* Effect.promise(() => Promise.all([fs.mkdir(source), fs.mkdir(destination)]))
      const project = yield* service.fromDirectory(source)
      yield* Effect.promise(async () => {
        const id = `ses_hostile${crypto.randomUUID().replaceAll("-", "")}`
        const message = `msg_${id}`
        const archive = path.join(root, "rows.zip")
        try {
          Database.use((db) => {
            db.run(
              sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},${project.project.id},'test',${source},'test','1',1,1)`,
            )
            db.run(
              sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${message},${id},1,1,'{"role":"user"}')`,
            )
          })
          await Backend.backup({ directory: source, path: archive })
          const deep = Array.from({ length: 130 }).reduce<Record<string, unknown>>((value) => ({ value }), {})
          const cases: readonly [string, (database: SQLite) => void][] = [
            ["invalid JSON", (database) => database.query("UPDATE message SET data='{' WHERE id=?").run(message)],
            [
              "overly deep JSON",
              (database) => database.query("UPDATE message SET data=? WHERE id=?").run(JSON.stringify(deep), message),
            ],
            [
              "unsafe integer",
              (database) => database.query("UPDATE session SET time_updated=? WHERE id=?").run(9007199254740993n, id),
            ],
            ["parent cycle", (database) => database.query("UPDATE session SET parent_id=id WHERE id=?").run(id)],
            [
              "invalid parent ID",
              (database) => database.query("UPDATE session SET parent_id=? WHERE id=?").run("bad\0parent", id),
            ],
            [
              "non-normalized directory",
              (database) => database.query("UPDATE session SET directory=? WHERE id=?").run(`${source}/child/..`, id),
            ],
            [
              "NUL session directory",
              (database) => database.query("UPDATE session SET directory=? WHERE id=?").run(`${source}\0child`, id),
            ],
            [
              "portable colon component",
              (database) => database.query("UPDATE session SET directory=? WHERE id=?").run(`${source}/bad:name`, id),
            ],
            [
              "portable device component",
              (database) => database.query("UPDATE session SET directory=? WHERE id=?").run(`${source}/NUL.txt`, id),
            ],
            [
              "portable trailing-dot component",
              (database) => database.query("UPDATE session SET directory=? WHERE id=?").run(`${source}/child.`, id),
            ],
            ["empty required text", (database) => database.query("UPDATE session SET title='' WHERE id=?").run(id)],
            [
              "wrong storage class",
              (database) => database.query("UPDATE session SET time_updated='bad' WHERE id=?").run(id),
            ],
          ]
          for (const [name, mutate] of cases) {
            const hostile = await rewriteArchive(archive, () => undefined, [], mutate)
            await expect(Backend.inspect({ path: hostile, directory: destination }), name).rejects.toThrow()
            expect(await fs.readdir(destination), name).toEqual([])
          }
        } finally {
          Database.use((db) => db.run(sql`DELETE FROM session WHERE id = ${id}`))
        }
      })
    }),
  )

  for (const names of [
    ["../escape"],
    ["workspace/a", "workspace/A"],
    ["workspace/A/one", "workspace/a/two"],
    ["workspace/file", "workspace/file/child"],
    ["workspace/NUL"],
    ["workspace/.git/config"],
    ["sessions.sqlite-wal"],
    ["sessions/undeclared/file"],
  ]) {
    test(`restore rejects malicious ZIP ${names.join(", ")}`, async () => {
      await using root = await tmpdir()
      const destination = path.join(root.path, "dest")
      await fs.mkdir(destination)
      const fixture = await fixtureArchive(root.path)
      const archive = await rewriteArchive(fixture.archive, () => undefined, names)
      await expect(
        ProjectBackup.restore({
          path: archive,
          directory: destination,
          resolveProject: async () => {
            throw new Error("must not resolve")
          },
        }),
      ).rejects.toThrow()
      expect(await fs.readdir(destination)).toEqual([])
    })
  }

  for (const invalid of ["relative/session", "C:drive-relative", "\\\\server\\share", "\\\\?\\C:\\device"]) {
    test(`rejects invalid source session provenance ${JSON.stringify(invalid)}`, async () => {
      await using root = await tmpdir()
      const destination = path.join(root.path, "dest")
      await fs.mkdir(destination)
      const fixture = await fixtureArchive(root.path)
      const archive = await rewriteArchive(fixture.archive, (manifest) => {
        manifest.platform = "win32"
        manifest.directory = "D:\\project"
        manifest.sourceSessionRoot = invalid
      })
      await expect(
        ProjectBackup.restore({
          path: archive,
          directory: destination,
          resolveProject: async () => {
            throw new Error("must not resolve")
          },
        }),
      ).rejects.toThrow("source session root")
      expect(await fs.readdir(destination)).toEqual([])
    })
  }

  test("accepts normalized Windows provenance on a non-Windows host", async () => {
    await using root = await tmpdir()
    const fixture = await fixtureArchive(root.path)
    const archive = await rewriteArchive(fixture.archive, (manifest) => {
      manifest.platform = "win32"
      manifest.directory = "D:\\project"
      manifest.sourceSessionRoot = "E:\\opencode\\session"
    })
    const preview = await Backend.inspect({ path: archive, directory: path.join(root.path, "destination") })
    expect(preview.action).toBe("create")
    expect(preview.package.sessions).toBe(0)
  })

  it.live("maps Windows session rows, structured paths and file URLs to host destinations", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const service = yield* Project.Service
      const source = path.join(root, "source")
      const destination = path.join(root, "destination")
      yield* Effect.promise(() => Promise.all([fs.mkdir(source), fs.mkdir(destination)]))
      const project = yield* service.fromDirectory(source)
      yield* Effect.promise(async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "")
        const id = `ses_windows${suffix}`
        const message = `msg_${suffix}`
        const part = `prt_${suffix}`
        const folder = path.join(Global.Path.data, "session", id)
        const attachment = path.join(folder, "attachments", "image one.png")
        const archive = path.join(root, "windows-source.zip")
        try {
          await fs.mkdir(path.dirname(attachment), { recursive: true })
          await fs.writeFile(attachment, "attachment bytes")
          await fs.writeFile(path.join(folder, "assemble.ts"), "throw new Error('untrusted')")
          Database.use((db) => {
            db.run(
              sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},${project.project.id},'windows',${path.join(source, "child")},'Windows','1',1,2)`,
            )
            db.run(
              sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${message},${id},1,2,'{"role":"assistant"}')`,
            )
            db.run(
              sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${part},${message},${id},1,2,'{"type":"file"}')`,
            )
          })
          await Backend.backup({ directory: source, path: archive })
          const portable = await rewriteArchive(
            archive,
            (manifest) => {
              manifest.platform = "win32"
              manifest.directory = "D:\\Project"
              manifest.sourceSessionRoot = "E:\\OpenCode\\session"
            },
            [],
            (database) => {
              database.query("UPDATE project SET worktree = ?").run("D:\\Project")
              database.query("UPDATE session SET directory = ? WHERE id = ?").run("d:\\PROJECT\\Child", id)
              database
                .query("UPDATE message SET data = ? WHERE id = ?")
                .run(
                  JSON.stringify({ role: "assistant", path: { cwd: "d:\\PROJECT\\Child", root: "D:\\Project" } }),
                  message,
                )
              database.query("UPDATE part SET data = ? WHERE id = ?").run(
                JSON.stringify({
                  type: "file",
                  url: `file:///E:/OpenCode/session/${id}/attachments/image%20one.png`,
                  source: { type: "file", path: `E:\\OpenCode\\session\\${id}\\attachments\\image one.png` },
                }),
                part,
              )
            },
          )
          Database.use((db) => db.run(sql`DELETE FROM session WHERE id = ${id}`))
          await fs.rm(folder, { recursive: true })
          const restored = await ProjectBackup.restore({
            path: portable,
            directory: destination,
            resolveProject: (directory) =>
              Effect.runPromise(service.fromDirectory(directory)).then((result) => result.project),
          })
          expect(restored.sessions).toBe(1)
          expect(
            Database.use((db) => db.get<{ directory: string }>(sql`SELECT directory FROM session WHERE id = ${id}`))
              ?.directory,
          ).toBe(path.join(destination, "Child"))
          const savedMessage = JSON.parse(
            Database.use((db) => db.get<{ data: string }>(sql`SELECT data FROM message WHERE id = ${message}`))?.data ??
              "null",
          )
          expect(savedMessage.path.cwd).toBe(path.join(destination, "Child"))
          const savedPart = JSON.parse(
            Database.use((db) => db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = ${part}`))?.data ??
              "null",
          )
          const restoredAttachment = path.join(
            await fs.realpath(Global.Path.data),
            "session",
            id,
            "attachments",
            "image one.png",
          )
          expect(savedPart.url).toBe(pathToFileURL(restoredAttachment).href)
          expect(savedPart.source.path).toBe(restoredAttachment)
          expect(await fs.readFile(restoredAttachment, "utf8")).toBe("attachment bytes")
          expect(await exists(path.join(Global.Path.data, "session", id, "assemble.ts"))).toBe(false)
          expect(await exists(path.join(Global.Path.data, "session", id, "backup-disabled", "assemble.ts"))).toBe(true)
        } finally {
          Database.use((db) => db.run(sql`DELETE FROM session WHERE id = ${id}`))
          await fs.rm(folder, { recursive: true, force: true })
        }
      })
    }),
  )

  for (const [name, mutate, message] of [
    [
      "database hash",
      (manifest: Record<string, unknown>) => {
        const database = manifest.database as Record<string, unknown>
        database.sha256 = "0".repeat(64)
      },
      "SHA-256",
    ],
    [
      "table count",
      (manifest: Record<string, unknown>) => {
        const tables = (manifest.database as Record<string, unknown>).tables as Record<string, number>
        tables.session++
      },
      "count mismatch",
    ],
    [
      "framed checksum",
      (manifest: Record<string, unknown>) => {
        const checksums = (manifest.database as Record<string, unknown>).checksums as Record<
          string,
          Record<string, unknown>
        >
        checksums.session.sha256 = "0".repeat(64)
      },
      "checksum mismatch",
    ],
    [
      "schema descriptor",
      (manifest: Record<string, unknown>) => {
        const schema = (manifest.database as Record<string, unknown>).schema as Record<string, string>
        schema.session += " "
      },
      "schema mismatch",
    ],
    [
      "cell bound",
      (manifest: Record<string, unknown>) => {
        const checksums = (manifest.database as Record<string, unknown>).checksums as Record<
          string,
          Record<string, unknown>
        >
        checksums.part.maxCellBytes = 128 * 1024 ** 2 + 1
      },
      "safety limits",
    ],
  ] as const) {
    test(`rejects a mismatched v3 ${name}`, async () => {
      await using root = await tmpdir()
      const fixture = await fixtureArchive(root.path)
      const archive = await rewriteArchive(fixture.archive, mutate)
      await expect(Backend.inspect({ path: archive })).rejects.toThrow(message)
    })
  }

  test("rejects hostile SQLite schema objects even with updated bytes and checksums", async () => {
    await using root = await tmpdir()
    const fixture = await fixtureArchive(root.path)
    const archive = await rewriteArchive(
      fixture.archive,
      () => undefined,
      [],
      (database) => database.run("CREATE TRIGGER hostile AFTER INSERT ON session BEGIN SELECT 1; END"),
    )
    await expect(Backend.inspect({ path: archive })).rejects.toThrow("unexpected schema objects")
  })

  test("rejects generated columns reported by table_xinfo", async () => {
    await using root = await tmpdir()
    const fixture = await fixtureArchive(root.path)
    const archive = await rewriteArchive(
      fixture.archive,
      () => undefined,
      [],
      (database) => {
        database.run("ALTER TABLE session DROP COLUMN agent")
        database.run("ALTER TABLE session ADD COLUMN agent TEXT GENERATED ALWAYS AS ('hostile') VIRTUAL")
      },
    )
    await expect(Backend.inspect({ path: archive })).rejects.toThrow("Hidden or generated")
  })

  test("rejects schema nullability that differs from the runtime contract", async () => {
    await using root = await tmpdir()
    const fixture = await fixtureArchive(root.path)
    const archive = await rewriteArchive(
      fixture.archive,
      () => undefined,
      [],
      (database) => {
        database.run("ALTER TABLE message RENAME TO old_message")
        database.run(
          "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text, FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)",
        )
        database.run("DROP TABLE old_message")
      },
    )
    await expect(Backend.inspect({ path: archive })).rejects.toThrow("nullability")
  })

  test("ZIP symbolic link entries are rejected before extraction", async () => {
    await using root = await tmpdir()
    const destination = path.join(root.path, "dest")
    await fs.mkdir(destination)
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add("workspace/link", new TextReader("../../escape"), {
      useWebWorkers: false,
      externalFileAttributes: (0xa000 | 0o777) << 16,
    })
    const archive = path.join(root.path, "link.zip")
    await fs.writeFile(archive, await writer.close())
    await expect(
      ProjectBackup.restore({
        path: archive,
        directory: destination,
        resolveProject: async () => {
          throw new Error("must not resolve")
        },
      }),
    ).rejects.toThrow("links")
    expect(await fs.readdir(destination)).toEqual([])
  })

  test("oversized ZIP entries are rejected before allocation or extraction", async () => {
    await using root = await tmpdir()
    const destination = path.join(root.path, "dest")
    await fs.mkdir(destination)
    const fixture = await fixtureArchive(root.path)
    const archive = await rewriteArchive(fixture.archive, () => undefined, [
      "workspace/huge-1",
      "workspace/huge-2",
      "workspace/huge-3",
    ])
    const bytes = new Uint8Array(await fs.readFile(archive))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset + 28 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue
      if (
        Buffer.from(bytes.subarray(offset + 46, offset + 46 + view.getUint16(offset + 28, true)))
          .toString()
          .includes("huge-")
      )
        view.setUint32(offset + 24, 0xffffffff, true)
    }
    await fs.writeFile(archive, bytes)
    await expect(
      ProjectBackup.restore({
        path: archive,
        directory: destination,
        resolveProject: async () => {
          throw new Error("must not resolve")
        },
      }),
    ).rejects.toThrow("size limit")
    expect(await fs.readdir(destination)).toEqual([])
  })
})
