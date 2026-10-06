import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteStatus } from "../preload/types"
import type { TranscriptEntry } from "../../../app/src/context/global-sync/transcript-cache"

const directory = mkdtempSync(join(tmpdir(), "desktop-cache-test-"))
mkdirSync(join(directory, "remote-helper"))
const pairing = join(directory, "remote-helper", "pairing.share")
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const stores = new Map<string, Map<string, unknown>>()
mock.module("electron", () => ({
  app: { getPath: () => directory },
  session: {}, BrowserWindow: {}, Notification: class {}, clipboard: {}, dialog: {}, shell: {},
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler), on: () => {} },
}))
mock.module("./windows", () => ({ getPinchZoomEnabled: () => true, setPinchZoomEnabled: () => {}, setTitlebar: () => {}, updateTitlebar: () => {} }))
mock.module("./desktop-menu-actions", () => ({ runDesktopMenuAction: () => {} }))
mock.module("./store", () => ({
  getStore: (name = "settings") => {
    const data = stores.get(name) ?? new Map<string, unknown>()
    stores.set(name, data)
    return {
      get: (key: string) => data.get(key),
      set: (key: string, value: unknown) => data.set(key, value),
      delete: (key: string) => data.delete(key),
      clear: () => data.clear(),
      get store() { return Object.fromEntries(data) },
    }
  },
}))
const { registerIpcHandlers } = await import("./ipc")
const { RemoteHelper, pairingHost } = await import("./remote-helper")
const status: RemoteStatus = { enabled: false, online: false, hasAuthKey: false, autoJoin: false }
const share = (host = "remote.ts.net") => JSON.stringify({ version: 1, host, port: 41642, token: "a".repeat(64) })
const event = { sender: { id: 1, once: () => {} } }
const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args)
const sidebar = "opencode.sidebar-display.dat"
const transcripts = "opencode.transcripts.dat"
const other = `tunnel.v1.${"b".repeat(64)}`

beforeEach(() => {
  stores.clear()
  handlers.clear()
  rmSync(pairing, { force: true })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function setup(remoteStatus: () => Promise<RemoteStatus>) {
  writeFileSync(pairing, share()) // Synthetic invitation only; no real credentials.
  const remote = new RemoteHelper()
  const run = spyOn(remote as unknown as { run: (command: string) => Promise<RemoteStatus> }, "run")
  run.mockResolvedValue(status)
  registerIpcHandlers({
    remoteStatus,
    remoteCacheKeyCurrent: () => remote.currentCacheKey(),
    remoteDisconnect: () => remote.disconnect(),
    remoteConnect: (value) => remote.connect(value),
  } as Parameters<typeof registerIpcHandlers>[0])
  return { remote, run, key: `tunnel.v1.${remote.currentCacheKey()}` }
}

describe("actual desktop cache IPC", () => {
  test("granular IPC preserves another window's historical edit and removes an unloaded canonical message", async () => {
    const { key } = setup(mock(async () => status))
    const session = Array.from({ length: 80 }, (_, index) => ({
      id: `m${index}`, sessionID: "s", role: "user", time: { created: index }, agent: "build", model: { providerID: "fixture", modelID: "fixture" },
    }))
    stores.set(transcripts, new Map([[key, JSON.stringify({ version: 1, entries: [{ directory: "/fixture", sessionID: "s", session,
      part: session.map((message) => ({ id: message.id, part: [{ id: "p", messageID: message.id, sessionID: "s", type: "text", text: "original" }] })), complete: true }] })]]))
    const opened = await invoke("transcript-open", key) as { owner: string }
    const page = await invoke("transcript-read-page", key, opened.owner, "/fixture", "s") as TranscriptEntry
    const b = { sender: { id: 2, once() {} } }
    const other = await handlers.get("transcript-open")!(b, key) as { owner: string }
    await handlers.get("transcript-mutate")!(b, key, other.owner, [{ type: "event", directory: "/fixture", sessionID: "s",
      event: { type: "message.part.updated", part: { id: "p", messageID: "m40", sessionID: "s", type: "text", text: "other window edit" } } }])
    const grant = await invoke("transcript-acquire", key, opened.owner, "/fixture", "s") as { token: string }
    await invoke("transcript-mutate", key, opened.owner, [{ type: "write", entry: page, page: { session: page.session, part: page.part, cursor: page.cursor, complete: page.complete }, range: {}, fresh: grant.token },
      { type: "event", directory: "/fixture", sessionID: "s", event: { type: "message.part.delta", messageID: "m79", partID: "p", delta: "!" } }])
    const saved = () => (JSON.parse(stores.get(transcripts)!.get(key) as string).entries as TranscriptEntry[])[0]
    expect(saved().part.find((part) => part.id === "m40")?.part[0]).toMatchObject({ text: "other window edit" })
    expect(saved().part.find((part) => part.id === "m79")?.part[0]).toMatchObject({ text: "original!" })
    await invoke("transcript-mutate", key, "foreign-owner", [{ type: "removeMessage", directory: "/fixture", sessionID: "s", messageID: "m40" }])
    expect(saved().session).toHaveLength(80)
    await invoke("transcript-mutate", key, opened.owner, [{ type: "removeMessage", directory: "/fixture", sessionID: "s", messageID: "m40" }])
    expect(saved().session).toHaveLength(79)
    expect(saved().part.some((part) => part.id === "m40")).toBe(false)
    expect(saved().complete).toBe(true)
    await handlers.get("transcript-mutate")!(b, key, other.owner, [{ type: "removeMessage", directory: "/fixture", sessionID: "s", messageID: "m41" }])
    expect(saved().session.some((message) => message.id === "m41")).toBe(true)
  })
  test("startup IPC transfers no transcripts and selected IPC is bounded with 100 sessions of 400 messages", async () => {
    const { key } = setup(mock(async () => status))
    const entries = Array.from({ length: 100 }, (_, index) => {
      const sessionID = `s${index}`
      const session = Array.from({ length: 400 }, (_, index) => ({
        id: `m${index}`, sessionID, role: "user", time: { created: index }, agent: "build", model: { providerID: "fixture", modelID: "fixture" },
      }))
      return { directory: "/fixture", sessionID, session, part: session.map((message) => ({ id: message.id, part: [] })), complete: true }
    })
    const raw = JSON.stringify({ version: 1, entries })
    expect(Buffer.byteLength(raw)).toBeLessThan(16 * 1024 * 1024)
    stores.set(transcripts, new Map([[key, raw]]))
    const opened = await invoke("transcript-open", key) as { owner: string }
    expect(Object.keys(opened)).toEqual(["owner"])
    expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThan(100)
    const page = await invoke("transcript-read-page", key, opened.owner, "/fixture", "s50") as { session: unknown[]; part: unknown[] }
    expect(page.session).toHaveLength(20)
    expect(page.part).toHaveLength(20)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10000)
  })
  for (const health of ["delayed", "throwing"]) test(`cache I/O never calls ${health} remoteStatus`, async () => {
    const remoteStatus = mock((): Promise<RemoteStatus> => health === "delayed"
      ? new Promise(() => {})
      : Promise.reject(new Error("offline")))
    const { key } = setup(remoteStatus)
    await invoke("store-set", sidebar, key, "cached")
    expect(await invoke("store-get", sidebar, key)).toBe("cached")
    await invoke("store-set", sidebar, other, "foreign")
    expect(await invoke("store-get", sidebar, other)).toBeNull()
    expect(await invoke("store-keys", sidebar)).toEqual([key])
    expect(await invoke("store-length", sidebar)).toBe(1)
    const snapshot = JSON.parse(await invoke("store-get", transcripts, key) as string)
    const opened = await invoke("transcript-open", key) as { owner: string }
    expect(Object.keys(opened)).toEqual(["owner"])
    expect(await invoke("transcript-open", other)).toBeUndefined()
    expect(await invoke("transcript-read-page", other, opened.owner, "/work", "session")).toBeUndefined()
    expect(await invoke("transcript-read-page", key, "foreign-owner", "/work", "session")).toBeUndefined()
    await invoke("transcript-acquire", key, snapshot.owner, "/work", "session")
    await invoke("transcript-mutate", key, snapshot.owner, [])
    expect(await invoke("store-get", transcripts, other)).toBeNull()
    await invoke("store-delete", transcripts, key)
    await invoke("store-delete", sidebar, key)
    expect(await invoke("store-get", sidebar, key)).toBeNull()
    expect(remoteStatus).not.toHaveBeenCalled()
    if (health === "throwing") {
      await expect(invoke("remote-status")).rejects.toThrow("offline")
      expect(remoteStatus).toHaveBeenCalledTimes(1)
    }
  })

  test("aliases cannot bypass protected stores", async () => {
    const { key } = setup(mock(async () => status))
    for (const alias of ["./opencode.transcripts.dat", "OPENCODE.TRANSCRIPTS.DAT", "opencode.sidebar-display.dat.", "../opencode.sidebar-display.dat"]) {
      await invoke("store-set", alias, key, "bypass")
      expect(await invoke("store-get", alias, key)).toBeNull()
      expect(await invoke("store-keys", alias)).toEqual([])
      expect(await invoke("store-length", alias)).toBe(0)
      await invoke("store-clear", alias)
      expect(stores.has(alias)).toBe(false)
    }
  })

  test("disconnect revokes immediately while helper is pending and queued mutations cannot recreate data", async () => {
    const { remote, run, key } = setup(mock(async () => status))
    await invoke("store-set", sidebar, key, "cached")
    const snapshot = JSON.parse(await invoke("store-get", transcripts, key) as string)
    await invoke("transcript-mutate", key, snapshot.owner, [])
    let finish!: (value: RemoteStatus) => void
    run.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const stale = invoke("transcript-mutate", key, snapshot.owner, [])
    const disconnect = invoke("remote-disconnect")
    expect(remote.currentCacheKey()).toBeUndefined()
    expect(existsSync(pairing)).toBe(false)
    await stale
    await invoke("store-set", sidebar, key, "stale")
    expect(stores.get(sidebar)?.has(key)).toBe(false)
    expect(stores.get(transcripts)?.has(key)).toBe(false)
    finish(status)
    await disconnect
    expect(remote.currentCacheKey()).toBeUndefined()
  })

  test("a stale connect cannot restore pairing after disconnect", async () => {
    const { remote, run } = setup(mock(async () => status))
    let finish!: (value: RemoteStatus) => void
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const connect = remote.connect(share("new.ts.net"))
    expect(remote.currentCacheKey()).toBeUndefined()
    await remote.disconnect()
    finish(status)
    expect((await connect).cacheKey).toBeUndefined()
    expect(remote.currentCacheKey()).toBeUndefined()
    expect(existsSync(pairing)).toBe(false)
  })

  test("failed disconnect remains revoked and restart cannot restore it", async () => {
    const { remote, run, key } = setup(mock(async () => status))
    await invoke("store-set", sidebar, key, "cached")
    run.mockRejectedValue(new Error("helper unavailable"))
    await expect(invoke("remote-disconnect")).rejects.toThrow("helper unavailable")
    expect(remote.currentCacheKey()).toBeUndefined()
    expect(new RemoteHelper().currentCacheKey()).toBeUndefined()
    expect(stores.get(sidebar)?.has(key)).toBe(false)
  })

  test("re-pair denies the old identity before network completion", async () => {
    const { remote, run, key } = setup(mock(async () => status))
    await invoke("store-set", sidebar, key, "cached")
    let finish!: (value: RemoteStatus) => void
    run.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const connect = invoke("remote-connect", share("new.ts.net"))
    expect(remote.currentCacheKey()).toBeUndefined()
    expect(await invoke("store-get", sidebar, key)).toBeNull()
    await invoke("store-set", sidebar, key, "stale")
    expect(stores.get(sidebar)?.has(key)).toBe(false)
    finish({ ...status, online: true })
    await connect
    expect(remote.currentCacheKey()).toBeDefined()
    expect(await invoke("store-get", sidebar, key)).toBeNull()
  })

  test("saved identity is available before helper startup, survives offline status, and changes on re-pair", async () => {
    const { remote, run, key } = setup(mock(async () => status))
    expect(remote.currentCacheKey()).toBe(createHash("sha256").update("opencode.desktop.remote-display-cache.v1\0").update(share()).update("\0remote.ts.net").digest("hex"))
    expect(run).not.toHaveBeenCalled()
    expect((await remote.status()).cacheKey).toBe(remote.currentCacheKey())
    run.mockResolvedValue({ ...status, online: true })
    await remote.connect(share("new.ts.net"))
    expect(`tunnel.v1.${remote.currentCacheKey()}`).not.toBe(key)
    expect(await invoke("store-get", sidebar, key)).toBeNull()
    run.mockResolvedValue({ ...status, connection: { host: "remote.ts.net", url: "http://127.0.0.1:1234", username: "synthetic", password: "synthetic" } })
    expect((await remote.status()).cacheKey).toBeUndefined()
  })

  test("local pairing validates host and invitation constraints", () => {
    for (const host of ["remote.ts.net", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) expect(pairingHost(share(host))).toBe(host)
    for (const host of ["REMOTE.ts.net", "remote.ts.net.evil", "127.0.0.1", "100.128.0.1", "fd7a:115c:a1e1::1", "::ffff:100.64.0.1", "fd7a:115c:a1e0::1%en0", "-remote.ts.net"]) expect(pairingHost(share(host))).toBeUndefined()
    expect(pairingHost("invalid")).toBeUndefined()
    expect(pairingHost(share().replace('"version":1', '"version":3'))).toBeUndefined()
    expect(pairingHost(share().replace('"port":41642', '"port":80'))).toBeUndefined()
  })
})
