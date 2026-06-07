import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { app } from "electron"

type BootstrapConfig = {
  xdgDataHome?: string
  previousXdgDataHome?: string
  updatedAt?: string
}

export type HaolabDataLocation = {
  bootstrapPath: string
  configured: boolean
  xdgDataHome: string
  activePath: string
  defaultPath: string
}

export type HaolabDataMigrationResult = HaolabDataLocation & {
  copiedFrom: string
  copiedTo: string
  restartRequired: true
}

export function applyHaolabDataConfig(appId: string) {
  const config = readBootstrapConfig(appId)
  if (!config?.xdgDataHome || !path.isAbsolute(config.xdgDataHome)) return
  process.env.XDG_DATA_HOME = config.xdgDataHome
}

export async function getHaolabDataLocation(appId: string): Promise<HaolabDataLocation> {
  const config = await readBootstrapConfigAsync(appId)
  const xdgDataHome = config?.xdgDataHome && path.isAbsolute(config.xdgDataHome) ? config.xdgDataHome : currentXdgDataHome()
  return {
    bootstrapPath: bootstrapPath(appId),
    configured: Boolean(config?.xdgDataHome),
    xdgDataHome,
    activePath: path.join(xdgDataHome, "opencode"),
    defaultPath: defaultOpencodePath(),
  }
}

export async function migrateHaolabData(appId: string, selectedDir: string): Promise<HaolabDataMigrationResult> {
  if (!path.isAbsolute(selectedDir)) throw new Error("请选择一个有效的绝对路径。")
  const before = await getHaolabDataLocation(appId)
  const targetXdgDataHome = path.join(selectedDir, "haolabcode-data", "data")
  const target = path.join(targetXdgDataHome, "opencode")

  if (path.normalize(before.activePath) === path.normalize(target)) {
    throw new Error("新数据目录与当前目录相同。")
  }
  if (await hasEntries(target)) {
    throw new Error(`目标目录已存在且不为空：${target}`)
  }

  await mkdir(targetXdgDataHome, { recursive: true })
  if (existsSync(before.activePath)) {
    await cp(before.activePath, target, { recursive: true, errorOnExist: true, force: false })
  } else {
    await mkdir(target, { recursive: true })
  }

  await writeBootstrapConfig(appId, {
    xdgDataHome: targetXdgDataHome,
    previousXdgDataHome: before.xdgDataHome,
    updatedAt: new Date().toISOString(),
  })

  const after = await getHaolabDataLocation(appId)
  return {
    ...after,
    copiedFrom: before.activePath,
    copiedTo: target,
    restartRequired: true,
  }
}

export async function deleteDefaultHaolabData(appId: string) {
  const location = await getHaolabDataLocation(appId)
  if (path.normalize(location.activePath) === path.normalize(location.defaultPath)) {
    throw new Error("当前仍在使用默认数据目录，不能删除。")
  }
  await rm(location.defaultPath, { recursive: true, force: true })
  return { ...location, deletedPath: location.defaultPath }
}

function bootstrapPath(appId: string) {
  return path.join(app.getPath("appData"), appId, "haolab-paths.json")
}

function defaultXdgDataHome() {
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support")
  if (process.platform === "win32") return path.join(homedir(), ".local", "share")
  return path.join(homedir(), ".local", "share")
}

function defaultOpencodePath() {
  return path.join(defaultXdgDataHome(), "opencode")
}

function currentXdgDataHome() {
  return process.env.XDG_DATA_HOME || defaultXdgDataHome()
}

function readBootstrapConfig(appId: string) {
  try {
    return JSON.parse(readFileSync(bootstrapPath(appId), "utf8")) as BootstrapConfig
  } catch {
    return undefined
  }
}

async function readBootstrapConfigAsync(appId: string) {
  try {
    return JSON.parse(await readFile(bootstrapPath(appId), "utf8")) as BootstrapConfig
  } catch {
    return undefined
  }
}

async function writeBootstrapConfig(appId: string, config: BootstrapConfig) {
  await mkdir(path.dirname(bootstrapPath(appId)), { recursive: true })
  await writeFile(bootstrapPath(appId), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

async function hasEntries(dir: string) {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}
