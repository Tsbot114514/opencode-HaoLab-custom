import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { defineConfig, type Plugin, type PluginOption } from "vite"
import app from "@opencode-ai/app/vite"

type SidecarConnection = {
  url: string
  username?: string
  password?: string
}

const sidecarPath = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "ai.opencode.desktop.dev",
  "sidecar.json",
)
const managerDirectory = resolve(process.cwd(), "../..")

async function readSidecar() {
  if (!existsSync(sidecarPath)) return undefined
  return JSON.parse(await readFile(sidecarPath, "utf8")) as SidecarConnection
}

function sidecarPlugin(): Plugin {
  return {
    name: "opencode-manager-sidecar",
    configureServer(server) {
      server.middlewares.use("/connection", async (_req, res) => {
        const sidecar = await readSidecar()
        if (!sidecar) {
          res.statusCode = 404
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ error: `sidecar connection file not found: ${sidecarPath}` }))
          return
        }
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ url: sidecar.url, directory: managerDirectory }))
      })
    },
  }
}

const sidecar = await readSidecar()

if (!sidecar) {
  console.warn(`sidecar connection file not found: ${sidecarPath}`)
  console.warn("Start dev:desktop before using the manager frontend.")
}

export default defineConfig({
  plugins: [...(app as PluginOption[]), sidecarPlugin()],
  server: {
    host: "127.0.0.1",
    port: 17687,
    proxy: sidecar
      ? {
          "/api": {
            target: sidecar.url,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ""),
            headers: {
              ...(sidecar.password
                ? { authorization: `Basic ${Buffer.from(`${sidecar.username ?? "opencode"}:${sidecar.password}`).toString("base64")}` }
                : {}),
              "accept-encoding": "identity",
              "x-opencode-directory": managerDirectory,
            },
          },
        }
      : undefined,
  },
})
