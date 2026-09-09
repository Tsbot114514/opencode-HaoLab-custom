import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { ProjectBackup } from "@/project/backup"
import { Project } from "@/project/project"
import { Database, sql } from "@/storage/db"
import { SessionAssembleTemplate } from "@/session/assemble-template"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Project.defaultLayer, CrossSpawnSpawner.defaultLayer))
const present = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )
const folder = (id: string) => path.join(Global.Path.data, "session", id)

async function prepare(root: string, service: Project.Interface) {
  const source = path.join(root, "A")
  const target = path.join(root, "B")
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, "project.txt"), "from A")
  const resolveProject = (directory: string) =>
    Effect.runPromise(service.fromDirectory(directory, { persist: false, cacheIdentity: false })).then((r) => r.project)
  const openProject = (directory: string) => Effect.runPromise(service.fromDirectory(directory)).then((r) => r.project)
  const project = await openProject(source)
  const ids = new Set<string>()
  const seed = async (directory: string, title = "local") => {
    const id = `ses_migration${crypto.randomUUID().replaceAll("-", "")}`
    ids.add(id)
    Database.use((db) => {
      db.run(
        sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},${project.id},'test',${directory},${title},'1',100,100)`,
      )
      db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${`msg_${id}`},${id},100,100,'{"role":"user","text":"original"}')`,
      )
      db.run(
        sql`INSERT INTO todo (session_id,content,status,priority,position,time_created,time_updated) VALUES (${id},'old task','pending','high',0,100,100)`,
      )
    })
    await fs.mkdir(folder(id), { recursive: true })
    await fs.writeFile(path.join(folder(id), "notes.json"), '{"content":"original context","assemble":true}')
    return id
  }
  const remove = async (id: string) => {
    Database.use((db) => {
      db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${id}`)
      db.run(sql`DELETE FROM session WHERE id = ${id}`)
    })
    await fs.rm(folder(id), { recursive: true, force: true })
  }
  const archive = path.join(root, "A.zip")
  const apply = async (file: string, directory: string, overwrite = false) => {
    const preview = await ProjectBackup.inspect({ path: file, directory })
    if (!preview.previewToken) throw new Error("Expected preview token")
    return ProjectBackup.restore({
      path: file,
      directory,
      previewToken: preview.previewToken,
      overwrite,
      resolveProject,
    })
  }
  return {
    source,
    target,
    archive,
    resolveProject,
    openProject,
    seed,
    remove,
    apply,
    [Symbol.asyncDispose]: async () => {
      for (const id of ids) await remove(id)
    },
  }
}

function scenario(run: (fixture: Awaited<ReturnType<typeof prepare>>, root: string) => Promise<void>) {
  return Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const service = yield* Project.Service
    yield* Effect.promise(async () => {
      await using fixture = await prepare(root, service)
      await run(fixture, root)
    })
  })
}

describe("confirmed project migration", () => {
  it.live(
    "A to B to A retains identity, replaces all scoped state, preserves Git and creates readable safety package",
    () =>
      scenario(async (f, root) => {
        const original = await f.seed(f.source, "from A")
        await fs.writeFile(
          path.join(folder(original), "assemble.ts"),
          "throw new Error('untrusted'); export default () => []",
        )
        await fs.writeFile(path.join(f.source, "opencode.json"), '{"permission":"allow"}')
        await fs.writeFile(path.join(f.source, "remove-on-return.txt"), "old")
        const mtime = new Date("2024-01-02T03:04:06Z")
        await fs.utimes(path.join(f.source, "project.txt"), mtime, mtime)
        await ProjectBackup.backup({ directory: f.source, path: f.archive })
        const first = await ProjectBackup.inspect({ path: f.archive })
        expect(first.directory).toBe(f.source)
        expect(first.action).toBe("replace")
        expect(first.candidates).toEqual([f.source])
        // Model separate devices in one isolated test DB: A goes offline before B imports its IDs.
        await f.remove(original)
        const created = await f.apply(f.archive, f.target)
        expect(created.safetyPath).toBeNull()
        expect(await present(f.target)).toBe(true)
        expect((await fs.stat(path.join(f.target, "project.txt"))).mtimeMs).toBe(mtime.getTime())
        expect(await present(path.join(f.target, "opencode.json"))).toBe(false)
        expect(await present(path.join(folder(original), "assemble.ts"))).toBe(false)
        await SessionAssembleTemplate.ensure(folder(original))
        expect(await present(path.join(folder(original), "backup-disabled", "assemble.ts"))).toBe(true)
        await fs.writeFile(path.join(f.target, "project.txt"), "from B")
        await fs.writeFile(path.join(f.target, "only-b.txt"), "new")
        await fs.rm(path.join(f.target, "remove-on-return.txt"))
        Database.use((db) =>
          db.run(sql`UPDATE session SET title = 'from B', time_updated = 900 WHERE id = ${original}`),
        )
        const back = path.join(root, "B.zip")
        await ProjectBackup.backup({ directory: f.target, path: back })
        const ambiguous = await ProjectBackup.inspect({ path: back })
        expect(ambiguous.package.identity).toBe(first.package.identity)
        expect(ambiguous.candidates).toEqual([f.source, f.target])
        expect(ambiguous.action).toBe("select-target")
        expect(ambiguous.previewToken).toBeNull()
        // Switch the isolated DB back to A's local view, including edits absent from B.
        Database.use((db) =>
          db.run(sql`UPDATE session SET directory = ${f.source}, title = 'old A' WHERE id = ${original}`),
        )
        await fs.writeFile(path.join(folder(original), "notes.json"), '{"content":"A local context"}')
        await fs.rm(f.target, { recursive: true })
        const localOnly = await f.seed(path.join(f.source, "child"), "local-only child")
        const unrelated = await f.seed(path.join(root, "unrelated"), "unrelated global session")
        Database.use((db) => {
          db.run(sql`INSERT INTO event_sequence (aggregate_id,seq) VALUES (${localOnly},7)`)
          db.run(
            sql`INSERT INTO event (id,aggregate_id,seq,type,data) VALUES (${`evt_${localOnly}`},${localOnly},7,'test','{}')`,
          )
        })
        await fs.writeFile(path.join(f.source, "only-a.txt"), "must disappear")
        await fs.mkdir(path.join(f.source, "node_modules"))
        await fs.writeFile(path.join(f.source, "node_modules", "cache"), "generated")
        const externalCache = path.join(root, "external-cache")
        await fs.mkdir(externalCache)
        await fs.writeFile(path.join(externalCache, "keep.txt"), "untouched")
        await fs.symlink(externalCache, path.join(f.source, "node_modules", "linked-dependency"), "junction")
        await fs.mkdir(path.join(f.source, ".git"))
        await fs.writeFile(path.join(f.source, ".git", "HEAD"), "preserve local git")
        const preview = await ProjectBackup.inspect({ path: back })
        expect(preview.directory).toBe(f.source)
        expect(preview.action).toBe("replace")
        expect(preview.local?.sessions).toBe(2)
        expect(preview.package.sessions).toBe(1)
        const input = {
          path: back,
          directory: f.source,
          previewToken: preview.previewToken ?? "",
          resolveProject: f.resolveProject,
        }
        await expect(ProjectBackup.restore({ ...input, previewToken: "", overwrite: true })).rejects.toThrow(
          "preview token",
        )
        await expect(ProjectBackup.restore({ ...input, overwrite: false })).rejects.toThrow("overwrite confirmation")
        expect(await fs.readFile(path.join(f.source, "only-a.txt"), "utf8")).toBe("must disappear")
        const result = await ProjectBackup.restore({ ...input, overwrite: true })
        expect(result.safetyPath).not.toBeNull()
        expect(await fs.readFile(path.join(f.source, "project.txt"), "utf8")).toBe("from B")
        expect(await present(path.join(f.source, "only-a.txt"))).toBe(false)
        expect(await present(path.join(f.source, "remove-on-return.txt"))).toBe(false)
        expect(await present(path.join(f.source, "node_modules"))).toBe(false)
        expect(await fs.readFile(path.join(externalCache, "keep.txt"), "utf8")).toBe("untouched")
        expect(await fs.readFile(path.join(f.source, ".git", "HEAD"), "utf8")).toBe("preserve local git")
        expect(await present(path.join(folder(original), "assemble.ts"))).toBe(false)
        expect(await present(folder(localOnly))).toBe(false)
        Database.use((db) => {
          expect(db.get<{ title: string }>(sql`SELECT title FROM session WHERE id = ${original}`)?.title).toBe("from B")
          expect(db.get(sql`SELECT id FROM session WHERE id = ${localOnly}`)).toBeUndefined()
          expect(db.get(sql`SELECT aggregate_id FROM event_sequence WHERE aggregate_id = ${localOnly}`)).toBeUndefined()
          expect(db.get(sql`SELECT id FROM event WHERE aggregate_id = ${localOnly}`)).toBeUndefined()
          expect(db.get(sql`SELECT id FROM session WHERE id = ${unrelated}`)).toBeDefined()
        })
        const safety = await ProjectBackup.inspect({ path: result.safetyPath ?? "", directory: f.source })
        expect(safety.package.sessions).toBe(2)
        expect(safety.package.identity).toBe(first.package.identity)
        await expect(ProjectBackup.restore({ ...input, overwrite: true })).rejects.toThrow("preview token")
      }),
  )

  for (const changed of ["archive", "workspace", "database", "context"]) {
    it.live(`rejects a content-stale ${changed} preview even with unchanged timestamps`, () =>
      scenario(async (f) => {
        await ProjectBackup.backup({ directory: f.source, path: f.archive })
        await fs.mkdir(f.target)
        await fs.writeFile(path.join(f.target, "local.txt"), "before")
        const id = await f.seed(f.target)
        const preview = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
        if (changed === "database")
          Database.use((db) =>
            db.run(sql`UPDATE message SET data = '{"role":"user","text":"changed"}' WHERE session_id = ${id}`),
          )
        const file =
          changed === "archive"
            ? f.archive
            : changed === "workspace"
              ? path.join(f.target, "local.txt")
              : path.join(folder(id), "notes.json")
        if (changed !== "database") {
          const stat = await fs.stat(file)
          if (changed === "archive") await fs.appendFile(file, "changed")
          else
            await fs.writeFile(
              file,
              changed === "workspace" ? "after!" : '{"content":"modified context","assemble":true}',
            )
          await fs.utimes(file, stat.atime, stat.mtime)
        }
        await expect(
          ProjectBackup.restore({
            path: f.archive,
            directory: f.target,
            previewToken: preview.previewToken ?? "",
            overwrite: true,
            resolveProject: f.resolveProject,
          }),
        ).rejects.toThrow("Stale preview")
        expect(Database.use((db) => db.get(sql`SELECT id FROM session WHERE id = ${id}`))).toBeDefined()
        expect(await present(path.join(Global.Path.data, "project-migrations", "apply.lock"))).toBe(false)
      }),
    )
  }

  it.live(
    "inspect does not mutate the DB, adopts only explicitly selected targets and rejects identity/external-ID collisions",
    () =>
      scenario(async (f, root) => {
        const id = await f.seed(f.source)
        await ProjectBackup.backup({ directory: f.source, path: f.archive })
        const before = Database.use((db) => db.all(sql`SELECT * FROM project`))
        await expect(ProjectBackup.inspect({ path: f.archive, directory: f.target })).rejects.toThrow("ID collision")
        expect(Database.use((db) => db.all(sql`SELECT * FROM project`))).toEqual(before)
        expect(await present(f.target)).toBe(false)
        await f.remove(id)
        const preview = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
        expect(preview.action).toBe("create")
        expect(preview.warnings.some((text) => text.includes("unmarked"))).toBe(true)
        expect(Database.use((db) => db.all(sql`SELECT * FROM project`))).toEqual(before)
        await fs.mkdir(f.target)
        await fs.writeFile(
          path.join(f.target, ".opencode-project.json"),
          JSON.stringify({ identity: crypto.randomUUID(), name: "Different" }),
        )
        await expect(ProjectBackup.inspect({ path: f.archive, directory: f.target })).rejects.toThrow(
          "different project",
        )
        // Removing the only known marker must not cause fallback to the archive's source path/name.
        await fs.rm(path.join(f.source, ".opencode-project.json"))
        const unselected = await ProjectBackup.inspect({ path: f.archive })
        expect(unselected.action).toBe("select-target")
        expect(unselected.candidates).toEqual([])
        expect(unselected.directory).toBeNull()
        expect(unselected.local).toBeNull()
        expect(await present(path.join(root, "unexpected"))).toBe(false)
      }),
  )

  it.live("SQL failure after original renames restores files, context, sessions and events", () =>
    scenario(async (f) => {
      const imported = await f.seed(f.source, "reject_import")
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      await f.remove(imported)
      await fs.mkdir(f.target)
      await $`git init`.cwd(f.target).quiet()
      await $`git -c user.name=Migration -c user.email=migration@example.test -c commit.gpgsign=false commit --allow-empty -m rollback`
        .cwd(f.target)
        .quiet()
      await fs.writeFile(path.join(f.target, "local.txt"), "original workspace")
      const old = await f.seed(f.target, "original session")
      Database.use((db) => {
        db.run(sql`INSERT INTO event_sequence (aggregate_id,seq) VALUES (${old},7)`)
        db.run(sql`INSERT INTO event (id,aggregate_id,seq,type,data) VALUES (${`evt_${old}`},${old},7,'test','{}')`)
        db.run(
          sql.raw(
            "CREATE TEMP TRIGGER migration_failure BEFORE INSERT ON session WHEN NEW.title = 'reject_import' BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END",
          ),
        )
      })
      const safetyDir = path.join(Global.Path.data, "project-migrations")
      const before = new Set(await fs.readdir(safetyDir))
      const projects = Database.use((db) => db.all(sql`SELECT * FROM project`))
      try {
        await expect(f.apply(f.archive, f.target, true)).rejects.toThrow("INSERT INTO")
        expect(await fs.readFile(path.join(f.target, "local.txt"), "utf8")).toBe("original workspace")
        expect(await fs.readFile(path.join(folder(old), "notes.json"), "utf8")).toContain("original context")
        expect(await fs.readdir(f.target)).toEqual([".git", "local.txt"])
        expect(Database.use((db) => db.all(sql`SELECT * FROM project`))).toEqual(projects)
        Database.use((db) => {
          expect(db.get<{ title: string }>(sql`SELECT title FROM session WHERE id = ${old}`)?.title).toBe(
            "original session",
          )
          expect(db.get(sql`SELECT id FROM session WHERE id = ${imported}`)).toBeUndefined()
          expect(db.get(sql`SELECT id FROM event WHERE aggregate_id = ${old}`)).toBeDefined()
        })
        const safety = (await fs.readdir(safetyDir)).filter((name) => !before.has(name) && name.endsWith(".zip"))
        expect(safety.length).toBe(1)
        expect(
          (
            await ProjectBackup.inspect({
              path: path.join(await fs.realpath(safetyDir), safety[0]),
              directory: f.target,
            })
          ).package.sessions,
        ).toBe(1)
        expect(await present(path.join(safetyDir, "apply.lock"))).toBe(false)
      } finally {
        Database.use((db) => db.run(sql.raw("DROP TRIGGER IF EXISTS migration_failure")))
      }
    }),
  )

  it.live("refuses active target sessions and guards an interrupted or concurrent apply", () =>
    scenario(async (f) => {
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      await fs.mkdir(f.target)
      const id = await f.seed(f.target)
      const preview = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
      await expect(
        ProjectBackup.restore({
          path: f.archive,
          directory: f.target,
          previewToken: preview.previewToken ?? "",
          overwrite: true,
          resolveProject: f.resolveProject,
          active: async () => new Set([id]),
        }),
      ).rejects.toThrow("active target sessions")
      const next = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
      const journal = path.join(Global.Path.data, "project-migrations", "apply.lock")
      await fs.writeFile(journal, '{"phase":"interrupted"}', { flag: "wx" })
      try {
        await expect(
          ProjectBackup.restore({
            path: f.archive,
            directory: f.target,
            previewToken: next.previewToken ?? "",
            overwrite: true,
            resolveProject: f.resolveProject,
          }),
        ).rejects.toThrow("requires recovery")
        expect(await fs.readFile(journal, "utf8")).toBe('{"phase":"interrupted"}')
      } finally {
        await fs.rm(journal)
      }
    }),
  )

  it.live("uses the destination Git project identity rather than importing the source Git ID", () =>
    scenario(async (f) => {
      await fs.mkdir(f.target)
      for (const dir of [f.source, f.target]) {
        await $`git init`.cwd(dir).quiet()
        await $`git -c user.name=Migration -c user.email=migration@example.test -c commit.gpgsign=false commit --allow-empty -m ${dir}`
          .cwd(dir)
          .quiet()
      }
      const sourceProject = await f.openProject(f.source)
      const targetProject = await f.resolveProject(f.target)
      expect(sourceProject.id).not.toBe(targetProject.id)
      const id = await f.seed(f.source)
      Database.use((db) => db.run(sql`UPDATE session SET project_id = ${sourceProject.id} WHERE id = ${id}`))
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      await f.remove(id)
      const unrelated = await f.seed(path.join(f.source, "unrelated"), "unrelated Git session")
      Database.use((db) => db.run(sql`UPDATE session SET project_id = ${sourceProject.id} WHERE id = ${unrelated}`))
      const head = await fs.readFile(path.join(f.target, ".git", "HEAD"), "utf8")
      await f.apply(f.archive, f.target, true)
      expect(
        Database.use((db) => db.get<{ project_id: string }>(sql`SELECT project_id FROM session WHERE id = ${id}`))
          ?.project_id,
      ).toBe(targetProject.id)
      expect(await fs.readFile(path.join(f.target, ".git", "HEAD"), "utf8")).toBe(head)
      expect(await present(path.join(f.target, ".git", "opencode"))).toBe(false)
      expect(
        Database.use((db) =>
          db.get<{ project_id: string }>(sql`SELECT project_id FROM session WHERE id = ${unrelated}`),
        )?.project_id,
      ).toBe(sourceProject.id)
    }),
  )

  it.live("revalidates context after the safety backup and before moving originals", () =>
    scenario(async (f) => {
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      await fs.mkdir(f.target)
      await fs.writeFile(path.join(f.target, "local.txt"), "keep me")
      const id = await f.seed(f.target)
      const preview = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
      await expect(
        ProjectBackup.restore({
          path: f.archive,
          directory: f.target,
          previewToken: preview.previewToken ?? "",
          overwrite: true,
          resolveProject: async (directory) => {
            await fs.writeFile(path.join(folder(id), "notes.json"), '{"content":"concurrent context update"}')
            return f.resolveProject(directory)
          },
        }),
      ).rejects.toThrow("Stale preview")
      expect(await fs.readFile(path.join(f.target, "local.txt"), "utf8")).toBe("keep me")
      expect(await fs.readFile(path.join(folder(id), "notes.json"), "utf8")).toContain("concurrent context update")
    }),
  )

  it.live("aborts replacement if the mandatory safety export fails", () =>
    scenario(async (f, root) => {
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      await fs.mkdir(f.target)
      await fs.writeFile(path.join(f.target, "local.txt"), "must survive")
      const id = await f.seed(f.target)
      const external = path.join(root, "external")
      await fs.mkdir(external)
      // Fingerprinting an excluded link is safe, but the ZIP exporter refuses linked roots.
      await fs.symlink(external, path.join(f.target, "node_modules"), "junction")
      await expect(f.apply(f.archive, f.target, true)).rejects.toThrow("Links")
      expect(await fs.readFile(path.join(f.target, "local.txt"), "utf8")).toBe("must survive")
      expect(Database.use((db) => db.get(sql`SELECT id FROM session WHERE id = ${id}`))).toBeDefined()
      expect(await present(path.join(f.target, ".opencode-project.json"))).toBe(false)
      expect(await present(path.join(Global.Path.data, "project-migrations", "apply.lock"))).toBe(false)
    }),
  )

  it.live("safely recreates a missing directory that still has scoped local history", () =>
    scenario(async (f) => {
      await ProjectBackup.backup({ directory: f.source, path: f.archive })
      const old = await f.seed(f.target, "history from a removed directory")
      expect(await present(f.target)).toBe(false)
      const preview = await ProjectBackup.inspect({ path: f.archive, directory: f.target })
      expect(preview.action).toBe("replace")
      expect(preview.local?.sessions).toBe(1)
      const result = await f.apply(f.archive, f.target, true)
      expect(await fs.readFile(path.join(f.target, "project.txt"), "utf8")).toBe("from A")
      expect(Database.use((db) => db.get(sql`SELECT id FROM session WHERE id = ${old}`))).toBeUndefined()
      expect(
        (await ProjectBackup.inspect({ path: result.safetyPath ?? "", directory: f.target })).package.sessions,
      ).toBe(1)
    }),
  )
})
