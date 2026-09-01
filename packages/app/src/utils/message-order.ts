import type { Message } from "@opencode-ai/sdk/v2/client"

export function compareMessages(a: Message, b: Message) {
  if (a.time.created !== b.time.created) return a.time.created - b.time.created
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function findMessage(messages: Message[], id: string) {
  return messages.findIndex((message) => message.id === id)
}
