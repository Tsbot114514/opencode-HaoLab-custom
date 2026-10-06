import { expect, test } from "bun:test"
import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createDirSyncContext } from "./directory-sync"
import { createTranscriptCache, transcriptCursor } from "./global-sync/transcript-cache"
import type { State } from "./global-sync/types"
import { createMobileReadTransport } from "../utils/mobile-request"

test("directory recovery retains loaded history and optimistic messages while replacing a stale SDK read", async () => {
  const host = window as Window & { __HAOLAB_MOBILE__?: boolean }
  const previous = host.__HAOLAB_MOBILE__
  host.__HAOLAB_MOBILE__ = true
  const directory = "/synthetic/recovery"
  const sessionID = "ses_recovery"
  const session = { id: sessionID, directory, projectID: "fixture", slug: "fixture", title: "Synthetic", version: "1", time: { created: 1, updated: 40 } }
  const messages = Array.from({ length: 40 }, (_, index) => ({
    info: { id: `msg_${String(index).padStart(2, "0")}`, sessionID, role: "user", time: { created: index }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } } as Message,
    parts: [{ id: `part_${index}`, sessionID, messageID: `msg_${String(index).padStart(2, "0")}`, type: "text", text: "synthetic" } as Part],
  }))
  const disk = new Map([["sidecar.v1", JSON.stringify({ version: 1, entries: [{ directory, sessionID,
    session: messages.map((message) => message.info), part: messages.map((message) => ({ id: message.info.id, part: message.parts })), complete: true, updated: 40,
  }] })]])
  const transcript = createTranscriptCache({ getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value) }, removeItem: (key) => { disk.delete(key) } }, "sidecar.v1")
  let epoch = 0
  let hold = false
  let release: ((response: Response) => void) | undefined
  let fresh = false
  const requests: URL[] = []
  const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.includes("/transcript/")) return new Response("Unknown route", { status: 404 })
    requests.push(url)
    if (url.pathname.endsWith("/message")) {
      if (hold) { hold = false; return new Promise<Response>((resolve) => { release = resolve }) }
      const before = url.searchParams.get("before")
      const page = before ? messages.slice(0, 20) : messages.slice(-20)
      return Response.json(page.map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part, text: fresh ? "fresh" : "synthetic" })) })), {
        headers: before ? {} : { "x-next-cursor": transcriptCursor(messages[20].info) },
      })
    }
    return Response.json(session)
  }, { preconnect: fetch.preconnect }))
  const client = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
  const child = createStore({ session: [session], message: {}, part: {}, part_text_accum_delta: {}, status: "complete", path: { directory }, todo: {}, session_diff: {} } as unknown as State)
  let dispose = () => {}
  try {
    const context = createRoot((cleanup) => {
      dispose = cleanup
      return createDirSyncContext(client, directory, { child: () => child, data: { project: [], session_todo: {} }, todo: { set() {} }, transcript,
        recovery: { epoch: () => epoch, signal: transport.signal },
      })
    })
    await context.session.sync(sessionID, { force: true })
    await context.session.history.loadMore(sessionID)
    expect(child[0].message[sessionID]).toHaveLength(40)
    expect(context.session.history.more(sessionID)).toBe(false)
    context.session.optimistic.add({ sessionID, message: { ...messages[39].info, id: "msg_optimistic", time: { created: 100 } }, parts: [] })
    hold = true
    const old = context.session.sync(sessionID, { force: true }).catch((error: unknown) => error)
    while (!release) await Bun.sleep(0)
    transport.invalidate()
    epoch++
    transcript.invalidate()
    context.recover()
    expect(child[0].message[sessionID]).toHaveLength(41)
    expect(context.session.history.more(sessionID)).toBe(false)
    fresh = true
    await context.session.sync(sessionID, { force: true })
    expect(await old).toMatchObject({ name: "AbortError" })
    expect(child[0].message[sessionID]).toHaveLength(41)
    expect(child[0].message[sessionID]?.at(-1)?.id).toBe("msg_optimistic")
    expect(child[0].part.msg_00?.[0]).toMatchObject({ text: "synthetic" })
    expect(requests.filter((url) => url.pathname.endsWith("/message") && url.searchParams.has("before"))).toHaveLength(1)
    await context.session.history.validate(sessionID, transcriptCursor(messages[20].info))
    expect(child[0].part.msg_00?.[0]).toMatchObject({ text: "fresh" })
    release?.(Response.json(messages.slice(-20)))
    await Bun.sleep(0)
    expect(child[0].part.msg_00?.[0]).toMatchObject({ text: "fresh" })
    expect(requests.filter((url) => url.pathname.endsWith("/message") && url.searchParams.has("before"))).toHaveLength(2)
    await transcript.flush()
    expect(disk.get("sidecar.v1")).toContain("fresh")
  } finally {
    dispose()
    transcript.dispose()
    host.__HAOLAB_MOBILE__ = previous
  }
})
