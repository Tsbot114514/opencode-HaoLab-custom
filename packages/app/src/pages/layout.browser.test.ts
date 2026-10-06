import { expect, spyOn, test } from "bun:test"
import { createComponent, type Component } from "solid-js"
import { insert, isServer, render } from "solid-js/web"
import type { BaseRouterProps } from "@solidjs/router"
import { PlatformProvider, type Platform } from "../context/platform"
import { ServerConnection } from "../context/server"
import { serverDisplayCache } from "../context/global-sync/server-cache"
import { base64Encode } from "@opencode-ai/core/util/encode"

const browserTest = isServer ? test.skip : test

for (const scenario of ["held", "candidate", "transcript", "disk-transcript", "failed"] as const)
  browserTest(`actual classic layout restores cached sidebar during autoselection (${scenario})`, async () => {
    const { AppBaseProviders, AppInterface } = await import("../app")
    const sentry = await import("@sentry/solid")
    const capture = spyOn(sentry, "captureException").mockImplementation(() => "fixture")
    const { MemoryRouter, Route, useLocation } = await import("@solidjs/router")
    const directory = `/layout-${scenario}`
    const conn: ServerConnection.Tunnel = {
      type: "tunnel",
      host: `layout-${scenario}.test`,
      cacheKey: "e".repeat(64),
      http: {
        url: `http://127.0.0.1:${48200 + ["held", "candidate", "transcript", "disk-transcript", "failed"].indexOf(scenario)}`,
        password: "fixture",
      },
    }
    const key = ServerConnection.key(conn)
    const identity = `${key}:${conn.cacheKey}`
    const session = {
      id: "ses_candidate",
      directory,
      projectID: "fixture",
      slug: "fixture",
      title: "Cached candidate",
      version: "1",
      time: { created: 1, updated: 2 },
    }
    const cache = serverDisplayCache(key, conn)!
    cache.projects = [
      {
        id: "fixture",
        worktree: directory,
        name: `Cached project ${scenario}`,
        time: { created: 1, updated: 2 },
        sandboxes: [],
      },
    ]
    cache.path = { directory, worktree: directory, state: "", config: "", data: "", home: "/" }
    cache.provider = { all: new Map(), connected: [], default: {} }
    cache.config = {}
    cache.directoryPaths.set(directory, cache.path)
    const cached = ["candidate", "transcript", "disk-transcript"].includes(scenario)
    cache.directories.set(directory, {
      project: "fixture",
      total: cached ? 1 : 0,
      sessions: cached ? [session] : [],
      ...(scenario === "transcript"
        ? {
            transcript: {
              sessionID: "ses_remembered",
              messages: [
                {
                  id: "msg_remembered",
                  sessionID: "ses_remembered",
                  role: "user" as const,
                  time: { created: 1 },
                  agent: "build",
                  model: { providerID: "fixture", modelID: "fixture" },
                },
              ],
              parts: {},
            },
          }
        : {}),
    })
    const disk = new Map<string, string>([
      [
        "server",
        JSON.stringify({
          list: [],
          projects: { [identity]: [{ worktree: directory, expanded: true }] },
          verified: { [identity]: conn.cacheKey },
          lastProject: { [identity]: directory },
        }),
      ],
      [
        "layout.page",
        JSON.stringify({ lastProjectSession: { [directory]: { directory, id: "ses_remembered", at: 1 } } }),
      ],
    ])
    if (scenario === "disk-transcript")
      disk.set(
        `tunnel.v1.${conn.cacheKey}`,
        JSON.stringify({
          version: 1,
          entries: [
            {
              directory,
              sessionID: "ses_remembered",
              session: [
                {
                  id: "msg_remembered",
                  sessionID: "ses_remembered",
                  role: "user",
                  time: { created: 1 },
                  agent: "build",
                  model: { providerID: "fixture", modelID: "fixture" },
                },
              ],
              part: [{ id: "msg_remembered", part: [] }],
              complete: true,
              updated: 1,
            },
          ],
        }),
      )
    const fixture = (await import("../context/global-sync/transcript-cache")).createTranscriptCache({
      getItem: (scope) => disk.get(scope) ?? null,
      setItem: (scope, value) => { disk.set(scope, value) },
      removeItem: (scope) => { disk.delete(scope) },
    }, `tunnel.v1.${conn.cacheKey}`)
    await fixture.ready
    const transcriptReads: string[] = []
    const requests: string[] = []
    let release: ((response: Response) => void) | undefined
    const platform: Platform = {
      platform: "desktop",
      openLink() {},
      restart: async () => {},
      back() {},
      forward() {},
      notify: async () => {},
      storage: (name) => ({
        ...(name === "opencode.transcripts.dat" ? {
          transcriptOpen: async (scope: string) => scope === `tunnel.v1.${conn.cacheKey}` ? { owner: "fixture-owner" } : undefined,
          transcriptReadPage: async (scope: string, owner: string, directory: string, sessionID: string, before?: string) => {
            transcriptReads.push(sessionID)
            if (scope !== `tunnel.v1.${conn.cacheKey}` || owner !== "fixture-owner") return
            const page = fixture.read(directory, sessionID, 20, before, true)
            return page ? { ...page, directory, sessionID } : undefined
          },
          transcriptAcquire: async () => ({ token: "fixture-grant", revalidate: false }),
          transcriptMutate: async () => {},
        } : {}),
        getItem: async (key) => {
          if (name === "opencode.transcripts.dat") throw new Error("Full transcript hydration is forbidden")
          return disk.get(key) ?? null
        },
        setItem: async (key, value) => {
          disk.set(key, value)
        },
        removeItem: async (key) => {
          disk.delete(key)
        },
      }),
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          requests.push(url.pathname)
          if (url.pathname === "/session/ses_remembered")
            return new Promise<Response>((resolve) => {
              release = resolve
            })
          if (url.pathname === "/global/health" || url.pathname === "/global/event")
            return new Promise<Response>(() => {})
          if (url.pathname === "/project") return Response.json(cache.projects)
          if (url.pathname === "/project/fixture") return Response.json(cache.projects[0])
          if (url.pathname.startsWith("/session/sidebar/") || url.pathname === "/session/reconcile")
            return new Response("unsupported fixture route", { status: 404 })
          if (url.pathname === "/path") return Response.json(cache.path)
          if (url.pathname === "/provider") return Response.json({ all: [], connected: [], default: {} })
          if (url.pathname === "/session" || url.pathname.endsWith("/session"))
            return Response.json(cached ? [session] : [])
          if (["/agent", "/command", "/lsp", "/worktree", "/skill"].includes(url.pathname)) return Response.json([])
          return Response.json({})
        },
        { preconnect: fetch.preconnect },
      ),
    }
    const router: Component<BaseRouterProps> = (props) =>
      createComponent(MemoryRouter, {
        initialEntries: ["/classic"],
        root: props.root,
        get children() {
          return createComponent(Route, {
            path: "*",
            component: () => {
              const location = useLocation()
              const body = document.createElement("div")
              insert(body, () => location.pathname)
              return body
            },
          })
        },
      })
    const root = document.createElement("div")
    document.body.append(root)
    const previousFetch = globalThis.fetch
    globalThis.fetch = platform.fetch!
    const dispose = render(
      () =>
        createComponent(PlatformProvider, {
          value: platform,
          get children() {
            return createComponent(AppBaseProviders, {
              get children() {
                return createComponent(AppInterface, { defaultServer: key, servers: [conn], router })
              },
            })
          },
        }),
      root,
    )
    try {
      await Bun.sleep(100)
      expect(root.querySelector('[data-component="sidebar-nav-desktop"]')).not.toBeNull()
      expect(
        root
          .querySelector(`[data-action="project-switch"][data-project="${base64Encode(directory)}"]`)
          ?.getAttribute("aria-label"),
      ).toBe(`Cached project ${scenario}`)
      expect(capture).not.toHaveBeenCalled()
      if (cached) {
        if (scenario === "disk-transcript") expect(transcriptReads).toContain("ses_remembered")
        expect(requests).not.toContain("/session/ses_remembered")
        expect(root.querySelector("main")?.textContent).toContain(
          `/${base64Encode(directory)}/session/${scenario === "candidate" ? "ses_candidate" : "ses_remembered"}`,
        )
      } else {
        expect(release).toBeDefined()
        release?.(
          scenario === "held"
            ? Response.json({ ...session, id: "ses_remembered" })
            : new Response("offline", { status: 503 }),
        )
        await Bun.sleep(50)
        expect(root.querySelector('[data-component="sidebar-nav-desktop"]')).not.toBeNull()
        expect(root.querySelector("main")?.textContent).toContain(
          `/${base64Encode(directory)}/session${scenario === "held" ? "/ses_remembered" : ""}`,
        )
        expect(capture).not.toHaveBeenCalled()
      }
    } finally {
      fixture.dispose()
      dispose()
      root.remove()
      globalThis.fetch = previousFetch
      capture.mockRestore()
    }
  })
