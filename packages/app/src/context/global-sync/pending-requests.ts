import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State } from "./types"

export function applyPendingRequests(input: {
  store: Store<State>
  setStore: SetStoreFunction<State>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}) {
  const group = <T extends { id: string; sessionID: string }>(items: T[]) =>
    items.reduce<Record<string, T[]>>((result, item) => {
      if (!item.id || !item.sessionID) return result
      ;(result[item.sessionID] ??= []).push(item)
      return result
    }, {})
  const permissions = group(input.permissions)
  const questions = group(input.questions)

  batch(() => {
    for (const id of new Set([...Object.keys(input.store.permission), ...Object.keys(permissions)])) {
      input.setStore("permission", id, reconcile((permissions[id] ?? []).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), { key: "id" }))
    }
    for (const id of new Set([...Object.keys(input.store.question), ...Object.keys(questions)])) {
      input.setStore("question", id, reconcile((questions[id] ?? []).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), { key: "id" }))
    }
  })
}
