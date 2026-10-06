import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { isServer } from "solid-js/web"

type PersistTestingType = typeof import("./persist").PersistTesting
type PersistType = typeof import("./persist").Persist
type RemovePersistedType = typeof import("./persist").removePersisted
type PersistedType = typeof import("./persist").persisted

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

let persistTesting: PersistTestingType
let Persist: PersistType
let removePersisted: RemovePersistedType
let persisted: PersistedType

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
  Persist = mod.Persist
  removePersisted = mod.removePersisted
  persisted = mod.persisted
})

beforeEach(() => {
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("opencode.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("opencode.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("opencode.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("opencode.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("opencode.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result).toStartWith("opencode.workspace.")
    expect(result.endsWith(".dat")).toBeTrue()
    expect(/[:\\/]/.test(result)).toBeFalse()
  })

  test("workspace target keeps raw path storage as legacy fallback", () => {
    const target = Persist.workspace("C:\\Users\\foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("workspace target keeps backslash storage as fallback for normalized Windows paths", () => {
    const target = Persist.workspace("C:/Users/foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("migrates direct legacy keys into scoped storage", () => {
    storage.setItem("legacy.workspace", '{"value":2}')
    const target = Persist.workspace("C:/Users/foo", "demo", ["legacy.workspace"])
    const current = persistTesting.localStorageWithPrefix(target.storage!)
    const legacyStore = persistTesting.localStorageDirect()

    const result = persistTesting.migrateLegacy({
      current,
      legacyStore,
      stores: [],
      keys: target.legacy!,
      key: target.key,
      defaults: { value: 1 },
    })

    expect(result).toBe('{"value":2}')
    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"value":2}')
    expect(legacyStore.getItem("legacy.workspace")).toBeNull()
    expect(storage.getItem("legacy.workspace")).toBeNull()
  })

  test("removes legacy workspace storage when removing persisted target", () => {
    const target = Persist.workspace("C:\\Users\\foo", "terminal")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')
    storage.setItem(`${target.legacyStorageNames![0]}:${target.key}`, '{"value":2}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
    expect(storage.getItem(`${target.legacyStorageNames![0]}:${target.key}`)).toBeNull()
  })
})

describe("debounced draft persistence", () => {
  const browserTest = isServer ? test.skip : test

  browserTest("updates memory immediately, writes only the latest draft, and rehydrates", async () => {
    const target = Persist.session("/debounce", "session", "prompt")
    const key = `${target.storage}:${target.key}`
    const dispose = createRoot((dispose) => {
      const [state, set] = persisted(target, createStore({ prompt: "" }), { debounce: 30 })
      set("prompt", "first")
      set("prompt", "latest")
      expect(state.prompt).toBe("latest")
      expect(storage.getItem(key)).toBeNull()
      expect(storage.events.filter((event) => event === `set:${key}`)).toHaveLength(0)
      return dispose
    })

    await Bun.sleep(60)
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ prompt: "latest" })
    expect(storage.events.filter((event) => event === `set:${key}`)).toHaveLength(1)
    dispose()

    createRoot((dispose) => {
      const [state] = persisted(target, createStore({ prompt: "" }), { debounce: 30 })
      expect(state.prompt).toBe("latest")
      dispose()
    })
  })

  browserTest("flushes on pagehide, explicit flush, and session disposal", () => {
    const target = Persist.session("/flush", "session", "prompt")
    const key = `${target.storage}:${target.key}`
    const draft = createRoot((dispose) => {
      const [state, set, , , flush] = persisted(target, createStore({ prompt: "" }), { debounce: 300 })
      return { state, set, flush, dispose }
    })

    draft.set("prompt", "pagehide")
    window.dispatchEvent(new Event("pagehide"))
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ prompt: "pagehide" })

    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    draft.set("prompt", "hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ prompt: "hidden" })
    if (visibility) Object.defineProperty(document, "visibilityState", visibility)
    else Reflect.deleteProperty(document, "visibilityState")

    draft.set("prompt", "blur or reset")
    draft.flush()
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ prompt: "blur or reset" })

    draft.set("prompt", "disposal")
    draft.dispose()
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ prompt: "disposal" })
  })

  browserTest("non-debounced storage still writes synchronously", () => {
    const target = Persist.session("/immediate", "session", "prompt")
    createRoot((dispose) => {
      const [, set] = persisted(target, createStore({ prompt: "" }))
      set("prompt", "now")
      expect(JSON.parse(storage.getItem(`${target.storage}:${target.key}`)!)).toEqual({ prompt: "now" })
      dispose()
    })
  })
})
