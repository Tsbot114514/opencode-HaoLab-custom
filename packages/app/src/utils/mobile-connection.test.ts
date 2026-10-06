import { describe, expect, test } from "bun:test"
import { createMobileRefreshCoordinator, readMobileConnection, requestMobileConnectionRefresh, validateMobileConnection } from "./mobile-connection"

describe("mobile connection", () => {
  test("validates native state and strips untrusted fields", () => {
    expect(validateMobileConnection({ state: "connected", active: true, revision: 2, password: "secret" }))
      .toEqual({ state: "connected", active: true, revision: 2 })
    for (const value of [null, {}, { state: "online", active: true, revision: 0 },
      { state: "offline", active: "true", revision: 0 }, { state: "offline", active: false, revision: -1 },
      { state: "connecting", active: true, revision: 1.5 }]) expect(validateMobileConnection(value)).toBeUndefined()
  })

  test("older apps have no native signal and refresh sends only the fixed operation", () => {
    const previous = globalThis.window
    const sent: unknown[] = []
    try {
      globalThis.window = {} as Window & typeof globalThis
      expect(readMobileConnection()).toBeUndefined()
      expect(requestMobileConnectionRefresh()).toBe(false)
      globalThis.window = { __HAOLAB_CONNECTION__: { state: "offline", active: false, revision: 3 },
        webkit: { messageHandlers: { haolabConnection: { postMessage: (value: unknown) => sent.push(value) } } },
      } as unknown as Window & typeof globalThis
      expect(readMobileConnection()).toEqual({ state: "offline", active: false, revision: 3 })
      expect(requestMobileConnectionRefresh()).toBe(true)
      expect(sent).toEqual([{ operation: "refresh" }])
    } finally {
      globalThis.window = previous
    }
  })

  test("coalesces native and SSE handshakes but accepts a new revision", async () => {
    let calls = 0
    const coordinator = createMobileRefreshCoordinator(async () => { calls++ })
    coordinator.request("1")
    coordinator.request()
    coordinator.request("1")
    await Bun.sleep(10)
    coordinator.request()
    expect(calls).toBe(1)
    coordinator.request("2")
    await Bun.sleep(10)
    expect(calls).toBe(2)
    coordinator.dispose()
  })

  test("stream reconciliation queues once behind healthy work without superseding it", async () => {
    let release: (() => void) | undefined
    let calls = 0
    const coordinator = createMobileRefreshCoordinator(async () => {
      calls++
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve })
    })
    coordinator.request("1")
    await Bun.sleep(10)
    coordinator.request()
    coordinator.request()
    coordinator.request("1")
    await Bun.sleep(10)
    expect(calls).toBe(1)
    release?.()
    await Bun.sleep(10)
    expect(calls).toBe(2)
    coordinator.dispose()
  })

  test("a handshake inside the cooldown is delayed rather than dropped", async () => {
    let now = 0
    let calls = 0
    const coordinator = createMobileRefreshCoordinator(async () => { calls++ }, () => now)
    coordinator.request("1")
    await Bun.sleep(10)
    now = 1490
    coordinator.request()
    coordinator.request()
    expect(calls).toBe(1)
    await Bun.sleep(25)
    expect(calls).toBe(2)
    coordinator.dispose()
  })

  test("supersedes a stalled refresh immediately and coalesces the latest revision", async () => {
    let release: (() => void) | undefined
    let calls = 0
    const coordinator = createMobileRefreshCoordinator(async () => {
      calls++
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve })
    })
    coordinator.request("1")
    await Bun.sleep(10)
    coordinator.request()
    coordinator.request("2")
    coordinator.request("3")
    expect(calls).toBe(1)
    await Bun.sleep(10)
    expect(calls).toBe(2)
    release?.()
    await Bun.sleep(10)
    coordinator.request("3")
    coordinator.request()
    await Bun.sleep(10)
    expect(calls).toBe(2)
    coordinator.dispose()
  })

  test("disposal cancels scheduled work and failure does not strand refresh", async () => {
    let calls = 0
    const coordinator = createMobileRefreshCoordinator(async () => { calls++; throw new Error("offline") })
    coordinator.request("1")
    await Bun.sleep(10)
    coordinator.request("2")
    await Bun.sleep(10)
    expect(calls).toBe(2)
    coordinator.request("3")
    coordinator.dispose()
    await Bun.sleep(10)
    coordinator.request("4")
    expect(calls).toBe(2)
  })

  test("an obsolete completion cannot release the newer running refresh", async () => {
    const releases: (() => void)[] = []
    const coordinator = createMobileRefreshCoordinator(() => new Promise<void>((resolve) => { releases.push(resolve) }))
    coordinator.request("1")
    await Bun.sleep(10)
    coordinator.request("2")
    await Bun.sleep(10)
    releases[0]()
    await Bun.sleep(10)
    coordinator.request("2")
    coordinator.request()
    await Bun.sleep(10)
    expect(releases).toHaveLength(2)
    releases[1]()
    coordinator.dispose()
  })
})
