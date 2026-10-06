import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { isServer } from "solid-js/web"
import type { DisplayCache } from "./server-cache"
import { captureDirectory } from "./server-cache"
import { decodeDesktopCache, desktopCacheKey, encodeDesktopCache, loadDesktopCache, saveDesktopCache, watchDesktopCache } from "./desktop-cache"
import type { State } from "./types"

const empty = (): DisplayCache => ({
  projects: [], directories: new Map(), directoryPaths: new Map(), directoryProviders: new Map(),
})

describe("desktop sidebar cache", () => {
  test("persists only allowlisted display fields and rehydrates before use", async () => {
    const source = empty()
    source.projects.push({ id: "p", worktree: "/work", name: "Project", time: { created: 1, updated: 2 },
      sandboxes: [], vcs: "git", icon: { url: "private" } } as DisplayCache["projects"][number])
    source.config = { privateToken: "credential" } as DisplayCache["config"]
    source.directories.set("/work", {
      project: "p", total: 2, cursor: "12",
      sessions: [{ id: "ses_1", slug: "first", projectID: "p", directory: "/work", title: "Hello",
        version: "1", time: { created: 1, updated: 2 } }],
      transcript: { sessionID: "ses_1", messages: [], parts: { privateMessage: [] } },
    })
    let disk = ""
    const storage = {
      getItem: async () => disk,
      setItem: async (_: string, value: string) => { disk = value },
      removeItem: async () => { disk = "" },
    } as AsyncStorage
    await saveDesktopCache(storage, source)
    expect(disk).not.toContain('"next"')
    expect(disk).not.toContain("private")
    expect(disk).not.toContain("credential")
    const target = empty()
    await loadDesktopCache(storage, target)
    expect(target.projects[0]?.name).toBe("Project")
    expect(target.directories.get("/work")?.sessions[0]?.title).toBe("Hello")
    expect(target.directories.get("/work")?.cursor).toBe("12")
    expect(target.directories.get("/work")?.transcript).toBeUndefined()
    captureDirectory(target, "/work", {
      project: "p", sessionTotal: 0, session: [], message: {}, part: {},
    } as unknown as State)
    expect(target.directories.get("/work")?.cursor).toBe("12")
  })

  test("rejects malformed, oversized, and unknown-version snapshots", () => {
    const source = empty()
    source.directories.set("/work", { project: "p", total: 1, sessions: [{ id: "s", slug: "s",
      projectID: "p", directory: "/work", title: "Title", version: "1", time: { created: 1, updated: 1 } }] })
    const valid = encodeDesktopCache(source)!
    expect(decodeDesktopCache(valid)?.directories.size).toBe(1)
    expect(decodeDesktopCache("{")).toBeUndefined()
    expect(decodeDesktopCache("x".repeat(256 * 1024 + 1))).toBeUndefined()
    expect(decodeDesktopCache(valid.replace('"version":1', '"version":2'))).toBeUndefined()
    expect(decodeDesktopCache(valid.replace('"directory":"/work"', '"directory":"/other"'))).toBeUndefined()
    expect(decodeDesktopCache(valid.replace('"total":1', '"total":-1'))).toBeUndefined()
    source.directories.get("/work")!.cursor = "12"
    const paging = encodeDesktopCache(source)!
    expect(decodeDesktopCache(paging.replace('"cursor":"12"', '"cursor":"invalid"'))).toBeUndefined()
  })

  test("keeps recent directories when the disk budget is exceeded", () => {
    const cache = empty()
    for (let index = 0; index < 30; index++) {
      const directory = `/work/${index}`
      cache.directories.set(directory, {
        project: "p", total: 55,
        sessions: Array.from({ length: 55 }, (_, session) => ({
          id: `ses_${index}_${session}`, slug: `slug-${session}`, projectID: "p", directory,
          title: `${index}-${session}-${"x".repeat(200)}`, version: "1",
          time: { created: session, updated: session },
        })),
      })
    }
    const saved = decodeDesktopCache(encodeDesktopCache(cache))
    expect(saved?.directories.size).toBeGreaterThan(0)
    expect(saved?.directories.size).toBeLessThan(30)
    expect(saved?.directories.has("/work/29")).toBe(true)
  })

  test("never overwrites a live in-memory cache with disk content", async () => {
    const cache = empty()
    cache.projects.push({ id: "live", worktree: "/live", time: { created: 1, updated: 1 }, sandboxes: [] })
    await loadDesktopCache({ getItem: () => encodeDesktopCache(empty()) ?? null, setItem: () => {}, removeItem: () => {} }, cache)
    expect(cache.projects[0]?.id).toBe("live")
  })

  test("isolates paired identities and rejects invalid storage keys", async () => {
    expect(desktopCacheKey({ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } })).toBeUndefined()
    const disk = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: async (key) => disk.get(key) ?? null,
      setItem: async (key, value) => { disk.set(key, value) },
      removeItem: async (key) => { disk.delete(key) },
    }
    const first = desktopCacheKey({ type: "tunnel", host: "a", cacheKey: "a".repeat(64), http: { url: "http://127.0.0.1" } })!
    const second = desktopCacheKey({ type: "tunnel", host: "a", cacheKey: "b".repeat(64), http: { url: "http://127.0.0.1" } })!
    expect(desktopCacheKey({ type: "tunnel", host: "a", cacheKey: "../sidecar", http: { url: "http://127.0.0.1" } })).toBeUndefined()
    const source = empty()
    source.projects.push({ id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] })
    await saveDesktopCache(storage, source, first)
    const wrong = empty()
    await loadDesktopCache(storage, wrong, second)
    expect(wrong.projects).toEqual([])
    const right = empty()
    await loadDesktopCache(storage, right, first)
    expect(right.projects[0]?.id).toBe("a")
    await saveDesktopCache(storage, source, "../sidecar.v1")
    expect(disk.size).toBe(1)
  })

  ;(isServer ? test.skip : test)("writes titles arriving after initial mount from a reactive child store", async () => {
    const disk = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: async (key) => disk.get(key) ?? null,
      setItem: async (key, value) => { disk.set(key, value) },
      removeItem: async (key) => { disk.delete(key) },
    }
    const [child, setChild] = createStore({ project: "p", sessionTotal: 0, session: [] as State["session"], message: {}, part: {} })
    const cache = empty()
    const dispose = createRoot((dispose) => {
      watchDesktopCache({ storage, key: "sidecar.v1", cache, projects: () => [],
        directories: () => [{ worktree: "/work" }], peek: () => child as State })
      return dispose
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(decodeDesktopCache(disk.get("sidecar.v1"))?.directories.get("/work")?.sessions).toEqual([])
    setChild("session", [{ id: "s", slug: "s", projectID: "p", directory: "/work", title: "Fetched title",
      version: "1", time: { created: 1, updated: 1 } }])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(decodeDesktopCache(disk.get("sidecar.v1"))?.directories.get("/work")?.sessions[0]?.title).toBe("Fetched title")
    dispose()
  })
})
