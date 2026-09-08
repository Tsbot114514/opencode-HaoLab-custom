import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { ProjectBackup } from "@/project/backup"
import { GlobalBus } from "@/bus/global"
import { SessionStatus } from "@/session/status"
import { InstanceStore } from "@/project/instance-store"
import { ProjectBackupApiError } from "../groups/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const status = yield* SessionStatus.Service
    const instances = yield* InstanceStore.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID })
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("backup", ({ payload }) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const active = yield* status.active()
          return yield* Effect.tryPromise({
            try: () => ProjectBackup.backup({ directory: ctx.directory, path: payload.path, active }),
            catch: (error) =>
              new ProjectBackupApiError({ message: error instanceof Error ? error.message : String(error) }),
          })
        }),
      )
      .handle("inspectBackup", ({ payload }) =>
        Effect.tryPromise({
          try: () => ProjectBackup.inspect(payload),
          catch: (error) =>
            new ProjectBackupApiError({ message: error instanceof Error ? error.message : String(error) }),
        }),
      )
      .handle("restore", ({ payload }) =>
        Effect.gen(function* () {
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await ProjectBackup.restore({
                ...payload,
                resolveProject: (directory) =>
                  Effect.runPromise(svc.fromDirectory(directory, { persist: false, cacheIdentity: false })).then(
                    (result) => result.project,
                  ),
                active: () => Effect.runPromise(status.active()),
                invalidate: (directory) => Effect.runPromise(instances.disposeUnder(directory)),
              })
              // Also notify clients if the requesting HTTP fiber was interrupted during apply.
              GlobalBus.emit("event", {
                payload: { type: Project.Event.Restored.type, properties: { directory: result.directory } },
              })
              return result
            },
            catch: (error) =>
              new ProjectBackupApiError({ message: error instanceof Error ? error.message : String(error) }),
          })
        }),
      )
  }),
)
