import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { BlockList, isIP } from "node:net"
import { app, session } from "electron"
import type { RemoteStatus, ServerReadyData } from "../preload/types"
import { getStore } from "./store"

type Command = "status" | "enable" | "disable" | "sidecar" | "auth-key" | "connect" | "disconnect" | "projects"
type Reply = { id: number; result?: RemoteStatus; error?: string }
type CommandData = {
  url?: string
  username?: string
  password?: string
  share?: string
  authKey?: string
  projects?: string[]
}
const ENABLED = "remote.enabled"
const LEGACY_SHARE = "remote.share"
const LEGACY_PAIRING = "remote.pairing"

export class RemoteHelper {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private projectTimer?: ReturnType<typeof setInterval>
  private lastProjects?: string[]
  private pending = new Map<
    number,
    { resolve: (status: RemoteStatus) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private id = 0
  private buffer = ""
  private queue: Promise<unknown> = Promise.resolve()
  private sidecar?: ServerReadyData
  private pairingRevoked = false
  private pairingGeneration = 0

  setSidecar(data: ServerReadyData) {
    if (this.sidecar?.url === data.url && this.sidecar.password === data.password) return
    this.sidecar = data
    if (this.child)
      void this.run("sidecar", {
        url: data.url,
        username: data.username ?? undefined,
        password: data.password ?? undefined,
      }).catch(() => undefined)
  }

  async status() {
    return this.withCacheKey(await this.run("status"))
  }

  currentCacheKey(connectionHost?: string) {
    if (this.pairingRevoked) return
    try {
      const share = readFileSync(this.pairingPath(), "utf8").trim()
      const host = pairingHost(share)
      if (!host) return
      if (connectionHost !== undefined && connectionHost !== host) return
      return createHash("sha256")
        .update("opencode.desktop.remote-display-cache.v1\0")
        .update(share)
        .update("\0")
        .update(host)
        .digest("hex")
    } catch {
      // Missing or corrupt local pairing must fail closed, without contacting the helper.
      return
    }
  }

  async enable() {
    const projects = this.sidebarProjects()
    await this.run("projects", { projects })
    this.lastProjects = projects
    const initial = await this.run("enable")
    getStore().set(ENABLED, initial.enabled)
    this.watchProjects()
    return this.withCacheKey(await this.waitForAuth(initial))
  }

  setAuthKey(authKey: string) {
    return this.run("auth-key", { authKey: authKey.trim() }).then((status) => {
      writeFileSync(this.authKeyPath(), authKey.trim(), { mode: 0o600 })
      if (process.platform !== "win32") chmodSync(this.authKeyPath(), 0o600)
      return status
    })
  }

  disable() {
    if (this.projectTimer) clearInterval(this.projectTimer)
    this.projectTimer = undefined
    return this.run("disable").then((status) => {
      getStore().delete(ENABLED)
      return status
    })
  }

  connect(share: string) {
    if (!share.trim()) return Promise.reject(new Error("Share is required"))
    if (!pairingHost(share.trim())) return Promise.reject(new Error("Invalid share"))
    const generation = ++this.pairingGeneration
    this.revokePairing()
    return this.run("connect", { share: share.trim() }).then(async (initial) => {
      if (generation !== this.pairingGeneration) return { ...initial, cacheKey: undefined }
      writeFileSync(this.pairingPath(), share.trim(), { mode: 0o600 })
      if (process.platform !== "win32") chmodSync(this.pairingPath(), 0o600)
      this.pairingRevoked = false
      const status = await this.waitForAuth(initial)
      if (generation !== this.pairingGeneration) return { ...status, cacheKey: undefined }
      return this.withCacheKey(status)
    })
  }

  disconnect() {
    ++this.pairingGeneration
    this.revokePairing()
    return this.run("disconnect").then((status) => ({ ...status, cacheKey: undefined }))
  }

  private revokePairing() {
    this.pairingRevoked = true
    rmSync(this.pairingPath(), { force: true })
    getStore().delete(LEGACY_PAIRING)
    for (const name of ["opencode.sidebar-display.dat", "opencode.transcripts.dat"]) {
      const store = getStore(name)
      for (const key of Object.keys(store.store)) {
        if (key.startsWith("tunnel.v1.")) store.delete(key)
      }
    }
  }

  stop() {
    if (this.projectTimer) clearInterval(this.projectTimer)
    this.projectTimer = undefined
    this.child?.kill()
  }

  private run(command: Command, data: CommandData = {}) {
    const task = this.queue.then(async () => {
      await this.start()
      return this.send(command, data)
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  private async start() {
    if (this.child) return
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async launch() {
    const directory = join(app.getPath("userData"), "remote-helper")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const store = getStore()
    const legacyPairing = store.get(LEGACY_PAIRING)
    if (!this.pairingRevoked && typeof legacyPairing === "string" && legacyPairing && !existsSync(this.pairingPath())) {
      writeFileSync(this.pairingPath(), legacyPairing, { mode: 0o600 })
    }
    if (existsSync(this.pairingPath()) && process.platform !== "win32") chmodSync(this.pairingPath(), 0o600)
    if (existsSync(this.authKeyPath()) && process.platform !== "win32") chmodSync(this.authKeyPath(), 0o600)
    store.delete(LEGACY_PAIRING)
    store.delete(LEGACY_SHARE)
    const binary = `haolab-remote${process.platform === "win32" ? ".exe" : ""}`
    const executable = app.isPackaged
      ? join(process.resourcesPath, "remote-helper", process.platform, binary)
      : join(app.getAppPath(), "remote-helper", "bin", `${process.platform}-${process.arch}`, binary)
    const proxy =
      process.platform === "darwin" && !process.env.HTTPS_PROXY && !process.env.https_proxy
        ? await session.defaultSession.resolveProxy("https://controlplane.tailscale.com").catch(() => "DIRECT")
        : "DIRECT"
    const route = proxy.split(";")[0]?.trim().match(/^(PROXY|HTTPS|SOCKS5?)\s+(\S+)$/i)
    const scheme = route?.[1].toUpperCase() === "HTTPS" ? "https" : route?.[1].startsWith("SOCKS") ? "socks5" : "http"
    const child = spawn(executable, ["--state-dir", directory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: route ? { ...process.env, HTTPS_PROXY: `${scheme}://${route[2]}` } : process.env,
    })
    this.child = child
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk
      for (let end = this.buffer.indexOf("\n"); end !== -1; end = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let reply: Reply
        try {
          reply = JSON.parse(line) as Reply
        } catch {
          continue
        }
        if (typeof reply?.id !== "number") continue
        const pending = this.pending.get(reply.id)
        if (!pending) continue
        this.pending.delete(reply.id)
        clearTimeout(pending.timer)
        if (reply.error) pending.reject(new Error(reply.error))
        else if (reply.result) pending.resolve(reply.result)
        else pending.reject(new Error("Remote helper returned no status"))
      }
    })
    // stderr may include credentials; never forward it to application logs.
    child.stderr.resume()
    const fail = (error: Error) => {
      if (this.child !== child) return
      this.child = undefined
      this.buffer = ""
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.pending.clear()
    }
    child.on("error", fail)
    child.on("exit", () => fail(new Error("Remote helper exited")))
    if (this.sidecar)
      await this.send("sidecar", {
        url: this.sidecar.url,
        username: this.sidecar.username ?? undefined,
        password: this.sidecar.password ?? undefined,
      })
    if (existsSync(this.authKeyPath())) {
      await this.send("auth-key", { authKey: readFileSync(this.authKeyPath(), "utf8").trim() })
    }
    if (store.get(ENABLED) === true) {
      const projects = this.sidebarProjects()
      await this.send("projects", { projects })
      this.lastProjects = projects
      await this.send("enable")
      this.watchProjects()
    }
    if (!this.pairingRevoked && existsSync(this.pairingPath())) {
      const pairing = readFileSync(this.pairingPath(), "utf8").trim()
      if (pairing) await this.send("connect", { share: pairing })
    }
  }

  private pairingPath() {
    return join(app.getPath("userData"), "remote-helper", "pairing.share")
  }

  private withCacheKey(status: RemoteStatus): RemoteStatus {
    return { ...status, cacheKey: this.currentCacheKey(status.connection?.host) }
  }

  private authKeyPath() {
    return join(app.getPath("userData"), "remote-helper", "auth.key")
  }

  private sidebarProjects() {
    const stored = getStore("opencode.global.dat").get("server")
    if (typeof stored !== "string") return []
    try {
      const data = JSON.parse(stored) as { projects?: { local?: Array<{ worktree?: string }> } }
      if (!Array.isArray(data?.projects?.local)) return []
      return data.projects.local
        .map((project) => project.worktree)
        .filter((directory): directory is string => typeof directory === "string" && isAbsolute(directory))
    } catch {
      return []
    }
  }

  private watchProjects() {
    if (this.projectTimer) return
    this.projectTimer = setInterval(() => {
      const projects = this.sidebarProjects()
      if (this.lastProjects?.length === projects.length && projects.every((value, index) => this.lastProjects?.[index] === value)) return
      this.lastProjects = projects
      void this.run("projects", { projects }).catch(() => {
        this.lastProjects = undefined
      })
    }, 5_000)
  }

  private async waitForAuth(initial: RemoteStatus) {
    if (initial.online || initial.authUrl) return initial
    let status = initial
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      status = await this.run("status")
      if (status.online || status.authUrl) return status
    }
    return status
  }

  private send(command: Command, data: CommandData = {}) {
    const child = this.child
    if (!child) return Promise.reject(new Error("Remote helper unavailable"))
    const id = ++this.id
    return new Promise<RemoteStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Remote helper timed out"))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, command, ...data }) + "\n", (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error("Failed to write to remote helper"))
      })
    })
  }
}

// Keep the saved invitation validation aligned with remote-helper/main.go:parseShare.
export function pairingHost(raw: string): string | undefined {
  try {
    const share = JSON.parse(raw)
    if (!share || typeof share !== "object" || Array.isArray(share)) return
    if (Object.keys(share).some((key) => !["version", "host", "port", "token", "authKey"].includes(key))) return
    if (![1, 2].includes(share.version) || share.port !== 41642 || typeof share.host !== "string") return
    if (typeof share.token !== "string" || !/^[a-fA-F0-9]{64}$/.test(share.token)) return
    if (share.version === 1 && share.authKey !== undefined && share.authKey !== "") return
    if (share.version === 2 && (typeof share.authKey !== "string" || !/^tskey-auth-\S+$/.test(share.authKey) || share.authKey.length > 512)) return
    const family = isIP(share.host)
    if (family) {
      if (share.host.includes("%")) return
      const tailnet = new BlockList()
      if (family === 4) tailnet.addSubnet("100.64.0.0", 10, "ipv4")
      if (family === 6) tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6")
      return tailnet.check(share.host, family === 4 ? "ipv4" : "ipv6") ? share.host : undefined
    }
    if (!share.host.endsWith(".ts.net") || !share.host.split(".").every((label: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return
    return share.host
  } catch {
    return
  }
}
