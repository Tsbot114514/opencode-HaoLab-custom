import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyPendingRequests } from "./pending-requests"

describe("applyPendingRequests", () => {
  test("restores pending requests and removes requests resolved while disconnected", () => {
    const [store, setStore] = createStore({
      permission: { ses_old: [{ id: "per_old", sessionID: "ses_old" }] },
      question: { ses_old: [{ id: "que_old", sessionID: "ses_old" }] },
    } as unknown as State)
    applyPendingRequests({
      store,
      setStore,
      permissions: [
        { id: "per_b", sessionID: "ses_active" },
        { id: "per_a", sessionID: "ses_active" },
      ] as State["permission"][string],
      questions: [{ id: "que_new", sessionID: "ses_active" }] as State["question"][string],
    })

    expect(store.permission.ses_old).toEqual([])
    expect(store.question.ses_old).toEqual([])
    expect(store.permission.ses_active.map((item) => item.id)).toEqual(["per_a", "per_b"])
    expect(store.question.ses_active.map((item) => item.id)).toEqual(["que_new"])
  })
})
