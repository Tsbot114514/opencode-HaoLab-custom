#!/usr/bin/env bun
import { $ } from "bun"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"

import { resolveChannel } from "./utils"

const platform = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform]
const targetArch = process.env.HAOLAB_REMOTE_ARCH || process.arch
const arch = { arm64: "arm64", x64: "amd64" }[targetArch]
if (!platform || !arch) throw new Error(`Unsupported remote helper build target: ${process.platform}-${targetArch}`)

const directory = path.resolve(import.meta.dir, "../remote-helper")
const output = path.join(
  directory,
  "bin",
  `${process.platform}-${targetArch}`,
  `haolab-remote${process.platform === "win32" ? ".exe" : ""}`,
)
mkdirSync(path.dirname(output), { recursive: true })
const result = spawnSync("go", ["build", "-buildvcs=false", "-o", output, "."], {
  cwd: directory,
  env: { ...process.env, CGO_ENABLED: "0", GOOS: platform, GOARCH: arch },
  stdio: "inherit",
})
if (result.error)
  throw new Error(
    `Could not build the remote helper. Install Go (see remote-helper/go.mod) and ensure it is on PATH: ${result.error.message}`,
  )
if (result.status !== 0)
  throw new Error(`Remote helper Go build failed (exit ${result.status ?? "unknown"}); see the Go output above.`)
if (process.platform !== "win32") chmodSync(output, 0o755)

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
