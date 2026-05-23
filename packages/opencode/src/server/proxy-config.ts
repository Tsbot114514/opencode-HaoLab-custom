import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import fs from "fs/promises"
import * as http from "node:http"
import path from "path"

const log = Log.create({ service: "proxy-config" })

export type Info = {
  enabled: boolean
  url: string
}

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

const defaultConfig: Info = { enabled: false, url: "" }
const loopback = ["127.0.0.1", "localhost", "::1"]

export function file() {
  return path.join(Global.Path.state, "proxy.json")
}

export async function get(): Promise<Info> {
  return parse(await fs.readFile(file(), "utf8").catch(() => undefined))
}

export async function update(config: Partial<Info>): Promise<Info> {
  const next = normalize({ ...(await get()), ...config })
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(next, null, 2))
  return next
}

export async function apply(config?: Info) {
  const next = config ?? (await get())
  const url = proxyUrl(next.url)
  if (next.enabled && url) {
    process.env.HTTP_PROXY = url
    process.env.HTTPS_PROXY = url
    process.env.http_proxy = url
    process.env.https_proxy = url
  } else {
    if (next.enabled && next.url.trim()) log.warn("ignoring invalid proxy configuration", { url: next.url })
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
  }

  ensureLoopbackNoProxy()
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    log.warn("failed to apply proxy environment", { error })
  }
}

function parse(input: string | undefined) {
  if (!input) return defaultConfig
  try {
    return normalize(JSON.parse(input) as Partial<Info>)
  } catch {
    return defaultConfig
  }
}

function normalize(input: Partial<Info>): Info {
  return {
    enabled: input.enabled === true,
    url: typeof input.url === "string" ? input.url : "",
  }
}

function proxyUrl(input: string) {
  const value = input.trim()
  if (!value) return
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    if (!url.hostname || !url.port) return
    return value
  } catch {
    return
  }
}

function ensureLoopbackNoProxy() {
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)

    for (const host of loopback) {
      if (items.some((value) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

export * as ProxyConfig from "./proxy-config"
