import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerConnection } from "../server"
import type { State } from "./types"
import { captureDirectory, captureQueries, restoreDirectory, restoreQueries, serverDisplayCache } from "./server-cache"

const connection = (password: string): ServerConnection.Any => ({
  type: "http", http: { url: "http://example.test", username: "someone", password },
})

describe("server display cache", () => {
  test("isolates server keys and credential changes without retaining secrets in snapshots", () => {
    const a = connection("secret-a")
    const first = serverDisplayCache("server-a", a)!
    first.projects.push({ id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] })
    expect(serverDisplayCache("server-b", connection("secret-a"))?.projects).toEqual([])
    expect(serverDisplayCache("server-a", a)).toBe(first)
    expect(serverDisplayCache("server-a", connection("secret-a"))).toBe(first)
    a.http.password = "secret-b"
    expect(serverDisplayCache("server-a", a)?.projects).toEqual([])
    expect(JSON.stringify(first)).not.toContain("secret-a")
  })

  test("invalidates in-memory tunnel snapshots when pairing changes on the same bridge", () => {
    const conn: ServerConnection.Tunnel = {
      type: "tunnel", host: "remote", cacheKey: "a".repeat(64),
      http: { url: "http://127.0.0.1:1234", password: "bridge-password" },
    }
    const first = serverDisplayCache("tunnel:remote", conn)!
    first.projects.push({ id: "old", worktree: "/old", time: { created: 1, updated: 1 }, sandboxes: [] })
    conn.cacheKey = "b".repeat(64)
    expect(serverDisplayCache("tunnel:remote", conn)?.projects).toEqual([])
  })

  test("restores title summaries and only the latest 20 viewed messages in memory", () => {
    const snapshot = serverDisplayCache("sessions", connection("account"))!
    captureDirectory(snapshot, "/work", {
      project: "project", sessionTotal: 90,
      session: Array.from({ length: 65 }, (_, i) => ({
        id: `ses_${String(i).padStart(3, "0")}`, directory: "/work", projectID: "project",
        slug: `slug-${i}`, title: `Title ${i}`, version: "1", time: { created: i, updated: i },
        permission: { read: "allow" },
      })),
      message: { ses_000: Array.from({ length: 25 }, (_, i) => ({ id: `msg_${i}`, sessionID: "ses_000" })) },
      part: { msg_24: [{ id: "part_24", messageID: "msg_24", sessionID: "ses_000", type: "text", text: "last message" }] },
    } as unknown as State)
    expect(restoreDirectory(snapshot, "/work")?.sessions).toHaveLength(55)
    expect(restoreDirectory(snapshot, "/work")?.total).toBe(90)
    expect(restoreDirectory(snapshot, "/work")?.transcript?.messages).toHaveLength(20)
    expect(restoreDirectory(snapshot, "/work")?.transcript?.messages[0]?.id).toBe("msg_5")
    expect(restoreDirectory(snapshot, "/work")?.transcript?.parts.msg_24).toHaveLength(1)
    expect(restoreDirectory(snapshot, "/work")?.transcript?.parts.msg_0).toBeUndefined()
    expect(JSON.stringify(snapshot.directories.get("/work"))).not.toContain("permission")
  })

  test("skips oversized transcripts but retains the sidebar titles", () => {
    const snapshot = serverDisplayCache("oversized", connection("account"))!
    captureDirectory(snapshot, "/work", {
      project: "project", sessionTotal: 1,
      session: [{ id: "ses_1", directory: "/work", title: "Title", time: { created: 1, updated: 2 } }],
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1" }] },
      part: { msg_1: [{ id: "part_1", text: "x".repeat(130 * 1024) }] },
    } as unknown as State)
    expect(restoreDirectory(snapshot, "/work")?.sessions).toHaveLength(1)
    expect(restoreDirectory(snapshot, "/work")?.transcript).toBeUndefined()
  })

  test("seeds only display queries and removes credential fields from config", () => {
    const snapshot = serverDisplayCache("queries", connection("account"))!
    const source = new QueryClient()
    source.setQueryData(["config"], { provider: { example: { apiKey: "private", name: "Example" } } })
    source.setQueryData([null, "path"], { directory: "/work", state: "", data: "", config: "", worktree: "", home: "" })
    source.setQueryData(["/work", "loadSessions"], { body: "private message" })
    captureQueries(snapshot, source)
    const target = new QueryClient()
    restoreQueries(snapshot, target)
    expect(target.getQueryData([null, "path"])).toMatchObject({ directory: "/work" })
    expect(target.getQueryData(["/work", "loadSessions"])).toBeUndefined()
    expect(JSON.stringify(target.getQueryData(["config"]))).not.toContain("private")
  })

  test("evicts old directories and servers", () => {
    const first = serverDisplayCache("bounded-first", connection("account"))!
    Array.from({ length: 31 }, (_, i) => i).forEach((i) => captureDirectory(first, `/dir-${i}`, {
      project: "", sessionTotal: 0, session: [], message: {}, part: {},
    } as unknown as State))
    expect(first.directories.size).toBe(30)
    expect(restoreDirectory(first, "/dir-0")).toBeUndefined()
    serverDisplayCache("bounded-second", connection("account"))
    serverDisplayCache("bounded-third", connection("account"))
    serverDisplayCache("bounded-fourth", connection("account"))
    expect(serverDisplayCache("bounded-first", connection("account"))?.directories.size).toBe(0)
  })
})
