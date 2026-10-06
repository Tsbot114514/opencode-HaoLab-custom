import { beforeAll, describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { isServer } from "solid-js/web"

let Timeline: typeof import("./message-timeline.data").Timeline
let TimelineRow: typeof import("./message-timeline.data").TimelineRow

beforeAll(async () => {
  if (isServer) return
  // The actual builder shares message-part rendering functions, which require browser exports.
  const model = await import("./message-timeline.data")
  Timeline = model.Timeline
  TimelineRow = model.TimelineRow
})

const user = (id: string): UserMessage => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
})
const assistant = (index: number, parentID = "msg_parent"): AssistantMessage => ({
  id: `msg_reply_${index}`,
  sessionID: "s",
  parentID,
  role: "assistant",
  agent: "build",
  mode: "build",
  modelID: "fixture",
  providerID: "fixture",
  path: { cwd: "/fixture", root: "/fixture" },
  time: { created: index + 1, completed: index + 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const parts = (messageID: string): Part[] => [
  {
    id: `part_${messageID}`,
    sessionID: "s",
    messageID,
    type: "text",
    text: `Reply ${messageID}`,
  },
]
const rows = (turn: UserMessage | string, replies: AssistantMessage[]) =>
  Timeline.constructMessageRows(turn, parts, replies, 0, true, "idle", false)

describe.skipIf(isServer)("partial mobile timeline", () => {
  test("twenty assistants retain their real missing parent without a fabricated prompt", () => {
    const replies = Array.from({ length: 20 }, (_, index) => assistant(index))
    expect(Timeline.turns(replies, [], true)).toEqual(["msg_parent"])
    const result = rows("msg_parent", replies)
    expect(result).toHaveLength(20)
    expect(result.every((row) => row._tag === "AssistantPart" && row.userMessageID === "msg_parent")).toBe(true)
    expect(result.filter((row) => row._tag === "UserMessage" || row._tag === "CommentStrip")).toEqual([])
  })

  test("loading the real user merges the turn without duplicate assistant keys", () => {
    const replies = [assistant(1), assistant(2)]
    const prompt = user("msg_parent")
    const partial = rows(prompt.id, replies)
    expect(Timeline.turns([prompt, ...replies], [prompt], true)).toEqual([prompt])
    const complete = rows(prompt, replies)
    expect(complete.filter((row) => row._tag === "UserMessage")).toHaveLength(1)
    expect(complete.filter((row) => row._tag === "AssistantPart").map(TimelineRow.key)).toEqual(
      partial.map(TimelineRow.key),
    )
    expect(new Set(complete.map(TimelineRow.key)).size).toBe(complete.length)
  })

  test("different missing parents remain separate from loaded users", () => {
    const prompt = user("msg_loaded")
    const messages: Message[] = [assistant(0, "msg_older"), prompt, assistant(1, prompt.id), assistant(2, "msg_newer")]
    expect(Timeline.turns(messages, [prompt], true)).toEqual(["msg_older", prompt, "msg_newer"])
    expect(rows("msg_older", [messages[0] as AssistantMessage])[0]).toMatchObject({ userMessageID: "msg_older" })
  })

  test("reverted or hidden loaded parents do not become partial turns", () => {
    const prompt = user("msg_parent")
    expect(Timeline.turns([prompt, assistant(1)], [], true)).toEqual([])
    expect(Timeline.turns([assistant(1, "msg_z")], [], true, "msg_y")).toEqual([])
  })

  test("live replies extend the same parent and introduce distinct new turns", () => {
    const first = [assistant(1)]
    expect(Timeline.turns([...first, assistant(2)], [], true)).toEqual(["msg_parent"])
    expect(Timeline.turns([...first, assistant(2, "msg_next")], [], true)).toEqual(["msg_parent", "msg_next"])
    expect(rows("msg_parent", [...first, assistant(2)]).map(TimelineRow.key)[0]).toBe(
      rows("msg_parent", first).map(TimelineRow.key)[0],
    )
  })

  test("desktop retains the provided user anchors and existing row layout", () => {
    const prompt = user("msg_parent")
    const users = [prompt]
    expect(Timeline.turns([assistant(1)], users, false)).toBe(users)
    expect(rows(prompt, [assistant(1)]).map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
    expect(Timeline.turns([assistant(1)], [], false)).toEqual([])
  })
})
