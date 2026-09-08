import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Server } from "@/server/server"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap)),
    CrossSpawnSpawner.defaultLayer,
    SessionStatus.defaultLayer,
  ),
)

describe("project backup HTTP API", () => {
  it.instance("uses query directory and returns exact backup/restore response contracts", () =>
    Effect.gen(function* () {
      const source = yield* TestInstance
      const root = yield* tmpdirScoped()
      const destination = path.join(root, "restored")
      const archive = path.join(root, "project.zip")
      const clients = [[], []] as GlobalEvent[][]
      for (const events of clients) {
        const listener = (event: GlobalEvent) => {
          if (event.payload.type === "project.restored") events.push(event)
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
      }
      yield* Effect.promise(async () => {
        await fs.mkdir(destination)
        await fs.writeFile(path.join(source.directory, ".hidden"), "project data")
        const response = await Server.Default().app.request(
          `/project/backup?directory=${encodeURIComponent(source.directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: archive }),
          },
        )
        expect(response.status).toBe(200)
        const backup = await response.json()
        expect(Object.keys(backup).sort()).toEqual(["files", "path", "sessions", "warnings"])
        expect(backup).toMatchObject({ path: archive, files: 2, sessions: 0 })
        const inspected = await Server.Default().app.request(
          `/project/backup/inspect?directory=${encodeURIComponent(source.directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: archive, directory: destination }),
          },
        )
        expect(inspected.status).toBe(200)
        const preview = await inspected.json()
        expect(Object.keys(preview).sort()).toEqual([
          "action",
          "candidates",
          "directory",
          "local",
          "package",
          "previewToken",
          "warnings",
        ])
        expect(Object.keys(preview.package).sort()).toEqual([
          "createdAt",
          "files",
          "filesUpdatedAt",
          "identity",
          "name",
          "sessions",
          "sessionsUpdatedAt",
        ])
        expect(preview.action).toBe("create")
        const restored = await Server.Default().app.request(
          `/project/restore?directory=${encodeURIComponent(source.directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: archive,
              directory: destination,
              previewToken: preview.previewToken,
              overwrite: false,
            }),
          },
        )
        expect(restored.status).toBe(200)
        const body = await restored.json()
        expect(Object.keys(body).sort()).toEqual(["directory", "files", "safetyPath", "sessions", "warnings"])
        expect(body).toMatchObject({ directory: destination, files: 2, sessions: 0, safetyPath: null })
        expect(await fs.readFile(path.join(destination, ".hidden"), "utf8")).toBe("project data")
        for (const events of clients) {
          expect(events).toHaveLength(1)
          expect(events[0].directory).toBeUndefined()
          expect(events[0].payload).toMatchObject({ type: "project.restored", properties: { directory: destination } })
        }
      })
    }),
  )

  it.instance("returns explicit message errors for invalid backup and restore paths", () =>
    Effect.gen(function* () {
      const source = yield* TestInstance
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.type === "project.restored") events.push(event)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
      yield* Effect.promise(async () => {
        for (const route of ["backup", "backup/inspect", "restore"]) {
          const response = await Server.Default().app.request(
            `/project/${route}?directory=${encodeURIComponent(source.directory)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                path: "relative.zip",
                directory: source.directory,
                previewToken: "invalid",
                overwrite: false,
              }),
            },
          )
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({ message: expect.stringContaining("absolute") })
        }
        expect(events).toEqual([])
      })
    }),
  )

  it.instance("tracks active target sessions across instances and invalidates only the affected cache", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const instances = yield* InstanceStore.Service
      const status = yield* SessionStatus.Service
      const ctx = yield* instances.load({ directory })
      const managerID = SessionID.make(`ses_manager${crypto.randomUUID().replaceAll("-", "")}`)
      const targetID = SessionID.make(`ses_target${crypto.randomUUID().replaceAll("-", "")}`)
      yield* status.set(managerID, { type: "busy" })
      yield* status.set(targetID, { type: "busy" }).pipe(Effect.provideService(InstanceRef, ctx))
      expect((yield* status.list()).has(targetID)).toBe(false)
      expect((yield* status.active()).has(targetID)).toBe(true)
      yield* instances.disposeUnder(directory)
      expect((yield* status.active()).has(targetID)).toBe(false)
      expect((yield* status.active()).has(managerID)).toBe(true)
      expect(yield* instances.load({ directory })).not.toBe(ctx)
    }),
  )
})
