import { app, BrowserWindow, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { getLogger } from "./logging"

const { autoUpdater } = pkg
type UpdateCheckResult = {
  updateAvailable: boolean
  version?: string
  downloaded?: boolean
  failed?: boolean
  error?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
}
type UpdateDownloadProgress = {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
  downloaded?: boolean
  version?: string
}
let downloadedVersion: string | undefined
let downloadedRelease: Omit<UpdateCheckResult, "updateAvailable"> | undefined
let pendingCheck: Promise<UpdateCheckResult> | undefined
let pendingDownload: Promise<void> | undefined

export function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  if (import.meta.env.OPENCODE_UPDATE_TOKEN) {
    autoUpdater.requestHeaders = {
      Authorization: `Bearer ${import.meta.env.OPENCODE_UPDATE_TOKEN}`,
    }
  }
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    privateReleaseToken: Boolean(import.meta.env.OPENCODE_UPDATE_TOKEN),
    currentVersion: app.getVersion(),
  })
  autoUpdater.on("download-progress", (progress) => {
    const next: UpdateDownloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    }
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("update-download-progress", next))
  })
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  if (downloadedVersion) return { updateAvailable: true, version: downloadedVersion, ...downloadedRelease }
  if (pendingCheck) return pendingCheck

  pendingCheck = checkAndDownloadUpdate().finally(() => {
    pendingCheck = undefined
  })
  return pendingCheck
}

async function checkAndDownloadUpdate(): Promise<UpdateCheckResult> {
  const logger = getLogger()
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    const release = {
      version,
      releaseName: updateInfo?.releaseName ?? undefined,
      releaseDate: updateInfo?.releaseDate ?? undefined,
      releaseNotes: formatReleaseNotes(updateInfo?.releaseNotes),
    }
    logger.log("update available", { version })
    if (!pendingDownload) {
      pendingDownload = autoUpdater
        .downloadUpdate()
        .then(() => {
          downloadedVersion = version
          downloadedRelease = { ...release, downloaded: true }
          logger.log("update download completed", { version })
          BrowserWindow.getAllWindows().forEach((window) =>
            window.webContents.send("update-download-progress", {
              percent: 100,
              bytesPerSecond: 0,
              transferred: 0,
              total: 0,
              downloaded: true,
              version,
            } satisfies UpdateDownloadProgress),
          )
        })
        .catch((error) => {
          logger.error("update download failed", error)
        })
        .finally(() => {
          pendingDownload = undefined
        })
    }
    return { updateAvailable: true, downloaded: false, ...release }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true, error: updateErrorMessage(error) }
  }
}

function formatReleaseNotes(input: unknown) {
  if (typeof input === "string") return input.trim()
  if (!Array.isArray(input)) return undefined
  const notes = input
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return ""
      const value = item as { version?: unknown; note?: unknown }
      const note = typeof value.note === "string" ? value.note : ""
      if (!note) return ""
      return typeof value.version === "string" ? `## ${value.version}\n\n${note}` : note
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return notes || undefined
}

function updateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const url = message.match(/url: (\S+)/)?.[1]
  const status = message.match(/HttpError: (\d+)/)?.[1]
  if (status === "404" && url?.includes("github.com")) {
    return "GitHub 返回 404：未找到可用 Release，或当前仓库/私有 Release 不可访问。"
  }
  if (status) return `更新源返回 HTTP ${status}。`
  return message || "无法获取更新信息。"
}

export async function installUpdate(killSidecar: () => Promise<void>) {
  const result = downloadedVersion ? { updateAvailable: true, version: downloadedVersion } : await checkUpdate()
  const logger = getLogger()
  if (!result.updateAvailable || !downloadedVersion) {
    logger.log("install update skipped", {
      reason: result.failed ? "update check failed" : "no update available",
    })
    return
  }
  logger.log("installing downloaded update", {
    version: result.version ?? null,
  })
  await killSidecar()
  autoUpdater.quitAndInstall()
}

export async function checkForUpdates(alertOnFail: boolean, killSidecar: () => Promise<void>) {
  if (!UPDATER_ENABLED) return
  const logger = getLogger()
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate(killSidecar)
  }
}
