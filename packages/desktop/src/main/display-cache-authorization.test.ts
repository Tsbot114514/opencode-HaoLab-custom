import { describe, expect, test } from "bun:test"
import { allowDisplayCacheKey, validStoreName } from "./display-cache-authorization"

const first = `tunnel.v1.${"a".repeat(64)}`
const second = `tunnel.v1.${"b".repeat(64)}`

describe("desktop display cache ownership", () => {
  test("rejects filesystem aliases before authorization or store access", () => {
    for (const name of ["./opencode.transcripts.dat", "folder/../opencode.transcripts.dat", "../opencode.sidebar-display.dat", "/opencode.transcripts.dat", "folder\\..\\opencode.transcripts.dat", "OPENCODE.TRANSCRIPTS.DAT", "opencode.transcripts.dat.", "opencode.transcripts.dat ", "opencode.transcripts.dat:stream"]) {
      expect(validStoreName(name)).toBe(false)
      expect(allowDisplayCacheKey(name, "sidecar.v1", () => undefined)).toBe(false)
    }
    expect(validStoreName("opencode.workspace.Work.123.dat")).toBe(true)
  })

  test("authorizes only the local paired identity, independent of health", () => {
    for (const name of ["opencode.transcripts.dat", "opencode.sidebar-display.dat"]) {
      expect(allowDisplayCacheKey(name, first, () => "a".repeat(64))).toBe(true)
      expect(allowDisplayCacheKey(name, second, () => "a".repeat(64))).toBe(false)
      expect(allowDisplayCacheKey(name, first, () => "b".repeat(64))).toBe(false)
      expect(allowDisplayCacheKey(name, first, () => undefined)).toBe(false)
      expect(allowDisplayCacheKey(name, "invalid", () => "a".repeat(64))).toBe(false)
      expect(allowDisplayCacheKey(name, "sidecar.v1", () => undefined)).toBe(true)
    }
    expect(allowDisplayCacheKey("opencode.global.dat", first, () => undefined)).toBe(true)
  })
})
