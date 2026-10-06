import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type {
  InitStep,
  RemoteStatus,
  FatalRendererError,
  ServerReadyData,
  SqliteMigrationProgress,
  TitlebarTheme,
  WindowConfig,
  WslConfig,
} from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { getStore } from "./store"
import { allowDisplayCacheKey, validStoreName } from "./display-cache-authorization"
import { createTranscriptAuthority } from "./transcript-cache"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
  killSidecar: () => Promise<void> | void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  remoteStatus: () => Promise<RemoteStatus>
  remoteCacheKeyCurrent: () => string | undefined
  remoteEnable: () => Promise<RemoteStatus>
  remoteSetAuthKey: (authKey: string) => Promise<RemoteStatus>
  remoteDisable: () => Promise<RemoteStatus>
  remoteConnect: (share: string) => Promise<RemoteStatus>
  remoteDisconnect: () => Promise<RemoteStatus>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  getHaolabDataLocation: () => Promise<{
    bootstrapPath: string
    configured: boolean
    xdgDataHome: string
    activePath: string
    defaultPath: string
  }>
  migrateHaolabData: (selectedDir: string) => Promise<{
    bootstrapPath: string
    configured: boolean
    xdgDataHome: string
    activePath: string
    defaultPath: string
    copiedFrom: string
    copiedTo: string
    restartRequired: true
  }>
  deleteDefaultHaolabData: () => Promise<{
    bootstrapPath: string
    configured: boolean
    xdgDataHome: string
    activePath: string
    defaultPath: string
    deletedPath: string
  }>
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{
    updateAvailable: boolean
    version?: string
    failed?: boolean
    error?: string
    releaseName?: string
    releaseDate?: string
    releaseNotes?: string
  }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const transcripts = createTranscriptAuthority({
    get: (scope) => getStore("opencode.transcripts.dat").get(scope),
    set: (scope, value) => getStore("opencode.transcripts.dat").set(scope, value),
  })
  const queues = new Map<string, Promise<unknown>>()
  const ordered = <T>(scope: string, action: () => Promise<T>) => {
    const next = (queues.get(scope) ?? Promise.resolve()).catch(() => undefined).then(action)
    queues.set(scope, next)
    void next.finally(() => { if (queues.get(scope) === next) queues.delete(scope) }).catch(() => undefined)
    return next
  }
  const clients = new WeakSet<Electron.WebContents>()
  ipcMain.handle("transcript-open", (event: IpcMainInvokeEvent, scope: string) => {
    if (!allowDisplayCacheKey("opencode.transcripts.dat", scope, deps.remoteCacheKeyCurrent)) return
    if (!clients.has(event.sender)) {
      clients.add(event.sender)
      event.sender.once("destroyed", () => transcripts.release(event.sender.id))
    }
    return transcripts.open(scope, event.sender.id)
  })
  ipcMain.handle("transcript-read-page", (event: IpcMainInvokeEvent, scope: string, owner: string, directory: string, sessionID: string, before?: string) => {
    if (!allowDisplayCacheKey("opencode.transcripts.dat", scope, deps.remoteCacheKeyCurrent)) return
    return transcripts.readPage(scope, event.sender.id, owner, directory, sessionID, before)
  })
  ipcMain.handle("transcript-acquire", (event: IpcMainInvokeEvent, scope: string, owner: string, directory: string, sessionID: string) =>
    (() => {
      if (!allowDisplayCacheKey("opencode.transcripts.dat", scope, deps.remoteCacheKeyCurrent)) return
      return transcripts.acquire(scope, event.sender.id, owner, directory, sessionID)
    })(),
  )
  ipcMain.handle("transcript-mutate", (event: IpcMainInvokeEvent, scope: string, owner: string, operations: unknown) =>
    ordered(scope, async () => {
      if (!allowDisplayCacheKey("opencode.transcripts.dat", scope, deps.remoteCacheKeyCurrent)) return
      transcripts.mutate(scope, event.sender.id, owner, operations)
    }),
  )
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("remote-status", () => deps.remoteStatus())
  ipcMain.handle("remote-enable", () => deps.remoteEnable())
  ipcMain.handle("remote-set-auth-key", (_event: IpcMainInvokeEvent, authKey: string) => deps.remoteSetAuthKey(authKey))
  ipcMain.handle("remote-disable", () => deps.remoteDisable())
  ipcMain.handle("remote-connect", (_event: IpcMainInvokeEvent, share: string) => deps.remoteConnect(share))
  ipcMain.handle("remote-disconnect", () => deps.remoteDisconnect())
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("get-haolab-data-location", () => deps.getHaolabDataLocation())
  ipcMain.handle("migrate-haolab-data", (_event: IpcMainInvokeEvent, selectedDir: string) =>
    deps.migrateHaolabData(selectedDir),
  )
  ipcMain.handle("delete-default-haolab-data", () => deps.deleteDefaultHaolabData())
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", async (event: IpcMainInvokeEvent, name: string, key: string) => {
    if (!validStoreName(name)) return null
    if (name === "opencode.transcripts.dat") return ordered(key, async () => {
      if (!allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)) return null
      if (!clients.has(event.sender)) {
        clients.add(event.sender)
        const client = event.sender.id
        event.sender.once("destroyed", () => transcripts.release(client))
      }
      return transcripts.read(key, event.sender.id)
    })
    if (!allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)) return null
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", async (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    if (!validStoreName(name) || name === "opencode.transcripts.dat") return
    if (name === "opencode.sidebar-display.dat" && (typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 * 1024)) return
    if (!allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)) return
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", async (_event: IpcMainInvokeEvent, name: string, key: string) => {
    if (!validStoreName(name)) return
    if (name === "opencode.transcripts.dat") return ordered(key, async () => {
      if (!allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)) return
      transcripts.delete(key)
      getStore(name).delete(key)
    })
    if (!allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)) return
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    if (!validStoreName(name) || ["opencode.transcripts.dat", "opencode.sidebar-display.dat"].includes(name)) return
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", async (_event: IpcMainInvokeEvent, name: string) => {
    if (!validStoreName(name)) return []
    const store = getStore(name)
    const keys = Object.keys(store.store)
    return keys.filter((key) => allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent))
  })
  ipcMain.handle("store-length", async (_event: IpcMainInvokeEvent, name: string) => {
    if (!validStoreName(name)) return 0
    const store = getStore(name)
    return Object.keys(store.store).filter((key) => allowDisplayCacheKey(name, key, deps.remoteCacheKeyCurrent)).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.handle("open-link", (_event: IpcMainInvokeEvent, url: string) => shell.openExternal(url))

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action)
  })
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
