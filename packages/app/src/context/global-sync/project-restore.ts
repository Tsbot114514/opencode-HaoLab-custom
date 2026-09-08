import { batch } from "solid-js"
import { produce, type SetStoreFunction, type Store } from "solid-js/store"
import { directoryKey } from "./utils"
import { cleanupDroppedSessionCaches } from "./event-reducer"
import { clearSessionPrefetchDirectory } from "./session-prefetch"
import type { State } from "./types"

const revisions = new WeakMap<Store<State>, number>()

export const projectSessionRevision = (store: Store<State>) => revisions.get(store) ?? 0

export function projectRestoreDirectories(event: { type: string; properties?: unknown }, directories: string[]) {
  if (event.type !== "project.restored") return []
  const props = event.properties
  if (!props || typeof props !== "object" || !("directory" in props) || typeof props.directory !== "string") return []
  const root = directoryKey(props.directory)
  if (!root) return []
  const windows = /^[a-z]:\//i.test(root) || root.startsWith("//")
  const normalized = windows ? root.toLowerCase() : root
  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`
  return directories.filter((directory) => {
    const key = directoryKey(directory)
    const candidate = windows ? key.toLowerCase() : key
    return candidate === normalized || candidate.startsWith(prefix)
  })
}

export function resetProjectSessions(input: {
  directory: string
  store: Store<State>
  setStore: SetStoreFunction<State>
  clearTodo: (sessionID: string) => void
  sessionMeta: Map<string, { limit: number }>
  sessionLoads: Map<string, Promise<void>>
  clearQuery: (directory: string) => void
}) {
  revisions.set(input.store, projectSessionRevision(input.store) + 1)
  input.sessionMeta.delete(input.directory)
  input.sessionLoads.delete(input.directory)
  input.clearQuery(input.directory)
  clearSessionPrefetchDirectory(input.directory)
  batch(() => {
    for (const session of input.store.session) input.clearTodo(session.id)
    cleanupDroppedSessionCaches(input.store, input.setStore, [], input.clearTodo)
    input.setStore(
      produce((draft) => {
        draft.session = []
        draft.sessionTotal = 0
        draft.message = {}
        draft.part = {}
        draft.part_text_accum_delta = {}
        draft.session_diff = {}
        draft.todo = {}
        draft.session_status = {}
        draft.permission = {}
        draft.question = {}
      }),
    )
  })
}
