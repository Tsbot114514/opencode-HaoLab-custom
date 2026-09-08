import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadScriptDefault } from "@/session/script"
import { SessionAssembleTemplate } from "@/session/assemble-template"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js"
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
const packageInfo = (files: number, sessions: number) => ({
  identity: crypto.randomUUID(),
  name: "Fixture",
  createdAt: Date.now(),
  filesUpdatedAt: null,
  sessionsUpdatedAt: null,
  files,
  sessions,
})
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

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

  for (const names of [
    ["../escape"],
    ["workspace/a", "workspace/A"],
    ["workspace/A/one", "workspace/a/two"],
    ["workspace/NUL"],
    ["workspace/.git/config"],
  ]) {
    test(`restore rejects malicious ZIP ${names.join(", ")}`, async () => {
      await using root = await tmpdir()
      const destination = path.join(root.path, "dest")
      await fs.mkdir(destination)
      const writer = new ZipWriter(new Uint8ArrayWriter())
      for (const name of names) await writer.add(name, new TextReader("evil"), { useWebWorkers: false })
      await writer.add(
        "manifest.json",
        new TextReader(
          JSON.stringify({
            format: "opencode-project",
            version: 1,
            package: packageInfo(names.length, 0),
            directory: root.path,
            sourceSessionRoot: path.join(Global.Path.data, "session"),
            platform: process.platform,
            rows: { session: [], message: [], part: [], todo: [], session_message: [] },
            warnings: [],
          }),
        ),
        { useWebWorkers: false },
      )
      const archive = path.join(root.path, "evil.zip")
      await fs.writeFile(archive, await writer.close())
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
      expect((await fs.readdir(root.path)).sort()).toEqual(["dest", "evil.zip"])
    })
  }

  it.live("SQL failure rolls back all inserted rows and staged files", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const service = yield* Project.Service
      const project = yield* service.fromDirectory(root)
      yield* Effect.promise(async () => {
        const destination = path.join(root, "dest")
        await fs.mkdir(destination)
        const id = `ses_atomic${crypto.randomUUID().replaceAll("-", "")}`
        const rows = [
          {
            id,
            project_id: "untrusted",
            slug: "test",
            directory: root,
            title: "test",
            version: "1",
            time_created: 1,
            time_updated: 1,
          },
          {
            id: `${id}child`,
            project_id: "untrusted",
            directory: root,
            title: "missing required slug",
            version: "1",
            time_created: 1,
            time_updated: 1,
          },
        ]
        const writer = new ZipWriter(new Uint8ArrayWriter())
        await writer.add("workspace/file.txt", new TextReader("must not remain"), { useWebWorkers: false })
        await writer.add(
          "manifest.json",
          new TextReader(
            JSON.stringify({
              format: "opencode-project",
              version: 1,
              package: packageInfo(1, 2),
              directory: root,
              sourceSessionRoot: path.join(Global.Path.data, "session"),
              platform: process.platform,
              rows: { session: rows, message: [], part: [], todo: [], session_message: [] },
              warnings: [],
            }),
          ),
          { useWebWorkers: false },
        )
        const archive = path.join(root, "atomic.zip")
        await fs.writeFile(archive, await writer.close())
        await expect(
          ProjectBackup.restore({ path: archive, directory: destination, resolveProject: async () => project.project }),
        ).rejects.toThrow()
        expect(Database.use((db) => db.get(sql`SELECT id FROM session WHERE id = ${id}`))).toBeUndefined()
        expect(await fs.readdir(destination)).toEqual([])
        expect(await exists(path.join(Global.Path.data, "session", id))).toBe(false)
        expect((await fs.readdir(root)).sort()).toEqual(["atomic.zip", "dest"])
      })
    }),
  )

  it.live("quarantines assemble.ts and remaps included session attachments from another data root", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const service = yield* Project.Service
      const project = yield* service.fromDirectory(root)
      yield* Effect.promise(async () => {
        const destination = path.join(root, "dest")
        await fs.mkdir(destination)
        const suffix = crypto.randomUUID().replaceAll("-", "")
        const source = path.join(root, "source-project")
        const id = `ses_portable${suffix}`
        const mid = `msg_${suffix}`
        const pid = `prt_${suffix}`
        const sourceSessionRoot = path.join(root, "old-device", "data", "session")
        const original = path.join(sourceSessionRoot, id, "attachments", "image one.png")
        const unrelated = path.join(sourceSessionRoot, `${id}other`, "private.png")
        const external = path.join(root, "external", "private.png")
        const local = path.join(Global.Path.data, "session", id)
        const restored = path.join(local, "attachments", "image one.png")
        const script = "throw new Error('untrusted assemble executed'); export default () => []"
        const attachment = { type: "file", url: pathToFileURL(original).href, source: { type: "file", path: original } }
        const state = {
          status: "completed",
          attachments: [attachment],
          input: { filePath: original },
          output: original,
          structured: { filePath: original },
          content: [{ type: "text", text: original }],
        }
        const writer = new ZipWriter(new Uint8ArrayWriter())
        await writer.add(`sessions/${id}/assemble.ts`, new TextReader(script), { useWebWorkers: false })
        await writer.add(`sessions/${id}/attachments/image one.png`, new TextReader("attachment bytes"), {
          useWebWorkers: false,
        })
        await writer.add(
          "manifest.json",
          new TextReader(
            JSON.stringify({
              format: "opencode-project",
              version: 1,
              directory: source,
              package: packageInfo(2, 1),
              sourceSessionRoot,
              platform: process.platform,
              rows: {
                session: [
                  {
                    id,
                    project_id: "old-project",
                    slug: "portable",
                    directory: source,
                    title: "portable",
                    version: "1",
                    time_created: 1,
                    time_updated: 1,
                  },
                ],
                message: [
                  { id: mid, session_id: id, time_created: 1, time_updated: 1, data: JSON.stringify({ role: "user" }) },
                ],
                part: [
                  {
                    id: pid,
                    session_id: id,
                    message_id: mid,
                    time_created: 1,
                    time_updated: 1,
                    data: JSON.stringify({
                      ...attachment,
                      text: original,
                      input: { path: original },
                      attachments: [
                        { url: pathToFileURL(unrelated).href, source: { path: unrelated } },
                        { url: pathToFileURL(external).href, source: { path: external } },
                      ],
                    }),
                  },
                ],
                todo: [],
                session_message: [
                  {
                    id: `v2_${suffix}`,
                    session_id: id,
                    type: "assistant",
                    time_created: 1,
                    time_updated: 1,
                    data: JSON.stringify({
                      content: [
                        { type: "tool", state },
                        { type: "text", text: original },
                      ],
                    }),
                  },
                ],
              },
              warnings: [],
            }),
          ),
          { useWebWorkers: false },
        )
        const archive = path.join(root, "portable.zip")
        await fs.writeFile(archive, await writer.close())
        try {
          const result = await ProjectBackup.restore({
            path: archive,
            directory: destination,
            resolveProject: async () => project.project,
          })
          expect(result.warnings.some((warning) => warning.includes("assemble.ts"))).toBe(true)
          expect(result.warnings.some((warning) => warning.includes("same operating system"))).toBe(true)
          expect(await exists(path.join(local, "assemble.ts"))).toBe(false)
          expect(await fs.readFile(path.join(local, "backup-disabled", "assemble.ts"), "utf8")).toBe(script)
          expect(await loadScriptDefault(path.join(local, "assemble.ts"))).toBeUndefined()
          await SessionAssembleTemplate.ensure(local)
          expect(typeof (await loadScriptDefault(path.join(local, "assemble.ts")))).toBe("function")
          expect(await fs.readFile(restored, "utf8")).toBe("attachment bytes")
          const saved = JSON.parse(
            Database.use((db) => db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = ${pid}`))?.data ??
              "null",
          )
          expect(saved.url).toBe(pathToFileURL(restored).href)
          expect(saved.source.path).toBe(restored)
          expect(saved.text).toBe(original)
          expect(saved.input.path).toBe(original)
          expect(saved.attachments[0]).toEqual({ url: pathToFileURL(unrelated).href, source: { path: unrelated } })
          expect(saved.attachments[1]).toEqual({ url: pathToFileURL(external).href, source: { path: external } })
          expect(await exists(path.join(Global.Path.data, "session", `${id}other`))).toBe(false)
          const v2 = JSON.parse(
            Database.use((db) =>
              db.get<{ data: string }>(sql`SELECT data FROM session_message WHERE session_id = ${id}`),
            )?.data ?? "null",
          )
          expect(v2.content[0].state.attachments[0].url).toBe(pathToFileURL(restored).href)
          expect(v2.content[0].state.attachments[0].source.path).toBe(restored)
          expect(v2.content[0].state.input).toEqual(state.input)
          expect(v2.content[0].state.structured).toEqual(state.structured)
          expect(v2.content[0].state.content).toEqual(state.content)
          expect(v2.content[1].text).toBe(original)
        } finally {
          Database.use((db) => db.run(sql`DELETE FROM session WHERE id = ${id}`))
          await fs.rm(local, { recursive: true, force: true })
        }
      })
    }),
  )

  for (const invalid of [
    { sourceSessionRoot: "relative/session", platform: process.platform },
    { sourceSessionRoot: path.resolve("old/session"), platform: "other-os" },
  ]) {
    test(`rejects invalid source session provenance ${JSON.stringify(invalid)}`, async () => {
      await using root = await tmpdir()
      const destination = path.join(root.path, "dest")
      await fs.mkdir(destination)
      const writer = new ZipWriter(new Uint8ArrayWriter())
      await writer.add(
        "manifest.json",
        new TextReader(
          JSON.stringify({
            format: "opencode-project",
            version: 1,
            directory: root.path,
            package: packageInfo(0, 0),
            ...invalid,
            rows: { session: [], message: [], part: [], todo: [], session_message: [] },
            warnings: [],
          }),
        ),
        { useWebWorkers: false },
      )
      const archive = path.join(root.path, "invalid.zip")
      await fs.writeFile(archive, await writer.close())
      await expect(
        ProjectBackup.restore({
          path: archive,
          directory: destination,
          resolveProject: async () => {
            throw new Error("must not resolve")
          },
        }),
      ).rejects.toThrow(invalid.platform === process.platform ? "source session root" : "same operating system")
      expect(await fs.readdir(destination)).toEqual([])
    })
  }

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
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add("workspace/huge", new TextReader("small"), { useWebWorkers: false })
    const bytes = await writer.close()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset + 28 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue
      view.setUint32(offset + 24, 1024 ** 3 + 1, true)
      break
    }
    const archive = path.join(root.path, "huge.zip")
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
