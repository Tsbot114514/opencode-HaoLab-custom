import { existsSync } from "node:fs"
import { join } from "node:path"

const port = 17687
const url = `http://127.0.0.1:${port}`
const root = join(import.meta.dir, "..")
const electron = join(root, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "electron.exe" : "electron")

async function isReady() {
  try {
    const response = await fetch(`${url}/connection`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForReady() {
  for (let i = 0; i < 80; i++) {
    if (await isReady()) return
    await Bun.sleep(100)
  }
  throw new Error(`manager frontend did not start at ${url}`)
}

if (!existsSync(electron)) {
  console.error(`electron binary not found: ${electron}`)
  process.exit(1)
}

const vite = (await isReady())
  ? undefined
  : Bun.spawn(["bun", "run", "dev"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    })

await waitForReady()

const app = Bun.spawn([electron, join(root, "src", "electron-main.mjs"), url], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})

const code = await app.exited
vite?.kill()
process.exit(code ?? 0)
