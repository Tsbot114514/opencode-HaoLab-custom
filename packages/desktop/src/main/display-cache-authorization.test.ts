import { describe, expect, test } from "bun:test"
import type { RemoteStatus } from "../preload/types"
import { allowDisplayCacheKey, validStoreName } from "./display-cache-authorization"

const first = `tunnel.v1.${"a".repeat(64)}`
const second = `tunnel.v1.${"b".repeat(64)}`
const paired = (cacheKey: string): RemoteStatus => ({
  enabled: false, online: true, hasAuthKey: false, autoJoin: false,
  cacheKey,
  connection: { host: "remote", url: "http://127.0.0.1:1234", username: "user", password: "bridge" },
})

describe("desktop display cache IPC ownership", () => {
  test("rejects filesystem aliases before authorization or store access", async () => {
    for (const name of ["./opencode.transcripts.dat", "folder/../opencode.transcripts.dat", "../opencode.sidebar-display.dat", "/opencode.transcripts.dat", "folder\\..\\opencode.transcripts.dat", "OPENCODE.TRANSCRIPTS.DAT", "opencode.transcripts.dat.", "opencode.transcripts.dat ", "opencode.transcripts.dat:stream"]) {
      expect(validStoreName(name)).toBe(false)
      expect(await allowDisplayCacheKey(name, "sidecar.v1", async () => paired("a".repeat(64)), () => undefined)).toBe(false)
    }
    expect(validStoreName("opencode.workspace.Work.123.dat")).toBe(true)
  })
  test("protects transcript storage with the same pairing boundary", async () => {
    const status = paired("a".repeat(64))
    expect(await allowDisplayCacheKey("opencode.transcripts.dat", first, async () => status, () => status.cacheKey)).toBe(true)
    expect(await allowDisplayCacheKey("opencode.transcripts.dat", second, async () => status, () => status.cacheKey)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.transcripts.dat", first, async () => ({ ...status, online: false }), () => status.cacheKey)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.transcripts.dat", "invalid", async () => status, () => status.cacheKey)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.transcripts.dat", "sidecar.v1", async () => status, () => status.cacheKey)).toBe(true)
  })
  test("allows only the currently paired identity for tunnel reads and writes", async () => {
    let status = paired("a".repeat(64))
    const remoteStatus = async () => status
    const current = (value: RemoteStatus) => value.cacheKey
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", first, remoteStatus, current)).toBe(true)
    status = paired("b".repeat(64))
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", first, remoteStatus, current)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", second, remoteStatus, current)).toBe(true)
    status = { ...status, online: false, cacheKey: undefined }
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", second, remoteStatus, current)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", "tunnel.v1.invalid", remoteStatus, current)).toBe(false)
    status = paired("a".repeat(64))
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", first, remoteStatus, () => undefined)).toBe(false)
  })

  test("fails closed on status errors without affecting sidecar or unrelated stores", async () => {
    const unavailable = async (): Promise<RemoteStatus> => { throw new Error("helper unavailable") }
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", first, unavailable, () => undefined)).toBe(false)
    expect(await allowDisplayCacheKey("opencode.sidebar-display.dat", "sidecar.v1", unavailable, () => undefined)).toBe(true)
    expect(await allowDisplayCacheKey("opencode.global.dat", first, unavailable, () => undefined)).toBe(true)
  })
})
