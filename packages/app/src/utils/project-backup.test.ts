import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  compareProjectSnapshots,
  compareProjectTime,
  formatProjectTime,
  inspectProject,
  isAbsoluteProjectPath,
  parseProjectPreview,
  transferProject,
} from "./project-backup"

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const snapshot = { files: 12, sessions: 3, filesUpdatedAt: 1000.5, sessionsUpdatedAt: 2000 }
const preview = {
  package: { ...snapshot, name: "Project", identity: "project-identity", createdAt: 5000 },
  candidates: ["/existing"],
  directory: "/existing",
  action: "replace" as const,
  local: snapshot,
  previewToken: "preview-token",
  warnings: ["Sensitive files included"],
}

describe("project migration paths and previews", () => {
  test("accepts server-side absolute paths, rejects relative paths and NUL", () => {
    for (const path of ["/srv/project", "D:\\项目\\backup.zip", "C:/project", "\\\\host\\share\\project"])
      expect(isAbsoluteProjectPath(path)).toBe(true)
    for (const path of ["", "project.zip", "../project", "C:project", "\\project", "/tmp/\0bad"])
      expect(isAbsoluteProjectPath(path)).toBe(false)
  })
  test("validates all preview modes and accepts fractional filesystem timestamps", () => {
    expect(parseProjectPreview(preview)).toEqual(preview)
    expect(parseProjectPreview({ ...preview, action: "create", local: null }).action).toBe("create")
    expect(
      parseProjectPreview({ ...preview, action: "select-target", local: null, directory: null, previewToken: null })
        .previewToken,
    ).toBeNull()
  })
  test("rejects malformed and non-actionable untrusted previews", () => {
    for (const value of [
      null,
      [],
      {},
      { ...preview, action: "merge" },
      { ...preview, previewToken: "" },
      { ...preview, previewToken: null },
      { ...preview, directory: null },
      { ...preview, directory: "relative" },
      { ...preview, local: null },
      { ...preview, local: { ...snapshot, files: -1 } },
      { ...preview, candidates: [5] },
      { ...preview, candidates: ["relative"] },
      { ...preview, warnings: [{}] },
      { ...preview, action: "select-target", previewToken: "cannot-apply" },
      { ...preview, package: { ...preview.package, identity: " " } },
      { ...preview, package: { ...preview.package, createdAt: Infinity } },
      { ...preview, package: { ...preview.package, sessions: 1.2 } },
      { ...preview, package: { ...preview.package, filesUpdatedAt: "yesterday" } },
      { ...preview, package: { ...preview.package, sessionsUpdatedAt: NaN } },
      { ...preview, package: { ...preview.package, createdAt: 9e15 } },
    ])
      expect(() => parseProjectPreview(value)).toThrow("无效的迁移预览")
  })
})

describe("snapshot time comparisons", () => {
  test("compares content timestamps separately, not package creation time", () => {
    expect(compareProjectTime(2000, 1000)).toBe("package")
    expect(compareProjectTime(1000, 2000)).toBe("local")
    expect(compareProjectTime(1000, 1000)).toBe("same")
    expect(compareProjectTime(null, 2000)).toBe("unknown")
    expect(
      compareProjectSnapshots({ ...snapshot, filesUpdatedAt: 3000 }, { ...snapshot, sessionsUpdatedAt: 4000 }),
    ).toBe("mixed")
    expect(compareProjectSnapshots({ ...snapshot, sessionsUpdatedAt: 4000 }, snapshot)).toBe("package")
    expect(compareProjectSnapshots(snapshot, { ...snapshot, filesUpdatedAt: 3000 })).toBe("local")
    expect(compareProjectSnapshots(snapshot, snapshot)).toBe("same")
    expect(compareProjectSnapshots({ ...snapshot, filesUpdatedAt: null }, snapshot)).toBe("unknown")
    expect(compareProjectSnapshots(preview.package, snapshot)).toBe("same")
  })
  test("formats timezone-explicit UTC timestamps and missing data", () => {
    expect(formatProjectTime(0)).toBe("1970-01-01 00:00:00.000 UTC")
    expect(formatProjectTime(null)).toBe("未知 / 无记录")
  })
})

describe("project migration requests", () => {
  test("sends exact authenticated export, inspect and confirmed restore payloads via platform transport", async () => {
    const received: { path: string; directory: string | null; method: string; auth: string | null; body: unknown }[] =
      []
    const server = await listen(async (request, response) => {
      const url = new URL(request.url!, "http://localhost")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received.push({
        path: url.pathname,
        directory: url.searchParams.get("directory"),
        method: request.method!,
        auth: request.headers.authorization ?? null,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify(
          url.pathname.endsWith("inspect")
            ? preview
            : {
                ...(url.pathname.endsWith("backup")
                  ? { path: "/shared/project.zip" }
                  : { directory: "/existing", safetyPath: "/safety/before.zip" }),
                sessions: 3,
                files: 12,
                warnings: ["Sensitive files included"],
              },
        ),
      )
    })
    let calls = 0
    const transport: typeof fetch = Object.assign(
      (request: RequestInfo | URL, init?: RequestInit) => {
        calls++
        return fetch(request, init)
      },
      { preconnect: fetch.preconnect },
    )
    try {
      const input = {
        server: { url: server.url, username: "user", password: "secret" },
        fetch: transport,
        directory: "/manager",
        path: "/shared/project.zip",
      }
      const backup = await transferProject({ ...input, mode: "backup", directory: "/source/项目 & data" })
      expect((await inspectProject(input)).action).toBe("replace")
      expect((await inspectProject({ ...input, destination: "/existing" })).previewToken).toBe("preview-token")
      const restore = await transferProject({
        ...input,
        mode: "restore",
        destination: "/existing",
        previewToken: "preview-token",
        overwrite: true,
      })
      await transferProject({
        ...input,
        mode: "restore",
        destination: "/new-project",
        previewToken: "create-token",
        overwrite: false,
      })
      expect(calls).toBe(5)
      expect(received).toEqual([
        {
          path: "/project/backup",
          directory: "/source/项目 & data",
          method: "POST",
          auth: `Basic ${btoa("user:secret")}`,
          body: { path: "/shared/project.zip" },
        },
        {
          path: "/project/backup/inspect",
          directory: "/manager",
          method: "POST",
          auth: `Basic ${btoa("user:secret")}`,
          body: { path: "/shared/project.zip" },
        },
        {
          path: "/project/backup/inspect",
          directory: "/manager",
          method: "POST",
          auth: `Basic ${btoa("user:secret")}`,
          body: { path: "/shared/project.zip", directory: "/existing" },
        },
        {
          path: "/project/restore",
          directory: "/manager",
          method: "POST",
          auth: `Basic ${btoa("user:secret")}`,
          body: { path: "/shared/project.zip", directory: "/existing", previewToken: "preview-token", overwrite: true },
        },
        {
          path: "/project/restore",
          directory: "/manager",
          method: "POST",
          auth: `Basic ${btoa("user:secret")}`,
          body: {
            path: "/shared/project.zip",
            directory: "/new-project",
            previewToken: "create-token",
            overwrite: false,
          },
        },
      ])
      expect(backup).toEqual({
        target: "/shared/project.zip",
        sessions: 3,
        files: 12,
        warnings: ["Sensitive files included"],
        safetyPath: null,
      })
      expect(restore.safetyPath).toBe("/safety/before.zip")
    } finally {
      await server.close()
    }
  })
  test("retains stale-preview errors and rejects invalid HTTP success data", async () => {
    const server = await listen((request, response) => {
      if (new URL(request.url!, "http://localhost").pathname.endsWith("restore")) {
        response.writeHead(409, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ message: "Preview is stale; read the package again" }))
        return
      }
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end("<html>Unsupported endpoint</html>")
    })
    try {
      const input = { server: { url: server.url }, directory: "/manager", path: "/backup.zip" }
      await expect(
        transferProject({
          ...input,
          mode: "restore",
          destination: "/existing",
          previewToken: "stale",
          overwrite: true,
        }),
      ).rejects.toThrow("Preview is stale; read the package again")
      await expect(transferProject({ ...input, mode: "backup" })).rejects.toThrow("无效的迁移结果")
      await expect(inspectProject(input)).rejects.toThrow("无效的迁移预览")
      await expect(
        transferProject({ ...input, mode: "restore", destination: "/existing", previewToken: " ", overwrite: true }),
      ).rejects.toThrow("请先重新读取迁移包")
    } finally {
      await server.close()
    }
  })
})
