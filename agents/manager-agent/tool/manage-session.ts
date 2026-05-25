const managedRoots = ["context", "system", "tool"]
const generatedFiles = ["agent.json", "README.md"]

type Args = {
  action?: "export" | "install" | "diff"
  sessionID?: string
  agentName?: string
  repositoryPath?: string
  repositoryUrl?: string
  packagePath?: string
  branch?: string
  commitMessage?: string
  push?: boolean
  dataDir?: string
  overwrite?: boolean
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function asString(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function asBoolean(input: unknown) {
  return typeof input === "boolean" ? input : undefined
}

function safeSegment(input: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(input)) throw new Error(`Unsafe path segment: ${input}`)
  return input
}

async function exists(path: string) {
  const fs = await import("node:fs/promises")
  return fs.access(path).then(
    () => true,
    () => false,
  )
}

async function readJSON(path: string) {
  const fs = await import("node:fs/promises")
  return JSON.parse(await fs.readFile(path, "utf8")) as unknown
}

async function listFiles(root: string, dir = "") {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const base = path.join(root, dir)
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const rel = path.join(dir, entry.name).replaceAll("\\", "/")
      if (entry.isDirectory()) return listFiles(root, rel)
      if (entry.isFile()) return [rel]
      return []
    }),
  )
  return nested.flat()
}

async function copyFile(sourceRoot: string, targetRoot: string, rel: string) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  await fs.mkdir(path.dirname(path.join(targetRoot, rel)), { recursive: true })
  await fs.copyFile(path.join(sourceRoot, rel), path.join(targetRoot, rel))
}

async function removeManagedPackageFiles(target: string) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  await Promise.all([
    ...managedRoots.map((dir) => fs.rm(path.join(target, dir), { recursive: true, force: true })),
    ...generatedFiles.map((file) => fs.rm(path.join(target, file), { force: true })),
    fs.rm(path.join(target, "assemble.ts"), { force: true }),
    fs.rm(path.join(target, "assemble-schema.md"), { force: true }),
  ])
}

async function run(command: string[], cwd: string) {
  const childProcess = await import("node:child_process")
  return await new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn(command[0], command.slice(1), { cwd })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", reject)
    child.on("close", (code) => {
      const output = `${stdout}${stderr}`.trim()
      if (code !== 0) reject(new Error(`${command.join(" ")} failed\n${output}`.trim()))
      else resolve(output)
    })
  })
}

async function resolveInside(root: string, rel: string) {
  const path = await import("node:path")
  const target = path.resolve(root, rel)
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Path escapes repository: ${rel}`)
  return target
}

async function prepareRepository(args: Args, dataDir: string) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const crypto = await import("node:crypto")
  if (args.repositoryPath) return path.resolve(args.repositoryPath)
  if (!args.repositoryUrl) throw new Error("Provide repositoryPath or repositoryUrl")

  const cache = path.join(dataDir, "storage", "manage-session-repos")
  await fs.mkdir(cache, { recursive: true })
  const repo = path.join(cache, crypto.createHash("sha256").update(args.repositoryUrl).digest("hex").slice(0, 16))
  if (await exists(path.join(repo, ".git"))) {
    await run(["git", "fetch", "--all", "--prune"], repo)
    if (args.branch) await run(["git", "checkout", args.branch], repo)
    await run(["git", "pull", "--ff-only"], repo).catch(() => "")
    return repo
  }
  await run(["git", "clone", args.repositoryUrl, repo], cache)
  if (args.branch) await run(["git", "checkout", args.branch], repo)
  return repo
}

async function packageFiles(packageDir: string) {
  const files = await listFiles(packageDir)
  return files.filter(
    (file) =>
      file === "assemble.ts" ||
      file === "assemble-schema.md" ||
      managedRoots.some((root) => file === root || file.startsWith(`${root}/`)),
  )
}

async function exportSession(args: Args, ctx: { directory: string; agent: string }) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const dataDir = path.resolve(args.dataDir ?? ctx.directory)
  const repo = await prepareRepository(args, dataDir)
  const sessionID = safeSegment(args.sessionID ?? "")
  const agentName = safeSegment(args.agentName ?? sessionID)
  const source = path.join(dataDir, "session", sessionID)
  const target = await resolveInside(repo, args.packagePath ?? path.join("agents", agentName))
  if (!(await exists(path.join(source, "metadata.json")))) throw new Error(`Session not found: ${sessionID}`)

  await fs.mkdir(target, { recursive: true })
  await removeManagedPackageFiles(target)

  const files = (await listFiles(source)).filter(
    (file) =>
      file === "assemble.ts" ||
      file === "assemble-schema.md" ||
      managedRoots.some((root) => file.startsWith(`${root}/`)),
  )
  await Promise.all(files.map((file) => copyFile(source, target, file)))

  const rawMetadata = await readJSON(path.join(source, "metadata.json"))
  const metadata = isRecord(rawMetadata) ? rawMetadata : {}
  await fs.writeFile(
    path.join(target, "agent.json"),
    JSON.stringify(
      {
        schema: "opencode-agent-session/v1",
        name: agentName,
        title: isRecord(metadata) && typeof metadata.title === "string" ? metadata.title : agentName,
        description: `Shared agent-session package exported from ${sessionID}.`,
        version: "0.1.0",
        source_session_id: sessionID,
        exported_at: new Date().toISOString(),
        exported_by: ctx.agent,
        files,
      },
      null,
      2,
    ),
  )
  if (!(await exists(path.join(target, "README.md")))) {
    await fs.writeFile(path.join(target, "README.md"), `# ${agentName}\n\nShared opencode agent-session package exported from \`${sessionID}\`.\n`)
  }

  await run(["git", "add", path.relative(repo, target)], repo)
  if (args.commitMessage) await run(["git", "-c", "user.name=opencode-manager", "-c", "user.email=opencode-manager@local", "commit", "-m", args.commitMessage], repo).catch((error) => {
    if (String(error).includes("nothing to commit")) return ""
    throw error
  })
  if (args.push) await run(["git", "push"], repo)

  return { repo, packagePath: path.relative(repo, target).replaceAll("\\", "/"), files }
}

async function installSession(args: Args, ctx: { directory: string; agent: string }) {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const dataDir = path.resolve(args.dataDir ?? ctx.directory)
  const repo = await prepareRepository(args, dataDir)
  const sessionID = safeSegment(args.sessionID ?? "")
  const agentName = safeSegment(args.agentName ?? sessionID)
  const source = await resolveInside(repo, args.packagePath ?? path.join("agents", agentName))
  const target = path.join(dataDir, "session", sessionID)
  if (!(await exists(path.join(source, "agent.json")))) throw new Error(`Agent package not found: ${source}`)
  if ((await exists(target)) && !args.overwrite) throw new Error(`Target session exists; set overwrite true to update: ${sessionID}`)

  await fs.mkdir(target, { recursive: true })
  if (args.overwrite) await removeManagedPackageFiles(target)
  const files = await packageFiles(source)
  await Promise.all(files.map((file) => copyFile(source, target, file)))
  await fs.writeFile(
    path.join(target, "agent-package.json"),
    JSON.stringify(
      {
        schema: "opencode-agent-install/v1",
        package: agentName,
        session_id: sessionID,
        installed_at: new Date().toISOString(),
        installed_by: ctx.agent,
        source: {
          repository: args.repositoryUrl ?? args.repositoryPath,
          path: path.relative(repo, source).replaceAll("\\", "/"),
        },
        managed_files: files,
      },
      null,
      2,
    ),
  )
  return { repo, sessionID, files }
}

async function diffSession(args: Args, ctx: { directory: string }) {
  const path = await import("node:path")
  const dataDir = path.resolve(args.dataDir ?? ctx.directory)
  const repo = await prepareRepository(args, dataDir)
  const sessionID = safeSegment(args.sessionID ?? "")
  const agentName = safeSegment(args.agentName ?? sessionID)
  const packageDir = await resolveInside(repo, args.packagePath ?? path.join("agents", agentName))
  const sessionDir = path.join(dataDir, "session", sessionID)
  const files = Array.from(new Set([...(await packageFiles(packageDir)), ...(await packageFiles(sessionDir))])).sort()
  const changed = []
  for (const file of files) {
    const fs = await import("node:fs/promises")
    const left = await fs.readFile(path.join(packageDir, file), "utf8").catch(() => undefined)
    const right = await fs.readFile(path.join(sessionDir, file), "utf8").catch(() => undefined)
    if (left !== right) changed.push(file)
  }
  return { repo, packagePath: path.relative(repo, packageDir).replaceAll("\\", "/"), sessionID, changed }
}

export default {
  description:
    "Manage shareable opencode agent-session packages. Export a session folder to a Git repository, install a package into a session folder, or diff a package against a session. Pass arguments as top-level fields, for example {\"action\":\"diff\",\"sessionID\":\"ses_manager_agent\",\"repositoryPath\":\"...\"}; do not wrap them in a properties object.",
  args: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["export", "install", "diff"], description: "Operation to perform." },
      sessionID: { type: "string", description: "Session ID to export from, install to, or compare." },
      agentName: { type: "string", description: "Shareable agent package name. Defaults to sessionID." },
      repositoryPath: { type: "string", description: "Existing local Git repository path." },
      repositoryUrl: { type: "string", description: "Git repository URL to clone/use when repositoryPath is not provided." },
      packagePath: { type: "string", description: "Path inside the repository. Defaults to agents/<agentName>." },
      branch: { type: "string", description: "Optional Git branch to checkout." },
      commitMessage: { type: "string", description: "Optional commit message for export." },
      push: { type: "boolean", description: "Only export pushes when this is true. Defaults to false." },
      dataDir: { type: "string", description: "Global.Path.data override. Defaults to the manager session directory context." },
      overwrite: { type: "boolean", description: "Install/update existing managed files when true." },
    },
    required: ["action", "sessionID"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!isRecord(input)) throw new Error("Invalid input")
    const args: Args = {
      action: input.action === "export" || input.action === "install" || input.action === "diff" ? input.action : undefined,
      sessionID: asString(input.sessionID),
      agentName: asString(input.agentName),
      repositoryPath: asString(input.repositoryPath),
      repositoryUrl: asString(input.repositoryUrl),
      packagePath: asString(input.packagePath),
      branch: asString(input.branch),
      commitMessage: asString(input.commitMessage),
      push: asBoolean(input.push) ?? false,
      dataDir: asString(input.dataDir),
      overwrite: asBoolean(input.overwrite) ?? false,
    }
    if (!args.action) throw new Error("action is required")
    if (!args.sessionID) throw new Error("sessionID is required")

    const result =
      args.action === "export"
        ? await exportSession(args, ctx)
        : args.action === "install"
          ? await installSession(args, ctx)
          : await diffSession(args, ctx)

    return {
      title: `Manage Session: ${args.action}`,
      output: JSON.stringify(result, null, 2),
      metadata: { action: args.action, sessionID: args.sessionID, agentName: args.agentName, result },
    }
  },
}
