import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { projectMobileTranscript } from "./directory-sync"

const sessionID = "ses_1"
const directory = "/one"
type Text = Extract<Part, { type: "text" }>
const user = (id: string, created: number): Message => ({
  id, sessionID, role: "user", time: { created }, agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})
const text = (id: string, messageID: string, value: string): Text => ({
  id, messageID, sessionID, type: "text", text: value,
})

describe("mobile transcript projection", () => {
  test("takes only the newest 20 messages from the fetched page", () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      info: user(`m${index}`, index), parts: [text(`p${index}`, `m${index}`, `body ${index}`)],
    })).reverse()
    const projected = projectMobileTranscript(directory, sessionID, items)
    expect(projected.messages.map((message) => message.id)).toEqual(Array.from({ length: 20 }, (_, index) => `m${index + 5}`))
    expect(projected).toEqual({ directory, sessionID, messages: projected.messages })
  })

  test("only emits non-synthetic matching text, without truncating or leaking other parts", () => {
    const first = user("m1", 1)
    const projected = projectMobileTranscript(directory, sessionID, [
      { info: first, parts: [
        text("p1", "m1", "visible"),
        { ...text("p2", "m1", "hidden"), synthetic: true },
        { ...text("p3", "other", "wrong message") },
        { ...text("p4", "m1", "wrong session"), sessionID: "other" },
        { id: "p5", sessionID, messageID: "m1", type: "reasoning", text: "private" } as Part,
      ] },
      { info: user("m2", 2), parts: [text("p6", "m2", "x".repeat(6001))] },
      { info: user("m3", 3), parts: [text("p7", "m3", "x".repeat(4000)), text("p8", "m3", "y".repeat(2000))] },
      { info: { ...user("m4", 4), sessionID: "other" }, parts: [text("p9", "m4", "wrong session")] },
      { info: first, parts: [text("p10", "m1", "duplicate")] },
    ])
    expect(projected.messages).toEqual([{ id: "m1", role: "user", created: 1, text: "visible" }])
  })
})
