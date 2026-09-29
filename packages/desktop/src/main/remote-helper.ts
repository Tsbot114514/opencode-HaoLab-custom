import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, session } from "electron"
import type { RemoteStatus, ServerReadyData } from "../preload/types"
import { getStore } from "./store"

type Command = "status" | "enable" | "disable" | "sidecar" | "auth-key" | "connect" | "disconnect"
type Reply = { id: number; result?: RemoteStatus; error?: string }
type CommandData = { url?: string; username?: string; password?: string; share?: string; authKey?: string }
const ENABLED = "remote.enabled"
const LEGACY_SHARE = "remote.share"
const LEGACY_PAIRING = "remote.pairing"

export class RemoteHelper {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private pending = new Map<
    number,
    { resolve: (status: RemoteStatus) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private id = 0
  private buffer = ""
  private queue: Promise<unknown> = Promise.resolve()
  private sidecar?: ServerReadyData

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

  status() {
    return this.run("status")
  }

  enable() {
    return this.run("enable").then(async (initial) => {
      getStore().set(ENABLED, initial.enabled)
      return this.waitForAuth(initial)
    })
  }

  setAuthKey(authKey: string) {
    return this.run("auth-key", { authKey: authKey.trim() }).then((status) => {
      writeFileSync(this.authKeyPath(), authKey.trim(), { mode: 0o600 })
      if (process.platform !== "win32") chmodSync(this.authKeyPath(), 0o600)
      return status
    })
  }

  disable() {
    return this.run("disable").then((status) => {
      getStore().delete(ENABLED)
      return status
    })
  }

  connect(share: string) {
    if (!share.trim()) return Promise.reject(new Error("Share is required"))
    return this.run("connect", { share: share.trim() }).then(async (initial) => {
      writeFileSync(this.pairingPath(), share.trim(), { mode: 0o600 })
      if (process.platform !== "win32") chmodSync(this.pairingPath(), 0o600)
      return this.waitForAuth(initial)
    })
  }

  disconnect() {
    return this.run("disconnect").then((status) => {
      rmSync(this.pairingPath(), { force: true })
      return status
    })
  }

  stop() {
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
    if (typeof legacyPairing === "string" && legacyPairing && !existsSync(this.pairingPath())) {
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
      await this.send("enable")
    }
    if (existsSync(this.pairingPath())) {
      const pairing = readFileSync(this.pairingPath(), "utf8").trim()
      if (pairing) await this.send("connect", { share: pairing })
    }
  }

  private pairingPath() {
    return join(app.getPath("userData"), "remote-helper", "pairing.share")
  }

  private authKeyPath() {
    return join(app.getPath("userData"), "remote-helper", "auth.key")
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
