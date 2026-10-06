import { describe, expect, test } from "bun:test"
import { canRestoreTunnelSidebar, mobileCache, resolveServerList, sendMobileCache, ServerConnection, sidebarProjects, validateMobileTranscript } from "./server"

describe("mobileCache", () => {
  test("validates projects, selection and summaries without trusting extra session data", () => {
    const previous = globalThis.window
    try {
      globalThis.window = {
        __HAOLAB_MOBILE__: true,
        __HAOLAB_CACHE__: {
          version: 1,
          projects: ["/one"],
          selected: "/missing",
          sessions: {
            "/one": [{ id: "id", directory: "/one", projectID: "project", slug: "slug", title: "Title", version: "1", time: { created: 1, updated: 2, archived: 3 }, permission: ["unsafe"] }],
            "/bad": [{ id: "id", directory: "/other" }],
          },
        },
      } as unknown as Window & typeof globalThis
      expect(mobileCache()).toEqual({
        projects: ["/one"],
        selected: undefined,
        transcript: undefined,
        sessions: { "/one": [{ id: "id", directory: "/one", projectID: "project", slug: "slug", title: "Title", version: "1", time: { created: 1, updated: 2 } }] },
      })
      ;(window as Window & { __HAOLAB_CACHE__?: unknown }).__HAOLAB_CACHE__ = { version: 2, projects: ["/one"] }
      expect(mobileCache()).toBeUndefined()
      ;(window as Window & { __HAOLAB_CACHE__?: unknown }).__HAOLAB_CACHE__ = { version: 1, projects: [""], sessions: {} }
      expect(mobileCache()).toBeUndefined()
    } finally {
      globalThis.window = previous
    }
  })

  test("sends only mobile bridge messages", () => {
    const previous = globalThis.window
    const sent: unknown[] = []
    try {
      globalThis.window = { __HAOLAB_MOBILE__: true, webkit: { messageHandlers: { haolabCache: {
        postMessage: (value: unknown) => sent.push(value),
      } } } } as unknown as Window & typeof globalThis
      sendMobileCache({ type: "selected", directory: "/one" })
      expect(sent).toEqual([{ type: "selected", directory: "/one" }])
      ;(window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ = false
      sendMobileCache({ type: "projects", directories: [] })
      expect(sent).toHaveLength(1)
    } finally {
      globalThis.window = previous
    }
  })
})

describe("mobile transcript validation", () => {
  const message = { id: "m1", role: "assistant" as const, created: 42, parentID: "user-before-page", text: "Hello" }
  const transcript = { directory: "/one", sessionID: "session", messages: [message] }

  test("accepts a bounded transcript and strips extra fields", () => {
    expect(validateMobileTranscript({ ...transcript, messages: [{ ...message, tokens: "secret" }], credential: "secret" }))
      .toEqual(transcript)
  })

  test("rejects malformed messages, duplicates and oversized text", () => {
    expect(validateMobileTranscript({ ...transcript, messages: [message, message] })).toBeUndefined()
    expect(validateMobileTranscript({ ...transcript, messages: [{ ...message, text: "x".repeat(6001) }] })).toBeUndefined()
    expect(validateMobileTranscript({ ...transcript, messages: [{ ...message, role: "system" }] })).toBeUndefined()
    expect(validateMobileTranscript({ ...transcript, messages: [{ ...message, created: Infinity }] })).toBeUndefined()
    expect(validateMobileTranscript({ ...transcript, messages: Array(21).fill(message) })).toBeUndefined()
    expect(validateMobileTranscript({ ...transcript, directory: "" })).toBeUndefined()
  })

  test("ignores invalid injected transcript without discarding sidebar cache", () => {
    const previous = globalThis.window
    try {
      globalThis.window = { __HAOLAB_MOBILE__: true, __HAOLAB_CACHE__: {
        version: 1, projects: ["/one"], transcript: { ...transcript, messages: [{ ...message, text: "x".repeat(6001) }] },
      } } as unknown as Window & typeof globalThis
      expect(mobileCache()?.transcript).toBeUndefined()
      expect(mobileCache()?.projects).toEqual(["/one"])
    } finally {
      globalThis.window = previous
    }
  })
})

describe("sidebarProjects", () => {
  test("restores only the persisted hashed pairing identity across bridge restarts", () => {
    const conn: ServerConnection.Tunnel = { type: "tunnel", host: "paired.test", cacheKey: "a".repeat(64),
      http: { url: "http://127.0.0.1:41643", username: "client", password: "sample" } }
    expect(canRestoreTunnelSidebar(conn, conn.cacheKey)).toBe(true)
    expect(canRestoreTunnelSidebar({ ...conn, http: { ...conn.http, url: "http://127.0.0.1:49152" } }, conn.cacheKey)).toBe(true)
    expect(canRestoreTunnelSidebar({ ...conn, cacheKey: "b".repeat(64) }, conn.cacheKey)).toBe(false)
    expect(canRestoreTunnelSidebar({ ...conn, cacheKey: "sample" }, "sample")).toBe(false)
    expect(canRestoreTunnelSidebar({ type: "sidecar", variant: "base", http: conn.http }, conn.cacheKey)).toBe(false)
  })

  test("restores verified A paths on return but not after a bridge or credential change", () => {
    const conn: ServerConnection.Tunnel = {
      type: "tunnel",
      host: "a.example.ts.net",
      http: { url: "http://127.0.0.1:41643", username: "client", password: "sample" },
    }
    expect(canRestoreTunnelSidebar(conn)).toBe(false)
    expect(canRestoreTunnelSidebar(conn, { ...conn.http })).toBe(true)
    expect(canRestoreTunnelSidebar({ ...conn, http: { ...conn.http, password: "rotated" } }, conn.http)).toBe(false)
    expect(canRestoreTunnelSidebar({ ...conn, http: { ...conn.http, url: "http://127.0.0.1:49152" } }, conn.http)).toBe(false)
    expect(canRestoreTunnelSidebar({ type: "sidecar", variant: "base", http: conn.http }, conn.http)).toBe(false)
  })

  test("uses A's order and removes B's stale entries without changing existing expansion", () => {
    const current = [
      { worktree: "/mine", expanded: false },
      { worktree: "/shared", expanded: false },
    ]
    expect(sidebarProjects(current, ["/remote", "/shared", "/remote"])).toEqual([
      { worktree: "/remote", expanded: true },
      { worktree: "/shared", expanded: false },
    ])
    expect(sidebarProjects(current, ["/mine", "/shared"])).toBe(current)
    expect(sidebarProjects(current, [])).toEqual([])
    expect(sidebarProjects(current, ["/shared", "", 42])).toBeUndefined()
    expect(sidebarProjects(current, null)).toBeUndefined()
  })

  test("keeps distinct non-Git directories instead of collapsing them by project ID", () => {
    const directories = Array.from({ length: 10 }, (_, index) => `/work/project-${index}`)
    const result = sidebarProjects([{ worktree: directories[0]!, expanded: false }], directories)
    expect(result?.map((project) => project.worktree)).toEqual(directories)
    expect(result?.[0]?.expanded).toBe(false)
  })

  test("replaces an in-memory mobile snapshot without accepting malformed payloads", () => {
    const first = sidebarProjects([], ["/host/one", "/host/two", "/host/one"])
    expect(first).toEqual([
      { worktree: "/host/one", expanded: true },
      { worktree: "/host/two", expanded: true },
    ])
    expect(sidebarProjects(first!, ["/host/two", "/host/three"])).toEqual([
      { worktree: "/host/two", expanded: true },
      { worktree: "/host/three", expanded: true },
    ])
    expect(sidebarProjects(first!, ["/host/one", " "])).toBeUndefined()
    expect(sidebarProjects(first!, { directories: ["/host/one"] })).toBeUndefined()
  })
})

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })

  test("replaces a persisted tunnel bridge with the fresh connection for its host", () => {
    const stored: ServerConnection.Tunnel = {
      type: "tunnel",
      host: "host.example.test",
      http: { url: "http://127.0.0.1:41643", username: "old", password: "old" },
    }
    const live: ServerConnection.Tunnel = {
      type: "tunnel",
      host: stored.host,
      http: { url: "http://127.0.0.1:49152", username: "new", password: "new" },
    }
    const list = resolveServerList({ stored: [stored], props: [live] })

    expect(list).toEqual([live])
    expect(ServerConnection.key(list[0]!)).toBe(ServerConnection.Key.make("tunnel:host.example.test"))
  })

  test("does not offer a persisted tunnel when desktop has no live connection", () => {
    const list = resolveServerList({
      stored: [{ type: "tunnel", host: "host.example.test", http: { url: "http://127.0.0.1:41643" } }],
      props: [{ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } }],
    })

    expect(list).toHaveLength(1)
    expect(ServerConnection.key(list[0]!)).toBe(ServerConnection.Key.make("sidecar"))
  })
})
