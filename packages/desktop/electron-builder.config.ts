import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Arch, type Configuration } from "electron-builder"
import pkg from "./package.json"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()
const branding = process.env.OPENCODE_BRANDING === "haolab" ? "haolab" : undefined

const getBase = (): Configuration => ({
  artifactName:
    branding === "haolab" ? "HaoLab-OpenCode-${os}-${arch}.${ext}" : "opencode-desktop-${os}-${arch}.${ext}",
  releaseInfo:
    branding === "haolab" && channel === "prod"
      ? { releaseNotesFile: path.join(rootDir, "packages", "desktop", "release-notes", `${pkg.version}.md`) }
      : undefined,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "resources/**/*",
    {
      from: path.join(rootDir, "node_modules", "typescript"),
      to: "node_modules/typescript",
    },
  ],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  beforePack: async (context) => {
    const target = `${context.electronPlatformName}-${Arch[context.arch]}`
    await access(
      path.join(
        rootDir,
        "packages",
        "desktop",
        "remote-helper",
        "bin",
        target,
        `haolab-remote${context.electronPlatformName === "win32" ? ".exe" : ""}`,
      ),
      constants.F_OK,
    ).catch(() => {
      throw new Error(`Remote helper missing for ${target}. Set HAOLAB_REMOTE_ARCH before running the desktop build.`)
    })
  },
  afterPack: async (context) => {
    const platform = context.electronPlatformName
    const binary = path.join(
      context.packager.getResourcesDir(context.appOutDir),
      "remote-helper",
      platform,
      `haolab-remote${platform === "win32" ? ".exe" : ""}`,
    )
    await access(binary, platform === "win32" ? constants.F_OK : constants.X_OK).catch(() => {
      throw new Error(
        `Remote helper missing or not executable at ${binary}. Build the matching target in remote-helper/bin/ before packaging.`,
      )
    })
  },
  mac: {
    extraResources: [{ from: "remote-helper/bin/darwin-${arch}/", to: "remote-helper/darwin/" }],
    binaries: ["Contents/Resources/remote-helper/darwin/haolab-remote"],
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    extraResources: [{ from: "remote-helper/bin/win32-${arch}/", to: "remote-helper/win32/" }],
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    extraResources: [{ from: "remote-helper/bin/linux-${arch}/", to: "remote-helper/linux/" }],
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.opencode.desktop.dev",
        productName: "OpenCode Dev",
        rpm: { packageName: "opencode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.opencode.desktop.beta",
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "Tsbot114514", repo: "opencode-HaoLab-custom", channel: "latest" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.opencode.desktop",
        productName: branding === "haolab" ? "HaoLab OpenCode" : "OpenCode",
        protocols: { name: branding === "haolab" ? "HaoLab OpenCode" : "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "Tsbot114514", repo: "opencode-HaoLab-custom", channel: "latest" },
        rpm: { packageName: "opencode" },
      }
    }
  }
}

export default getConfig()
