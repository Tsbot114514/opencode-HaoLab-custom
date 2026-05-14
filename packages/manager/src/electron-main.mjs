import { app, BrowserWindow, shell } from "electron"
import { join } from "node:path"

const url = process.argv[2]

if (!url) {
  console.error("missing manager frontend URL")
  app.exit(1)
}

app.setName("opencode-manager-dev")
app.setPath("userData", join(app.getPath("appData"), "ai.opencode.manager.dev"))

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
  process.exit(0)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    title: "管理agent",
    backgroundColor: "#0f1218",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
  })

  win.loadURL(url)
}

app.whenReady().then(() => {
  createWindow()
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
