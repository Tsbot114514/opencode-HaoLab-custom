import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { PermissionID } from "../../src/permission/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { Server } from "../../src/server/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import {
  SessionPaths,
  TranscriptSnapshotResult,
  TranscriptChangesResult,
} from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@/storage/db"
import {
  SessionMessageTable,
  SessionSidebarBaseTable,
  SessionSidebarChangeTable,
  SessionSidebarCountTable,
  SessionSidebarStateTable,
  SessionTable,
  SessionTranscriptMetaTable,
} from "@/session/session.sql"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const it = testEffect(Layer.mergeAll(instanceStoreLayer, Project.defaultLayer, Session.defaultLayer, workspaceLayer))

function app() {
  return Server.Default().app
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, time = 1) =>
  Effect.sync(() => {
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values([
          {
            id: message.id,
            session_id: sessionID,
            type: message.type,
            time_created: time,
            data: {
              time: { created: time },
              agent: message.agent,
              model: message.model,
              content: message.content,
            } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
          },
        ])
        .run(),
    )
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values([
          {
            id: SessionMessage.ID.create(),
            session_id: sessionID,
            type: "assistant",
            time_created: time,
            data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
          },
        ])
        .run(),
    ),
  )

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({
          summary_additions: 1,
          summary_deletions: 0,
          summary_files: 1,
          summary_diffs: [{ additions: 1, deletions: 0 }],
        })
        .where(eq(SessionTable.id, sessionID))
        .run(),
    ),
  )

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select({ workspaceID: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    ),
  )

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) => db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run()),
  )

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => app().request(path, init))
}

function json<T>(response: Response) {
  return Effect.promise(async () => {
    if (response.status !== 200) throw new Error(await response.text())
    return (await response.json()) as T
  })
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.instance("serves transcript snapshots and entity changes with supported-route errors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const service = yield* Session.Service
      const session = yield* createSession()
      const message = yield* createTextMessage(session.id, "initial")
      const headers = { "x-opencode-directory": test.directory }
      const snapshotPath = pathFor(SessionPaths.transcriptSnapshot, { sessionID: session.id })
      const changePath = pathFor(SessionPaths.transcriptChanges, { sessionID: session.id })
      const response = yield* request(snapshotPath, { headers })
      expect(response.headers.get("x-opencode-transcript-feed")).toBe("1")
      expect(response.headers.get("access-control-expose-headers")).toContain("X-Opencode-Transcript-Feed")
      const start = yield* json<typeof TranscriptSnapshotResult.Type>(response)
      expect(start.items[0]?.parts[0]).toMatchObject({ text: "initial" })
      expect(start.session.id).toBe(session.id)
      expect(start.status).toEqual({ type: "idle" })
      expect(start.version).toBeGreaterThan(0)
      expect(start.generation).toHaveLength(65)
      yield* service.updatePartDelta({
        sessionID: session.id,
        messageID: message.info.id,
        partID: message.part.id,
        field: "text",
        delta: " streamed",
      })
      const delta = yield* requestJson<typeof TranscriptChangesResult.Type>(`${changePath}?cursor=${start.cursor}`, {
        headers,
      })
      expect(delta.changes[0]).toMatchObject({
        type: "part.upsert",
        info: { id: message.info.id },
        part: { text: "initial streamed" },
      })
      expect(delta.changes[0]?.seq).toBeGreaterThan(start.version)
      expect(delta.more).toBe(false)
      expect(delta.generation).toBe(start.generation)
      expect((yield* request(`${changePath}?cursor=bad`, { headers })).status).toBe(400)
      expect((yield* request(`${snapshotPath}?limit=101`, { headers })).status).toBe(400)
      const other = yield* createSession()
      expect(
        (yield* request(`${pathFor(SessionPaths.transcriptChanges, { sessionID: other.id })}?cursor=${start.cursor}`, {
          headers,
        })).status,
      ).toBe(400)
      Database.use((db) => db.update(SessionTranscriptMetaTable).set({ epoch: "new-incarnation" }).run())
      const expired = yield* request(`${changePath}?cursor=${delta.cursor}`, { headers })
      expect(expired.status).toBe(410)
      expect(yield* responseJson(expired)).toMatchObject({
        _tag: "TranscriptCursorExpiredError",
        reason: "database-reset",
      })
      yield* service.remove(session.id)
      const absent = yield* request(snapshotPath, { headers })
      expect(absent.status).toBe(404)
      expect(absent.headers.get("x-opencode-transcript-feed")).toBe("1")
      expect(yield* responseJson(absent)).toMatchObject({
        name: "NotFoundError",
        data: { message: expect.stringContaining(session.id) },
      })
      const unsupported = yield* request(`/unsupported-transcript-route`, { headers })
      expect(unsupported.headers.get("x-opencode-transcript-feed")).toBeNull()
    }),
  )

  it.instance("does not expose transcript data across directory scopes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* createSession()
      yield* createTextMessage(session.id, "private-scope")
      const wrong = path.join(test.directory, "other")
      yield* Effect.promise(() => mkdir(wrong))
      const response = yield* request(pathFor(SessionPaths.transcriptSnapshot, { sessionID: session.id }), {
        headers: { "x-opencode-directory": wrong },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("x-opencode-transcript-feed")).toBe("1")
      expect(JSON.stringify(yield* responseJson(response))).not.toContain("private-scope")
    }),
  )

  it.instance(
    "pages a fixed sidebar snapshot and catches up through ordered changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const first = yield* createSession({ title: "first" })
        const second = yield* createSession({ title: "second" })
        const child = yield* createSession({ title: "child", parentID: first.id })
        const get = <T>(route: string, params: Record<string, string>) =>
          requestJson<T>(`${route}?${new URLSearchParams(params)}`, {
            headers: { "x-opencode-directory": test.directory },
          })
        type Title = { id: string; title: string }
        type Snapshot = {
          cursor: number
          total: number
          items: (Title & { time: { updated: number } })[]
          next: { updated: number; id: string } | null
        }
        type Change = { seq: number; type: "upsert"; session: Title } | { seq: number; type: "remove"; id: string }
        type Changes = { cursor: number; total: number; changes: Change[]; more: boolean }

        const start = yield* get<Snapshot>(SessionPaths.sidebarSnapshot, { limit: "1" })
        expect(start.items).toHaveLength(1)
        expect(start.total).toBe(2)
        expect(start.next).toEqual({ updated: start.items[0]?.time.updated, id: start.items[0]?.id })
        yield* svc.setTitle({ sessionID: first.id, title: "renamed" })
        yield* svc.remove(second.id)
        const later = yield* createSession({ title: "later" })
        const end = yield* get<Snapshot>(SessionPaths.sidebarSnapshot, {
          cursor: String(start.cursor),
          afterUpdated: String(start.next!.updated),
          afterID: start.next!.id,
          limit: "1",
        })
        expect(end.total).toBe(2)
        expect([...start.items, ...end.items].map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
        expect(end.next).toBeNull()
        expect([...start.items, ...end.items].find((item) => item.id === first.id)?.title).toBe("first")

        const pages: Change[] = []
        let cursor = start.cursor
        for (let more = true; more; ) {
          const page = yield* get<Changes>(SessionPaths.sidebarChanges, { cursor: String(cursor), limit: "1" })
          pages.push(...page.changes)
          expect(page.cursor).toBeGreaterThanOrEqual(cursor)
          cursor = page.cursor
          more = page.more
        }
        expect(
          pages.map((item) => (item.type === "remove" ? [item.type, item.id] : [item.type, item.session.id])),
        ).toEqual([
          ["upsert", first.id],
          ["remove", second.id],
          ["upsert", later.id],
        ])
        expect(pages.find((item) => item.type === "upsert" && item.session.id === first.id)).toMatchObject({
          session: { title: "renamed" },
        })
        expect(yield* get<Changes>(SessionPaths.sidebarChanges, { cursor: String(cursor), limit: "1" })).toMatchObject({
          cursor,
          changes: [],
          more: false,
        })
        expect(
          (yield* request(
            `${SessionPaths.sidebarSnapshot}?afterUpdated=${start.next!.updated}&afterID=${first.id}&limit=1`,
            {
              headers: { "x-opencode-directory": test.directory },
            },
          )).status,
        ).toBe(400)
        expect(
          (yield* request(`${SessionPaths.sidebarSnapshot}?cursor=${start.cursor}&afterID=${first.id}&limit=1`, {
            headers: { "x-opencode-directory": test.directory },
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${SessionPaths.sidebarChanges}?cursor=${cursor + 100}&limit=1`, {
            headers: { "x-opencode-directory": test.directory },
          })).status,
        ).toBe(400)
        expect(child.id).not.toBe(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "scopes sidebar changes across directory moves, archives and direct SQL deletes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "move" })
        const other = path.join(test.directory, "other")
        yield* Effect.promise(() => mkdir(other))
        const get = <T>(directory: string, route: string, params: Record<string, string>) =>
          requestJson<T>(`${route}?${new URLSearchParams(params)}`, { headers: { "x-opencode-directory": directory } })
        type Snapshot = { cursor: number; items: { id: string }[] }
        type Changes = {
          cursor: number
          changes: (
            | { seq: number; type: "remove"; id: string }
            | { seq: number; type: "upsert"; session: { id: string } }
          )[]
        }
        const before = yield* get<Snapshot>(test.directory, SessionPaths.sidebarSnapshot, { limit: "20" })
        expect(before.items.map((item) => item.id)).toContain(session.id)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ directory: other }).where(eq(SessionTable.id, session.id)).run(),
          ),
        )
        expect(
          (yield* get<Changes>(test.directory, SessionPaths.sidebarChanges, {
            cursor: String(before.cursor),
            limit: "20",
          })).changes,
        ).toEqual([{ seq: before.cursor + 1, type: "remove", id: session.id }])
        expect(
          (yield* get<Changes>(other, SessionPaths.sidebarChanges, { cursor: String(before.cursor), limit: "20" }))
            .changes[0],
        ).toMatchObject({ type: "upsert", session: { id: session.id } })
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, session.id)).run(),
          ),
        )
        const moved = yield* get<Changes>(other, SessionPaths.sidebarChanges, {
          cursor: String(before.cursor),
          limit: "20",
        })
        expect(moved.changes.at(-1)).toMatchObject({ type: "remove", id: session.id })
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()),
        )
        const unchanged = yield* get<Changes>(test.directory, SessionPaths.sidebarChanges, {
          cursor: String(moved.cursor),
          limit: "20",
        })
        expect(unchanged.changes).toEqual([])
        expect(unchanged.cursor).toBeGreaterThan(moved.cursor)
        expect(
          (yield* get<Changes>(other, SessionPaths.sidebarChanges, { cursor: String(moved.cursor), limit: "20" }))
            .changes,
        ).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "maintains nonnegative scoped root totals across direct SQL transitions and cascades",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const first = yield* createSession({ title: "first" })
        const second = yield* createSession({ title: "second" })
        const child = yield* createSession({ title: "child", parentID: first.id })
        const other = path.join(test.directory, "other")
        yield* Effect.promise(() => mkdir(other))
        const projectID = first.projectID
        const total = (directory: string) =>
          requestJson<{ total: number }>(`${SessionPaths.sidebarChanges}?cursor=0&limit=20`, {
            headers: { "x-opencode-directory": directory },
          }).pipe(Effect.map((response) => response.total))
        const counts = () => Database.use((db) => db.select().from(SessionSidebarCountTable).all())
        const update = (sessionID: SessionIDType, values: Partial<typeof SessionTable.$inferInsert>) =>
          Effect.sync(() =>
            Database.use((db) => db.update(SessionTable).set(values).where(eq(SessionTable.id, sessionID)).run()),
          )

        expect(yield* total(test.directory)).toBe(2)
        yield* update(first.id, { title: "renamed" })
        expect(yield* total(test.directory)).toBe(2)
        yield* update(second.id, { directory: other })
        expect([yield* total(test.directory), yield* total(other)]).toEqual([1, 1])
        yield* update(second.id, { time_archived: Date.now() })
        expect(yield* total(other)).toBe(0)
        yield* update(second.id, { time_archived: null })
        expect(yield* total(other)).toBe(1)
        yield* update(second.id, { parent_id: first.id })
        expect(yield* total(other)).toBe(0)
        yield* update(second.id, { parent_id: null })
        expect(yield* total(other)).toBe(1)
        yield* update(child.id, { parent_id: null })
        expect(yield* total(test.directory)).toBe(2)
        yield* update(child.id, { parent_id: first.id })
        expect(yield* total(test.directory)).toBe(1)

        const foreignID = ProjectID.make("sidebar-count-foreign")
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()!
            db.insert(ProjectTable)
              .values({ ...project, id: foreignID, worktree: `${test.directory}-foreign` })
              .run()
            db.update(SessionTable).set({ project_id: foreignID }).where(eq(SessionTable.id, second.id)).run()
          }),
        )
        expect(yield* total(other)).toBe(0)
        expect(counts()).toHaveLength(2)
        expect(counts()).toContainEqual({ project_id: projectID, directory: test.directory, total: 1 })
        expect(counts()).toContainEqual({ project_id: foreignID, directory: other, total: 1 })
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, foreignID)).run()),
        )
        expect(yield* total(other)).toBe(0)
        expect(counts()).toEqual([{ project_id: projectID, directory: test.directory, total: 1 }])
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, first.id)).run()),
        )
        expect(yield* total(test.directory)).toBe(0)
        expect(counts()).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not expose another project's writes or cascade deletes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const local = yield* createSession({ title: "local" })
        const foreignID = ProjectID.make("foreign-project")
        const get = (directory: string, cursor: number) =>
          requestJson<{ cursor: number; changes: { type: string; id?: string; session?: { id: string } }[] }>(
            `${SessionPaths.sidebarChanges}?cursor=${cursor}&limit=1`,
            { headers: { "x-opencode-directory": directory } },
          )
        const baseline = yield* requestJson<{ cursor: number }>(`${SessionPaths.sidebarSnapshot}?limit=1`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const remoteID = SessionID.descending()
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            const existing = db.select().from(SessionTable).where(eq(SessionTable.id, local.id)).get()!
            const project = db.select().from(ProjectTable).where(eq(ProjectTable.id, existing.project_id)).get()!
            db.insert(ProjectTable)
              .values({ ...project, id: foreignID, worktree: `${test.directory}-foreign` })
              .run()
            db.insert(SessionTable)
              .values({ ...existing, id: remoteID, project_id: foreignID, directory: `${test.directory}-foreign` })
              .run()
            db.delete(ProjectTable).where(eq(ProjectTable.id, foreignID)).run()
          }),
        )
        expect((yield* get(test.directory, baseline.cursor)).changes).toEqual([])
        const after = yield* requestJson<{ cursor: number; items: { id: string }[] }>(
          `${SessionPaths.sidebarSnapshot}?limit=20`,
          { headers: { "x-opencode-directory": test.directory } },
        )
        expect(after.items.map((item) => item.id)).toContain(local.id)
        expect(after.items.map((item) => item.id)).not.toContain(remoteID)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "pages every change from a bulk SQL transaction without skipping records",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = yield* createSession({ title: "source" })
        const baseline = yield* requestJson<{ cursor: number }>(`${SessionPaths.sidebarSnapshot}?limit=1`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const ids = Array.from({ length: 9 }, () => SessionID.descending())
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            const row = db.select().from(SessionTable).where(eq(SessionTable.id, source.id)).get()!
            for (const id of ids)
              db.insert(SessionTable)
                .values({ ...row, id })
                .run()
          }),
        )
        const seen: string[] = []
        let cursor = baseline.cursor
        for (let more = true; more; ) {
          const page = yield* requestJson<{
            cursor: number
            changes: { type: string; session?: { id: string } }[]
            more: boolean
          }>(`${SessionPaths.sidebarChanges}?cursor=${cursor}&limit=2`, {
            headers: { "x-opencode-directory": test.directory },
          })
          seen.push(...page.changes.map((item) => item.session!.id))
          cursor = page.cursor
          more = page.more
        }
        expect(seen).toEqual(ids)
        expect(cursor).toBe(baseline.cursor + ids.length)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "pages more than 200 roots newest first with stable totals and offscreen changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = yield* createSession({ title: "oldest" })
        const ids = Array.from({ length: 230 }, () => SessionID.descending())
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            const row = db.select().from(SessionTable).where(eq(SessionTable.id, source.id)).get()!
            ids.forEach((id, index) =>
              db
                .insert(SessionTable)
                .values({
                  ...row,
                  id,
                  title: `title-${index}`,
                  time_updated: row.time_updated + index + 1,
                })
                .run(),
            )
          }),
        )
        type Page = {
          cursor: number
          total: number
          items: { id: string; title: string; time: { updated: number } }[]
          next: { updated: number; id: string } | null
        }
        const get = <T>(route: string, params: Record<string, string>) =>
          requestJson<T>(`${route}?${new URLSearchParams(params)}`, {
            headers: { "x-opencode-directory": test.directory },
          })
        const first = yield* get<Page>(SessionPaths.sidebarSnapshot, { limit: "55" })
        expect(first.total).toBe(231)
        expect(first.items.map((item) => item.id)).toEqual(ids.slice(-55).reverse())
        expect(first.next).toEqual({ updated: first.items[54]!.time.updated, id: first.items[54]!.id })

        // These mutations occur after the snapshot watermark, including one outside the first page.
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ title: "offscreen-renamed" }).where(eq(SessionTable.id, ids[3]!)).run(),
          ),
        )
        const renamed = yield* get<{ total: number; changes: { type: string; session: { id: string } }[] }>(
          SessionPaths.sidebarChanges,
          { cursor: String(first.cursor), limit: "1" },
        )
        expect(renamed.total).toBe(231)
        expect(renamed.changes[0]).toMatchObject({ type: "upsert", session: { id: ids[3] } })
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, ids[2]!)).run()),
        )
        const second = yield* get<Page>(SessionPaths.sidebarSnapshot, {
          cursor: String(first.cursor),
          afterUpdated: String(first.next!.updated),
          afterID: first.next!.id,
          limit: "55",
        })
        expect(second.total).toBe(231)
        expect(second.items.map((item) => item.id)).toEqual(ids.slice(-110, -55).reverse())
        const delta = yield* get<{
          cursor: number
          total: number
          more: boolean
          changes: ({ type: "upsert"; session: { id: string; title: string } } | { type: "remove"; id: string })[]
        }>(SessionPaths.sidebarChanges, { cursor: String(first.cursor), limit: "1" })
        expect(delta.total).toBe(230)
        expect(delta.more).toBe(true)
        expect(delta.changes[0]).toMatchObject({ type: "upsert", session: { id: ids[3], title: "offscreen-renamed" } })
        const deletePage = yield* get<{ total: number; changes: { type: string; id: string }[] }>(
          SessionPaths.sidebarChanges,
          { cursor: String(delta.cursor), limit: "1" },
        )
        expect(deletePage.total).toBe(230)
        expect(deletePage.changes[0]).toMatchObject({ type: "remove", id: ids[2] })
        const replacement = yield* createSession({ title: "newly-visible" })
        const collected = [...first.items, ...second.items]
        let next = second.next
        while (next) {
          const page = yield* get<Page>(SessionPaths.sidebarSnapshot, {
            cursor: String(first.cursor),
            afterUpdated: String(next.updated),
            afterID: next.id,
            limit: "55",
          })
          expect(page.total).toBe(231)
          collected.push(...page.items)
          next = page.next
        }
        expect(collected.map((item) => item.id)).toEqual([...ids].reverse().concat(source.id))
        expect(collected.find((item) => item.id === ids[3])?.title).toBe("title-3")
        expect(collected.some((item) => item.id === replacement.id)).toBe(false)

        const inserted = yield* get<{ total: number; changes: { type: string; session: { id: string } }[] }>(
          SessionPaths.sidebarChanges,
          { cursor: String(first.cursor + 2), limit: "1" },
        )
        expect(inserted.total).toBe(231)
        expect(inserted.changes[0]).toMatchObject({ type: "upsert", session: { id: replacement.id } })
        const current = yield* get<Page>(SessionPaths.sidebarSnapshot, { limit: "55" })
        expect(current.total).toBe(231)
        expect(current.items.some((item) => item.id === ids[2])).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses descending id to break equal update-time ties across snapshot pages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Effect.forEach(["a", "b", "c"], (title) => createSession({ title }))
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            sessions.forEach((item) =>
              db.update(SessionTable).set({ time_updated: 1000 }).where(eq(SessionTable.id, item.id)).run(),
            )
          }),
        )
        const get = (params: Record<string, string>) =>
          requestJson<{
            cursor: number
            total: number
            items: { id: string }[]
            next: { updated: number; id: string } | null
          }>(`${SessionPaths.sidebarSnapshot}?${new URLSearchParams(params)}`, {
            headers: { "x-opencode-directory": test.directory },
          })
        const first = yield* get({ limit: "1" })
        const second = yield* get({
          cursor: String(first.cursor),
          afterUpdated: String(first.next!.updated),
          afterID: first.next!.id,
          limit: "1",
        })
        const third = yield* get({
          cursor: String(first.cursor),
          afterUpdated: String(second.next!.updated),
          afterID: second.next!.id,
          limit: "1",
        })
        expect([first.total, second.total, third.total]).toEqual([3, 3, 3])
        expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual(
          sessions
            .map((item) => item.id)
            .sort()
            .reverse(),
        )
        expect(third.next).toBeNull()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "expires pruned cursors and resnapshots without losing retained changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const get = (route: string, params: Record<string, string>) =>
          request(`${route}?${new URLSearchParams(params)}`, { headers: { "x-opencode-directory": test.directory } })
        const empty = yield* json<{ cursor: number; items: unknown[] }>(
          yield* get(SessionPaths.sidebarSnapshot, { limit: "1" }),
        )
        expect(empty).toMatchObject({ cursor: 0, items: [] })
        const first = yield* createSession({ title: "first" })
        const second = yield* createSession({ title: "second" })
        const firstChanges = yield* json<{
          changes: { type: string; session: { id: string; slug: string; version: string } }[]
        }>(yield* get(SessionPaths.sidebarChanges, { cursor: "0", limit: "2" }))
        expect(firstChanges.changes.map((item) => item.session.id)).toEqual([first.id, second.id])
        expect(firstChanges.changes[0]?.session).toMatchObject({ slug: first.slug, version: first.version })
        const start = yield* json<{
          cursor: number
          items: { id: string; slug: string; version: string }[]
          next: { updated: number; id: string }
        }>(yield* get(SessionPaths.sidebarSnapshot, { limit: "1" }))
        expect(start.items[0]).toMatchObject({
          slug: start.items[0]?.id === first.id ? first.slug : second.slug,
          version: first.version,
        })

        yield* Effect.sync(() =>
          Database.transaction((db) => {
            for (let index = 0; index < 516; index++) {
              db.update(SessionTable)
                .set({ title: `title-${index}` })
                .where(eq(SessionTable.id, first.id))
                .run()
            }
          }),
        )
        const position = Database.use((db) => db.select().from(SessionSidebarStateTable).get()!)
        expect(position.seq).toBe(start.cursor + 516)
        expect(position.floor).toBe(position.seq - 512)
        expect(Database.use((db) => db.select().from(SessionSidebarChangeTable).all())).toHaveLength(512)
        expect(Database.use((db) => db.select().from(SessionSidebarBaseTable).all())).toHaveLength(2)
        const expired = yield* get(SessionPaths.sidebarChanges, { cursor: "0", limit: "2" })
        expect(expired.status).toBe(410)
        expect(yield* responseJson(expired)).toMatchObject({
          message: "Sidebar cursor expired; request a new snapshot",
        })
        expect(
          (yield* get(SessionPaths.sidebarSnapshot, {
            cursor: String(start.cursor),
            afterUpdated: String(start.next.updated),
            afterID: start.next.id,
            limit: "1",
          })).status,
        ).toBe(410)
        expect(
          (yield* get(SessionPaths.sidebarSnapshot, { cursor: String(position.floor - 1), limit: "2" })).status,
        ).toBe(410)
        expect((yield* get(SessionPaths.sidebarChanges, { cursor: String(position.seq + 1), limit: "2" })).status).toBe(
          400,
        )

        const boundary = yield* json<{ cursor: number; items: { id: string; title: string }[] }>(
          yield* get(SessionPaths.sidebarSnapshot, { cursor: String(position.floor), limit: "2" }),
        )
        expect(boundary.items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
        expect(boundary.items.find((item) => item.id === first.id)?.title).toBe(
          `title-${position.floor - start.cursor - 1}`,
        )
        const current = yield* json<{
          cursor: number
          items: { id: string; slug: string; version: string; title: string }[]
        }>(yield* get(SessionPaths.sidebarSnapshot, { limit: "2" }))
        expect(current.items.find((item) => item.id === first.id)).toMatchObject({
          slug: first.slug,
          version: first.version,
          title: "title-515",
        })
        const seen: number[] = []
        let cursor = position.floor
        for (let more = true; more; ) {
          const page = yield* json<{ cursor: number; changes: { seq: number }[]; more: boolean }>(
            yield* get(SessionPaths.sidebarChanges, { cursor: String(cursor), limit: "200" }),
          )
          seen.push(...page.changes.map((item) => item.seq))
          cursor = page.cursor
          more = page.more
        }
        expect(seen).toHaveLength(512)
        expect(cursor).toBe(current.cursor)
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, first.id)).run()),
        )
        const deleted = yield* json<{ changes: { type: string; id: string }[] }>(
          yield* get(SessionPaths.sidebarChanges, { cursor: String(cursor), limit: "1" }),
        )
        expect(deleted.changes[0]).toMatchObject({ type: "remove", id: first.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
  it.instance(
    "reconciles root titles, archives and deletions without returning messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const first = yield* createSession({ title: "first" })
        const second = yield* createSession({ title: "second" })
        const child = yield* createSession({ title: "child", parentID: first.id })
        const post = (known: { id: SessionIDType; title: string; updated: number; archived?: number }[], limit = 20) =>
          requestJson<{ upserts: Session.Info[]; removed: string[]; limit: number; limited: boolean }>(
            SessionPaths.reconcile,
            {
              method: "POST",
              headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
              body: JSON.stringify({ known, limit }),
            },
          )

        const initial = yield* post([])
        expect(initial).toMatchObject({ removed: [], limit: 20, limited: false })
        expect(initial.upserts.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
        expect(initial.upserts.some((item) => item.id === child.id)).toBe(false)
        expect(JSON.stringify(initial)).not.toContain("parts")
        const known = initial.upserts.map((item) => ({ id: item.id, title: item.title, updated: item.time.updated }))
        expect(yield* post(known)).toMatchObject({ upserts: [], removed: [], limited: false })

        yield* svc.setTitle({ sessionID: first.id, title: "renamed" })
        const renamed = yield* post(known)
        expect(renamed.upserts.map((item) => item.id)).toEqual([first.id])
        expect(renamed.upserts[0]?.title).toBe("renamed")
        expect(renamed.upserts[0]?.time.updated).toBe(first.time.updated)

        const bounded = yield* post(known, 1)
        expect(bounded.limit).toBe(1)
        expect(bounded.limited).toBe(true)
        expect(bounded.removed).toEqual([])

        yield* svc.setArchived({ sessionID: first.id, time: Date.now() })
        yield* svc.remove(second.id)
        const caughtUp = yield* post(known)
        expect(caughtUp.upserts).toEqual([])
        expect(caughtUp.removed.sort()).toEqual([first.id, second.id].sort())
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "reconciles cached sessions displaced outside the limited window",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const renamed = yield* createSession({ title: "old-title" })
        const archived = yield* createSession({ title: "archive-me" })
        const deleted = yield* createSession({ title: "delete-me" })
        const known = [renamed, archived, deleted].map((item) => ({
          id: item.id,
          title: item.title,
          updated: item.time.updated,
        }))
        const sibling = path.join(test.directory, "sibling")
        yield* Effect.promise(() => mkdir(sibling))
        // Non-Git directories can share a global project ID, so directory must still fence lookups.
        const foreign = yield* createSession({ title: "foreign" }).pipe(provideInstance(sibling))
        const newest = yield* createSession({ title: "newest" })
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(SessionTable)
              .set({ time_updated: Date.now() + 60_000 })
              .where(eq(SessionTable.id, newest.id))
              .run(),
          ),
        )
        const post = (items: typeof known) =>
          requestJson<{ upserts: Session.Info[]; removed: string[]; limit: number; limited: boolean }>(
            SessionPaths.reconcile,
            {
              method: "POST",
              headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
              body: JSON.stringify({ known: items, limit: 1 }),
            },
          )

        const displaced = yield* post([
          ...known,
          { id: foreign.id, title: foreign.title, updated: foreign.time.updated },
        ])
        expect(displaced.limited).toBe(true)
        expect(displaced.upserts.map((item) => item.id)).toEqual([newest.id])
        expect(displaced.removed).toEqual([foreign.id])

        yield* svc.setTitle({ sessionID: renamed.id, title: "new-title" })
        const changed = yield* post(known)
        expect(changed.upserts.map((item) => item.id)).toEqual([newest.id, renamed.id])
        expect(changed.upserts[1]?.time.updated).toBe(renamed.time.updated)
        expect(changed.removed).toEqual([])

        yield* svc.setArchived({ sessionID: archived.id, time: Date.now() })
        yield* svc.remove(deleted.id)
        const caughtUp = yield* post(known)
        expect(caughtUp.upserts.map((item) => item.id)).toEqual([newest.id, renamed.id])
        expect(caughtUp.removed.sort()).toEqual([archived.id, deleted.id].sort())
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "reconciles active roots when newer archived sessions fill the window",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Session.Service
        const active = yield* createSession({ title: "active" })
        const archived = yield* Effect.forEach([1, 2, 3], (index) => createSession({ title: `archived-${index}` }))
        yield* Effect.forEach(archived, (item) => svc.setArchived({ sessionID: item.id, time: Date.now() }))
        yield* Effect.sync(() => Database.use((db) => archived.forEach((item) =>
          db.update(SessionTable).set({ time_updated: Date.now() + 60_000 }).where(eq(SessionTable.id, item.id)).run(),
        )))
        const result = yield* requestJson<{ upserts: Session.Info[]; limited: boolean }>(SessionPaths.reconcile, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ known: [], limit: 1 }),
        })
        expect(result.upserts.map((item) => item.id)).toEqual([active.id])
        expect(result.limited).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects unbounded reconciliation inputs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const post = (body: object) =>
          request(SessionPaths.reconcile, {
            method: "POST",
            headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        expect((yield* post({ known: [], limit: 0 })).status).toBe(400)
        expect((yield* post({ known: [], limit: 201 })).status).toBe(400)
        expect(
          (yield* post({
            known: Array.from({ length: 201 }, () => ({ id: SessionID.descending(), title: "x", updated: 0 })),
            limit: 20,
          })).status,
        ).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<MessageV2.WithParts[]>(messages)
        const nextCursor = messages.headers.get("x-next-cursor")
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<MessageV2.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ items: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, { headers }))
            .items,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        yield* insertLegacyAssistantMessage(session.id, 1)
        yield* insertLegacyAssistantMessage(session.id, 2)

        const sessionPage = yield* request(`/api/session?limit=1`, { headers })
        const sessionCursor = (yield* json<{ cursor: { next?: string } }>(sessionPage)).cursor.next
        expect(sessionCursor).toBeTruthy()

        const cursorWithFilter = yield* request(`/api/session?cursor=${sessionCursor}&search=v2`, { headers })
        expect(cursorWithFilter.status).toBe(400)
        expect(yield* responseJson(cursorWithFilter)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order or filters",
        })

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const mismatchedRouting = yield* request(`/api/session?cursor=${sessionCursor}&directory=/elsewhere`, {
          headers,
        })
        expect(mismatchedRouting.status).toBe(400)
        expect(yield* responseJson(mismatchedRouting)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor does not match requested directory or workspace",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          message: "Invalid workspace query parameter",
          field: "workspace",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageCursor = (yield* json<{ cursor: { next?: string } }>(messagePage)).cursor.next
        expect(messageCursor).toBeTruthy()

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public unavailable errors for unfinished session mutations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const prompt = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(503)
        expect(yield* responseJson(prompt)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "V2 session prompt is not available yet",
          service: "v2.session.prompt",
        })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "V2 session compact is not available yet",
          service: "v2.session.compact",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "V2 session wait is not available yet",
          service: "v2.session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers.get("x-next-cursor")).toBeTruthy()
        expect(response.headers.get("link")).toContain("limit=1")
        expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<MessageV2.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.permissions, {
              sessionID: session.id,
              permissionID: String(PermissionID.ascending()),
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ response: "once" }),
            },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
