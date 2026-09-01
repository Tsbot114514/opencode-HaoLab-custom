import type { Event, Message, Part, Session, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DataProvider } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { TextField } from "@opencode-ai/ui/text-field"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { useGlobalSDK } from "@/context/global-sdk"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import { Identifier } from "@/utils/id"
import { authTokenFromCredentials } from "@/utils/server"
import type { UpdateDownloadProgress } from "@/context/platform"
import { compareMessages } from "@/utils/message-order"

const managerSessionID = "ses_manager_agent"
const managerTitle = "管理agent"
const defaultProxyPrefix = "http://127.0.0.1:"

type ProxyConfig = {
  enabled: boolean
  url: string
}

type WithParts = {
  info: Message
  parts: Part[]
}

type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "latest" | "error" | "installing" | "unsupported"

function sortByID<T extends { id: string }>(items: T[]) {
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function sortMessages(items: WithParts[]) {
  return items.sort((a, b) => compareMessages(a.info, b.info))
}

function proxyUrl(input: string) {
  const value = input.trim()
  return value === defaultProxyPrefix ? "" : value
}

function validateProxyUrl(input: string) {
  const value = proxyUrl(input)
  if (!value) return ""
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "代理地址必须以 http:// 或 https:// 开头。"
    if (!url.hostname || !url.port) return "代理地址必须包含主机和端口，例如 http://127.0.0.1:7890。"
    return ""
  } catch {
    return "代理地址格式不正确，例如 http://127.0.0.1:7890。"
  }
}

function formatBytes(value: number | undefined) {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatSpeed(value: number | undefined) {
  if (!value || value <= 0) return ""
  return `${formatBytes(value)}/s`
}

export default function ManagerPage() {
  const sdk = useGlobalSDK()
  const models = useModels()
  const providers = useProviders()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [update, setUpdate] = createStore({
    available: false,
    checking: false,
    installing: false,
    message: undefined as string | undefined,
    phase: "idle" as UpdatePhase,
    progress: undefined as UpdateDownloadProgress | undefined,
    releaseDate: undefined as string | undefined,
    releaseName: undefined as string | undefined,
    releaseNotes: undefined as string | undefined,
    version: undefined as string | undefined,
  })
  const [proxy, setProxy] = createSignal("")
  const [proxyEnabled, setProxyEnabled] = createSignal(false)
  const [proxyMessage, setProxyMessage] = createSignal("")
  const [proxySaving, setProxySaving] = createSignal(false)
  const [startupPage, setStartupPage] = createSignal<"manager" | "classic">("manager")
  const [startupSaving, setStartupSaving] = createSignal(false)
  const [startupMessage, setStartupMessage] = createSignal("")
  const [storage, setStorage] = createStore({
    migrating: false,
    deleting: false,
    message: "",
  })
  const [draft, setDraft] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [error, setError] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [messages, setMessages] = createSignal<WithParts[]>([])
  const [session, setSession] = createSignal<Session>()
  const [sessionStatus, setSessionStatus] = createSignal<SessionStatus>({ type: "idle" })

  const modelOptions = () =>
    models
      .list()
      .filter((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))

  const openProviderConfig = () => dialog.show(() => <DialogSelectProvider />)

  const confirmAction = (input: { title: string; body: string; confirm: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => {
      let settled = false
      const done = (value: boolean) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      dialog.show(
        () => (
          <Dialog title={input.title} fit class="overflow-hidden">
            <div class="w-[min(calc(100vw-48px),560px)]">
              <div
                classList={{
                  "rounded-2xl border p-4": true,
                  "border-danger-base/30 bg-danger-base/5": Boolean(input.danger),
                  "border-v2-border-border-base bg-v2-background-bg-deep": !input.danger,
                }}
              >
                <div class="flex gap-3">
                  <div
                    classList={{
                      "mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl": true,
                      "bg-danger-base/10 text-danger-base": Boolean(input.danger),
                      "bg-icon-warning-base/10 text-icon-warning-base": !input.danger,
                    }}
                  >
                    <Icon name={input.danger ? "trash" : "folder"} size="small" />
                  </div>
                  <p class="min-w-0 whitespace-pre-wrap text-13-regular leading-6 text-v2-text-text-muted">{input.body}</p>
                </div>
              </div>
              <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="ghost"
                  size="small"
                  class="sm:min-w-24"
                  onClick={() => {
                    dialog.close()
                    done(false)
                  }}
                >
                  取消
                </Button>
                <Button
                  variant={input.danger ? "secondary" : "primary"}
                  size="small"
                  class="sm:min-w-24"
                  onClick={() => {
                    dialog.close()
                    done(true)
                  }}
                >
                  {input.confirm}
                </Button>
              </div>
            </div>
          </Dialog>
        ),
        () => done(false),
      )
    })

  const DataMigrationDialog = () => {
    const [selectedDir, setSelectedDir] = createSignal("")
    const [running, setRunning] = createSignal(false)
    const [message, setMessage] = createSignal("")
    const targetPath = () => (selectedDir() ? `${selectedDir()}\\haolabcode-data\\data\\opencode` : "选择文件夹后自动生成")

    const chooseDir = async () => {
      if (!platform.selectHaolabDataDirectory) {
        setMessage("当前环境不支持选择数据目录。")
        return
      }
      const result = await platform.selectHaolabDataDirectory()
      if (result) {
        setSelectedDir(result)
        setMessage("")
      }
    }

    const run = async () => {
      if (!selectedDir()) {
        setMessage("请先选择一个文件夹。")
        return
      }
      if (!platform.migrateHaolabData) {
        setMessage("当前环境不支持修改数据存储路径。")
        return
      }
      setRunning(true)
      setMessage("正在复制数据目录，请不要继续会话或启动 agent...")
      try {
        const result = await platform.migrateHaolabData(selectedDir())
        setMessage(`迁移完成。新目录：${result.activePath}。正在重启 HaoLab OpenCode...`)
        await platform.restart()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      } finally {
        setRunning(false)
      }
    }

    return (
      <Dialog title="修改数据存储路径" fit class="overflow-hidden">
        <div class="w-[min(calc(100vw-48px),620px)]">
          <div class="rounded-3xl border border-v2-border-border-base bg-v2-background-bg-deep p-4">
            <div class="flex items-start gap-3">
              <div class="grid size-10 shrink-0 place-items-center rounded-2xl bg-icon-warning-base/10 text-icon-warning-base">
                <Icon name="folder" size="small" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-13-medium text-v2-text-text-base">选择新的数据存储位置</div>
                <p class="mt-1 text-12-regular leading-5 text-v2-text-text-muted">
                  系统会在你选择的文件夹下自动创建 <span class="font-mono">haolabcode-data</span> 子文件夹。
                </p>
              </div>
            </div>
            <div class="mt-4 flex gap-2">
              <div class="min-w-0 flex-1 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2">
                <div class="truncate text-12-regular text-v2-text-text-base">{selectedDir() || "尚未选择文件夹"}</div>
              </div>
              <Button variant="secondary" size="small" disabled={running()} onClick={() => void chooseDir()}>
                选择文件夹
              </Button>
            </div>
            <div class="mt-3 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2">
              <div class="text-11-medium text-v2-text-text-muted">迁移后的 OpenCode 数据目录</div>
              <div class="mt-1 break-all font-mono text-12-regular text-v2-text-text-base">{targetPath()}</div>
            </div>
          </div>

          <div class="mt-4 rounded-2xl border border-icon-warning-base/25 bg-icon-warning-base/5 p-3">
            <div class="flex gap-2">
              <Icon name="warning" size="small" class="mt-0.5 shrink-0 text-icon-warning-base" />
              <p class="text-12-regular leading-5 text-v2-text-text-muted">
                迁移会复制当前 OpenCode 数据目录。迁移期间请停止所有 agent 活动，不要继续会话。迁移完成后 HaoLab OpenCode 会自动重启，旧数据会保留。
              </p>
            </div>
          </div>

          <Show when={message()}>
            <p class="mt-3 rounded-xl border border-v2-border-border-base bg-v2-background-bg-deep px-3 py-2 text-12-regular leading-5 text-v2-text-text-muted break-words">
              {message()}
            </p>
          </Show>

          <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" size="small" class="sm:min-w-24" disabled={running()} onClick={() => dialog.close()}>
              取消
            </Button>
            <Button variant="primary" size="small" class="sm:min-w-28" disabled={running() || !selectedDir()} onClick={() => void run()}>
              {running() ? "正在迁移..." : "开始迁移"}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const saveStartupPage = async (value: "manager" | "classic") => {
    const storage = platform.storage?.("opencode.global.dat")
    if (!storage) {
      setStartupMessage("当前环境不支持保存启动页面。")
      return
    }
    setStartupSaving(true)
    setStartupMessage("")
    try {
      await Promise.resolve(storage.setItem("haolab.startupPage", value))
      setStartupPage(value)
      setStartupMessage(value === "manager" ? "启动时将进入管理页面。" : "启动时将进入正式页面。")
    } catch (err) {
      setStartupMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setStartupSaving(false)
    }
  }

  const readHaolabDataLocation = async () => {
    if (!platform.getHaolabDataLocation) return undefined
    return platform.getHaolabDataLocation()
  }

  const [haolabDataLocation, { refetch: refetchHaolabDataLocation }] = createResource(readHaolabDataLocation)

  const migrateHaolabData = async () => {
    if (!platform.migrateHaolabData || !platform.selectHaolabDataDirectory) {
      setStorage("message", "当前环境不支持修改数据存储路径。")
      return
    }
    dialog.show(() => <DataMigrationDialog />)
  }

  const deleteDefaultHaolabData = async () => {
    if (!platform.deleteDefaultHaolabData) {
      setStorage("message", "当前环境不支持删除默认数据目录。")
      return
    }
    const confirmed = await confirmAction({
      title: "删除原默认数据目录",
      body: "请确认重启后一切运行正常。继续后会删除默认路径下的 OpenCode 数据文件夹。\n\n该操作不会删除当前自定义数据目录。",
      confirm: "继续删除",
      danger: true,
    })
    if (!confirmed) return
    setStorage({ deleting: true, message: "正在删除默认数据目录..." })
    try {
      const result = await platform.deleteDefaultHaolabData()
      await refetchHaolabDataLocation()
      setStorage("message", `已删除默认数据目录：${result.deletedPath}`)
    } catch (err) {
      setStorage("message", err instanceof Error ? err.message : String(err))
    } finally {
      setStorage("deleting", false)
    }
  }

  const checkUpdate = async () => {
    if (!platform.checkUpdate) {
      setUpdate({ message: "当前环境不支持检查更新。", phase: "unsupported" })
      return
    }

    setUpdate({
      available: false,
      checking: true,
      message: "正在检查更新...",
      phase: "checking",
      progress: undefined,
      releaseDate: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      version: undefined,
    })
    await platform
      .checkUpdate()
      .then((result) => {
        if (result.failed) {
          setUpdate({ message: result.error ?? "无法获取更新信息，请稍后重试或检查网络/代理设置。", phase: "error" })
          return
        }

        if (!result.updateAvailable) {
          setUpdate({ message: `当前已是最新版本${platform.version ? `（${platform.version}）` : ""}。`, phase: "latest" })
          return
        }

        setUpdate({
          available: true,
          checking: !result.downloaded,
          message: result.downloaded
            ? result.version
              ? `更新 ${result.version} 已下载完成，重启后完成安装。`
              : "更新已下载完成，重启后完成安装。"
            : result.version
              ? `发现更新 ${result.version}，正在后台下载。`
              : "发现更新，正在后台下载。",
          phase: result.downloaded ? "ready" : "downloading",
          releaseDate: result.releaseDate,
          releaseName: result.releaseName,
          releaseNotes: result.releaseNotes,
          progress: result.downloaded ? undefined : update.progress,
          version: result.version ?? "",
        })
      })
      .catch((err: unknown) => {
        setUpdate({ message: err instanceof Error ? err.message : String(err), phase: "error" })
      })
      .finally(() => setUpdate("checking", false))
  }

  const installUpdate = async () => {
    if (!platform.updateAndRestart) return
    setUpdate({ installing: true, phase: "installing", message: "正在准备重启并安装更新..." })
    await platform.updateAndRestart().catch((err: unknown) => {
      setUpdate({
        installing: false,
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  const showUpdateNotes = () => {
    dialog.show(() => (
      <Dialog title={update.releaseName || (update.version ? `版本 ${update.version}` : "版本更新内容")} size="large" fit>
        <div class="max-h-[min(60vh,520px)] w-[min(calc(100vw-48px),720px)] overflow-y-auto px-1 pb-1">
          <Show when={update.releaseDate || update.version}>
            <div class="mb-3 text-12-regular text-v2-text-text-muted leading-5">
              <Show when={update.version}>版本：{update.version}</Show>
              <Show when={update.releaseDate}> · 发布时间：{new Date(update.releaseDate!).toLocaleString()}</Show>
            </div>
          </Show>
          <Markdown
            text={update.releaseNotes || "远端没有提供版本更新说明。"}
            class="break-words text-13-regular leading-6 text-v2-text-text-base"
          />
        </div>
      </Dialog>
    ))
  }

  const unsubscribeUpdateProgress = platform.onUpdateDownloadProgress?.((progress) => {
    if (progress.downloaded) {
      setUpdate({
        available: true,
        checking: false,
        message: progress.version ? `更新 ${progress.version} 已下载完成，重启后完成安装。` : "更新已下载完成，重启后完成安装。",
        phase: "ready",
        progress: undefined,
        version: progress.version ?? update.version,
      })
      return
    }
    setUpdate({
      checking: true,
      message: `正在下载更新 ${Math.round(progress.percent)}%。`,
      phase: "downloading",
      progress,
    })
  })

  onMount(() => {
    const storage = platform.storage?.("opencode.global.dat")
    void Promise.resolve(storage?.getItem("haolab.startupPage"))
      .then((value) => setStartupPage(value === "classic" ? "classic" : "manager"))
      .catch(() => undefined)
    if (!platform.checkUpdate) return
    void checkUpdate()
  })

  const proxyRequest = async (init?: RequestInit) => {
    const current = server.current
    if (!current) throw new Error("当前没有可用的服务器连接")
    return fetch(`${current.http.url}/global/proxy`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(current.http.password
          ? { authorization: `Basic ${authTokenFromCredentials({ username: current.http.username, password: current.http.password })}` }
          : {}),
      },
    })
  }

  const readProxy = async () => {
    const response = await proxyRequest()
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as ProxyConfig
  }

  const updateProxy = async (input: Partial<ProxyConfig> & { apply: boolean }) => {
    const response = await proxyRequest({
      method: "PATCH",
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as ProxyConfig
  }

  createEffect(() => {
    if (selectedModel()) return
    const first = modelOptions()[0]
    if (first) setSelected(`${first.provider.id}/${first.id}`)
  })

  const selectedModel = () => modelOptions().find((model) => `${model.provider.id}/${model.id}` === selected())
  const modelState = {
    ready: models.ready,
    current: selectedModel,
    recent: () => models.recent.list().map(models.find).filter(Boolean),
    list: models.list,
    visible: models.visible,
    setVisibility: models.setVisibility,
    cycle(direction: 1 | -1) {
      const items = modelOptions()
      const current = selectedModel()
      if (!current || items.length === 0) return
      const index = items.findIndex((item) => item.provider.id === current.provider.id && item.id === current.id)
      const next = items[(index + direction + items.length) % items.length]
      if (next) this.set({ providerID: next.provider.id, modelID: next.id }, { recent: true })
    },
    set(item: { providerID: string; modelID: string } | undefined, options?: { recent?: boolean }) {
      if (!item) {
        setSelected("")
        return
      }
      setSelected(`${item.providerID}/${item.modelID}`)
      models.setVisibility(item, true)
      if (options?.recent) models.recent.push(item)
    },
    variant: {
      configured: () => undefined,
      selected: () => undefined,
      current: () => undefined,
      list: () => [],
      set() {},
      cycle() {},
    },
  }

  const ensureSession = async () => {
    const result = await sdk.client.session.get({ sessionID: managerSessionID }).catch(async () =>
      sdk.client.session.create({ id: managerSessionID, title: managerTitle, agent: "build" }),
    )
    if (result.data) setSession(result.data)
    return true
  }

  const [ready] = createResource(ensureSession)
  const [proxyConfig, { refetch: refetchProxy }] = createResource(readProxy)
  const [initialMessages] = createResource(
    () => ready(),
    async () => {
      const result = await sdk.client.session.messages({ sessionID: managerSessionID })
      return result.data ?? []
    },
    { initialValue: [] as WithParts[] },
  )
  const [initialStatus] = createResource(
    () => ready(),
    async () => {
      const result = await sdk.client.session.status()
      return result.data?.[managerSessionID] ?? ({ type: "idle" } as const)
    },
    { initialValue: { type: "idle" } as SessionStatus },
  )

  createEffect(() => {
    const config = proxyConfig()
    if (!config) return
    setProxy(config.url || defaultProxyPrefix)
    setProxyEnabled(config.enabled)
  })

  const saveProxy = async () => {
    setProxySaving(true)
    setProxyMessage("")
    try {
      const validation = validateProxyUrl(proxy())
      if (validation) {
        setProxyMessage(validation)
        return
      }
      const next = await updateProxy({ url: proxyUrl(proxy()), apply: false })
      setProxy(next.url || defaultProxyPrefix)
      setProxyEnabled(next.enabled)
      setProxyMessage("已保存代理地址。")
    } catch (err) {
      setProxyMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setProxySaving(false)
    }
  }

  const toggleProxy = async () => {
    setProxySaving(true)
    setProxyMessage("")
    try {
      const enabled = !proxyEnabled()
      if (enabled && !proxyUrl(proxy())) {
        setProxyMessage("请先填写代理端口或完整代理地址。")
        return
      }
      const validation = validateProxyUrl(proxy())
      if (validation) {
        setProxyMessage(validation)
        return
      }
      const next = await updateProxy({ enabled, url: proxyUrl(proxy()), apply: true })
      setProxy(next.url || defaultProxyPrefix)
      setProxyEnabled(next.enabled)
      setProxyMessage(next.enabled ? "代理已开启，对后续请求生效。" : "代理已关闭，对后续请求生效。")
      void refetchProxy()
    } catch (err) {
      setProxyMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setProxySaving(false)
    }
  }

  createEffect(() => {
    if (initialMessages.loading) return
    setMessages(initialMessages())
  })

  createEffect(() => {
    if (initialStatus.loading) return
    setSessionStatus(initialStatus())
  })

  const allMessages = createMemo(() => messages().map((message) => message.info))
  const userMessages = createMemo(() => allMessages().filter((message): message is UserMessage => message.role === "user"))
  const parts = createMemo(() => Object.fromEntries(messages().map((message) => [message.info.id, message.parts])))
  const retryStatus = createMemo(() => {
    const status = sessionStatus()
    if (status.type !== "retry") return
    return status
  })
  const updateProgressPercent = createMemo(() => Math.max(0, Math.min(100, update.progress?.percent ?? 0)))
  const updateStatusLabel = createMemo(() => {
    if (update.phase === "checking") return "正在检查"
    if (update.phase === "downloading") return "正在下载"
    if (update.phase === "ready") return "更新已准备好"
    if (update.phase === "latest") return "已是最新"
    if (update.phase === "error") return "检查失败"
    if (update.phase === "installing") return "正在安装"
    if (update.phase === "unsupported") return "不可用"
    return "待检查"
  })
  const data = createMemo(() => ({
    session: session() ? [session()!] : [],
    session_status: {
      [managerSessionID]: sessionStatus(),
    },
    session_diff: {},
    message: {
      [managerSessionID]: allMessages(),
    },
    part: parts(),
  }))

  const upsertMessage = (message: Message) => {
    if (message.sessionID !== managerSessionID) return
    setMessages((current) => {
      const index = current.findIndex((item) => item.info.id === message.id)
      if (index >= 0) {
        const next = current.slice()
        next[index] = { ...next[index], info: message }
        return sortMessages(next)
      }
      return sortMessages([...current, { info: message, parts: [] }])
    })
  }

  const removeMessage = (messageID: string) => {
    setMessages((current) => current.filter((message) => message.info.id !== messageID))
  }

  const upsertPart = (part: Part) => {
    setMessages((current) =>
      current.map((message) => {
        if (message.info.id !== part.messageID) return message
        const index = message.parts.findIndex((item) => item.id === part.id)
        if (index >= 0) {
          const parts = message.parts.slice()
          parts[index] = part
          return { ...message, parts: sortByID(parts) }
        }
        return { ...message, parts: sortByID([...message.parts, part]) }
      }),
    )
  }

  const removePart = (messageID: string, partID: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.info.id === messageID ? { ...message, parts: message.parts.filter((part) => part.id !== partID) } : message,
      ),
    )
  }

  const appendPartDelta = (messageID: string, partID: string, field: string, delta: string) => {
    if (field !== "text") return
    setMessages((current) =>
      current.map((message) => {
        if (message.info.id !== messageID) return message
        return {
          ...message,
          parts: message.parts.map((part) => {
            if (part.id !== partID || part.type !== "text") return part
            return { ...part, text: part.text + delta }
          }),
        }
      }),
    )
  }

  const applyEvent = (event: Event) => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (event.properties.info.id === managerSessionID) setSession(event.properties.info)
        return
      case "session.status":
        if (event.properties.sessionID === managerSessionID) setSessionStatus(event.properties.status)
        return
      case "message.updated":
        upsertMessage(event.properties.info)
        return
      case "message.removed":
        if (event.properties.sessionID === managerSessionID) removeMessage(event.properties.messageID)
        return
      case "message.part.updated":
        if (event.properties.sessionID === managerSessionID) upsertPart(event.properties.part)
        return
      case "message.part.removed":
        if (event.properties.sessionID === managerSessionID) removePart(event.properties.messageID, event.properties.partID)
        return
      case "message.part.delta":
        if (event.properties.sessionID === managerSessionID) {
          appendPartDelta(event.properties.messageID, event.properties.partID, event.properties.field, event.properties.delta)
        }
        return
    }
  }

  const unsubscribe = sdk.event.listen((event) => applyEvent(event.details))
  void sdk.event.start()
  onCleanup(() => {
    unsubscribe()
    unsubscribeUpdateProgress?.()
  })

  const abortRetry = async () => {
    await sdk.client.session.abort({ sessionID: managerSessionID })
    setSessionStatus({ type: "idle" })
  }

  const submit = async () => {
    const text = draft().trim()
    const model = selectedModel()
    if (!text || !model || sending()) return
    if (retryStatus()) {
      setError("当前会话正在等待上一次失败请求的重试。请先取消重试，再用新模型发送。")
      return
    }
    const messageID = Identifier.ascending("message")
    const partID = Identifier.ascending("part")
    setSending(true)
    setError("")
    setDraft("")
    upsertMessage({
      id: messageID,
      sessionID: managerSessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: {
        providerID: model.provider.id,
        modelID: model.id,
      },
    })
    upsertPart({
      id: partID,
      sessionID: managerSessionID,
      messageID,
      type: "text",
      text,
    })
    try {
      await sdk.client.session.promptAsync({
        sessionID: managerSessionID,
        agent: "build",
        messageID,
        model: {
          providerID: model.provider.id,
          modelID: model.id,
        },
        parts: [
          {
            id: partID,
            type: "text",
            text,
          },
        ],
      })
    } catch (err) {
      removeMessage(messageID)
      setDraft(text)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <main class="h-dvh bg-v2-background-bg-base text-v2-text-text-base grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] overflow-hidden">
      <section class="min-h-0 min-w-0 flex flex-col bg-v2-background-bg-base">
        <div class="flex-1 overflow-y-auto px-6 py-6">
          <Show when={ready()} fallback={<div class="h-full grid place-items-center text-14-regular text-v2-text-text-muted">正在加载管理会话...</div>}>
            <div class="mx-auto max-w-3xl min-h-full flex flex-col justify-end">
              <Show
                when={userMessages().length > 0}
                fallback={<div class="text-center text-14-regular text-v2-text-text-muted pb-12">开始和管理 agent 对话。</div>}
              >
                <DataProvider data={data()} directory="">
                  <div class="flex flex-col gap-12 items-start justify-start py-4">
                    <For each={userMessages()}>
                      {(message) => (
                        <SessionTurn
                          sessionID={managerSessionID}
                          messageID={message.id}
                          messages={allMessages()}
                          status={sessionStatus()}
                          classes={{
                            root: "min-w-0 w-full relative",
                            content: "flex flex-col justify-between !overflow-visible",
                            container: "px-1 sm:px-3",
                          }}
                        />
                      )}
                    </For>
                  </div>
                </DataProvider>
              </Show>
            </div>
          </Show>
        </div>
        <div class="shrink-0 px-6 pb-6 pt-3 border-t border-v2-border-border-base bg-v2-background-bg-base">
          <div class="mx-auto max-w-3xl flex flex-col gap-3">
            <Show when={error()}>
              <div class="rounded-lg border border-danger-base/30 bg-danger-base/5 px-3 py-2 text-12-regular text-danger-base">
                {error()}
              </div>
            </Show>
            <Show when={retryStatus()}>
              {(status) => (
                <div class="rounded-lg border border-warning-base/30 bg-warning-base/5 px-3 py-2 text-12-regular text-warning-base leading-5">
                  <div>{status().message}</div>
                  <Show when={status().action}>
                    {(action) => (
                      <div class="mt-1 text-v2-text-text-muted">
                        {action().message}{" "}
                        <Show when={action().link}>
                          {(link) => (
                            <a class="underline text-warning-base" href={link()} target="_blank" rel="noreferrer">
                              {action().label}
                            </a>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Button variant="ghost" size="small" class="mt-2" onClick={() => void abortRetry()}>
                    取消重试
                  </Button>
                </div>
              )}
            </Show>
            <DockShellForm
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
              classList={{
                "group/prompt-input focus-within:shadow-xs-border": true,
              }}
            >
              <div class="relative">
                <textarea
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key !== "Enter" || event.shiftKey) return
                    event.preventDefault()
                    void submit()
                  }}
                  placeholder="输入要管理的事项..."
                  disabled={!ready() || sending()}
                  rows={3}
                  class="select-text w-full max-h-[240px] resize-none bg-transparent pl-3 pr-13 pt-2 pb-14 text-14-regular leading-6 text-v2-text-text-base placeholder:text-v2-text-text-faint outline-none disabled:opacity-50"
                />
                <div
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-14"
                  style={{
                    background:
                      "linear-gradient(to top, var(--v2-background-bg-base) calc(100% - 20px), transparent)",
                  }}
                />
                <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
                  <div class="flex items-center gap-1 pointer-events-auto">
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!draft().trim() || !selectedModel() || sending()}
                      icon="arrow-up"
                      variant="primary"
                      class="size-8"
                      aria-label={sending() ? "发送中" : "发送"}
                    />
                  </div>
                </div>
                <div class="pointer-events-none absolute bottom-2 left-3 text-12-regular text-v2-text-text-muted">
                  Enter 发送，Shift+Enter 换行
                </div>
              </div>
            </DockShellForm>
            <DockTray attach="top">
              <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
                <ModelSelectorPopover
                  model={modelState}
                  triggerAs={Button}
                  triggerProps={{
                    variant: "ghost",
                    size: "normal",
                    class: "min-w-0 max-w-[320px] text-13-regular text-v2-text-text-base group",
                    "data-action": "prompt-model",
                  }}
                >
                  <Show when={selectedModel()?.provider.id}>
                    <ProviderIcon
                      id={selectedModel()?.provider.id ?? ""}
                      class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                      style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                    />
                  </Show>
                  <span class="truncate">{selectedModel()?.name ?? "选择模型"}</span>
                  <Icon name="chevron-down" size="small" class="shrink-0" />
                </ModelSelectorPopover>
              </div>
            </DockTray>
          </div>
        </div>
      </section>
      <aside class="border-t lg:border-t-0 lg:border-l border-v2-border-border-base bg-v2-background-bg-deep p-4 overflow-y-auto">
        <div class="flex flex-col gap-4">
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="text-12-medium text-v2-text-text-base mb-2">代理设置</div>
            <TextField
              value={proxy()}
              onChange={setProxy}
              placeholder={`${defaultProxyPrefix}7890`}
            />
            <div class="mt-3 flex items-center gap-2">
              <Button variant="ghost" size="small" disabled={proxySaving()} onClick={() => void saveProxy()}>
                保存
              </Button>
              <Button variant={proxyEnabled() ? "secondary" : "primary"} size="small" disabled={proxySaving()} onClick={() => void toggleProxy()}>
                {proxyEnabled() ? "关闭代理" : "开启代理"}
              </Button>
            </div>
            <p class="mt-2 text-12-regular text-v2-text-text-muted leading-5">
              配置保存到本机 proxy.json。开关代理会立即通知 sidecar，对后续新请求生效。
            </p>
            <Show when={proxyMessage()}>
              <p class="mt-2 text-12-regular text-v2-text-text-muted leading-5">{proxyMessage()}</p>
            </Show>
          </section>
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="text-12-medium text-v2-text-text-base mb-2">Provider 配置</div>
            <p class="text-12-regular text-v2-text-text-muted leading-5">使用现有 Provider 配置流程连接模型服务。</p>
            <Show
              when={providers.connected().length > 0}
              fallback={<p class="mt-3 text-12-regular text-v2-text-text-muted leading-5">还没有已连接的 Provider。</p>}
            >
              <div class="mt-3 flex flex-col gap-2">
                <For each={providers.connected()}>
                  {(provider) => (
                    <div class="flex items-center gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep px-2.5 py-2">
                      <ProviderIcon id={provider.id} class="size-4 shrink-0" />
                      <div class="min-w-0 truncate text-12-regular text-v2-text-text-base">{provider.name}</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Button variant="primary" size="small" class="mt-3" onClick={openProviderConfig}>
              配置 Provider
            </Button>
          </section>
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="flex items-start gap-3">
              <div
                classList={{
                  "size-8 rounded-xl grid place-items-center shrink-0": true,
                  "bg-icon-success-base/10 text-icon-success-base": update.phase === "ready" || update.phase === "latest",
                  "bg-icon-warning-base/10 text-icon-warning-base": update.phase === "downloading" || update.phase === "checking" || update.phase === "installing",
                  "bg-danger-base/10 text-danger-base": update.phase === "error" || update.phase === "unsupported",
                  "bg-v2-background-bg-deep text-v2-text-text-muted": update.phase === "idle",
                }}
              >
                <Icon
                  name={update.phase === "ready" || update.phase === "latest" ? "circle-check" : update.phase === "error" ? "warning" : "download"}
                  size="small"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-12-medium text-v2-text-text-base">桌面端更新</div>
                  <div class="shrink-0 rounded-full border border-v2-border-border-base bg-v2-background-bg-deep px-2 py-0.5 text-11-medium text-v2-text-text-muted">
                    {updateStatusLabel()}
                  </div>
                </div>
                <p class="mt-1 text-12-regular text-v2-text-text-muted leading-5">
                  当前版本{platform.version ? ` ${platform.version}` : "未知"}。检查新版本并下载，完成后可重启安装。
                </p>
              </div>
            </div>
            <Show when={update.phase === "downloading" && update.progress}>
              <div class="mt-3">
                <div class="h-1.5 overflow-hidden rounded-full bg-v2-background-bg-deep">
                  <div
                    class="h-full rounded-full bg-icon-warning-base transition-[width] duration-200"
                    style={{ width: `${updateProgressPercent()}%` }}
                  />
                </div>
                <div class="mt-2 flex items-center justify-between gap-2 text-11-regular text-v2-text-text-muted">
                  <span>{Math.round(updateProgressPercent())}%</span>
                  <span class="truncate">
                    {formatBytes(update.progress?.transferred)} / {formatBytes(update.progress?.total)}
                    <Show when={formatSpeed(update.progress?.bytesPerSecond)}> · {formatSpeed(update.progress?.bytesPerSecond)}</Show>
                  </span>
                </div>
              </div>
            </Show>
            <Show when={update.message}>
              <p
                classList={{
                  "mt-3 rounded-lg border px-3 py-2 text-12-regular leading-5": true,
                  "border-danger-base/30 bg-danger-base/5 text-danger-base": update.phase === "error" || update.phase === "unsupported",
                  "border-icon-success-base/30 bg-icon-success-base/5 text-v2-text-text-base": update.phase === "ready" || update.phase === "latest",
                  "border-v2-border-border-base bg-v2-background-bg-deep text-v2-text-text-muted": update.phase !== "error" && update.phase !== "unsupported" && update.phase !== "ready" && update.phase !== "latest",
                }}
              >
                {update.message}
              </p>
            </Show>
            <div class="mt-3 flex items-center gap-2">
              <Show
                when={update.available && platform.updateAndRestart}
                fallback={
                  <Button variant="secondary" size="small" disabled={update.checking || update.installing} onClick={() => void checkUpdate()}>
                    {update.checking ? "正在准备..." : update.phase === "error" ? "重试" : "检查并下载更新"}
                  </Button>
                }
              >
                <Button variant="primary" size="small" disabled={update.installing} onClick={() => void installUpdate()}>
                  {update.installing ? "正在安装..." : "重启并安装"}
                </Button>
              </Show>
              <Show when={update.available && !update.installing}>
                <Button variant="ghost" size="small" disabled={update.checking} onClick={() => void checkUpdate()}>
                  重新检查
                </Button>
              </Show>
              <Show when={update.releaseNotes || update.releaseName || update.releaseDate}>
                <Button variant="ghost" size="small" onClick={showUpdateNotes}>
                  查看更新内容
                </Button>
              </Show>
            </div>
          </section>
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="text-12-medium text-v2-text-text-base mb-2">配置完毕</div>
            <p class="text-12-regular text-v2-text-text-muted leading-5">代理和 Provider 配置完成后，进入正式页面继续使用。</p>
            <Button
              variant="primary"
              size="large"
              class="mt-3 w-full"
              onClick={() => navigate("/classic-manager")}
            >
              进入正式页面
            </Button>
          </section>
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="text-12-medium text-v2-text-text-base mb-2">启动页面</div>
            <p class="text-12-regular text-v2-text-text-muted leading-5">选择下次启动 HaoLab OpenCode 时默认进入的页面。</p>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <Button
                variant={startupPage() === "manager" ? "primary" : "secondary"}
                size="small"
                disabled={startupSaving()}
                onClick={() => void saveStartupPage("manager")}
              >
                管理页面
              </Button>
              <Button
                variant={startupPage() === "classic" ? "primary" : "secondary"}
                size="small"
                disabled={startupSaving()}
                onClick={() => void saveStartupPage("classic")}
              >
                正式页面
              </Button>
            </div>
            <Show when={startupMessage()}>
              <p class="mt-2 text-12-regular text-v2-text-text-muted leading-5">{startupMessage()}</p>
            </Show>
          </section>
          <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
            <div class="text-12-medium text-v2-text-text-base mb-2">数据存储</div>
            <p class="text-12-regular text-v2-text-text-muted leading-5">
              修改 OpenCode 全局数据目录。迁移会复制默认数据文件夹，并自动重启后从新位置读取。
            </p>
            <Show
              when={haolabDataLocation()}
              fallback={<p class="mt-3 text-12-regular text-v2-text-text-muted leading-5">当前环境不支持数据存储位置管理。</p>}
            >
              {(location) => (
                <div class="mt-3 space-y-2 rounded-xl border border-v2-border-border-base bg-v2-background-bg-deep p-3">
                  <div>
                    <div class="text-11-medium text-v2-text-text-muted">当前数据目录</div>
                    <div class="mt-1 break-all text-12-regular text-v2-text-text-base">{location().activePath}</div>
                  </div>
                  <div>
                    <div class="text-11-medium text-v2-text-text-muted">默认数据目录</div>
                    <div class="mt-1 break-all text-12-regular text-v2-text-text-base">{location().defaultPath}</div>
                  </div>
                </div>
              )}
            </Show>
            <div class="mt-3 grid grid-cols-1 gap-2">
              <Button
                variant="primary"
                size="small"
                disabled={storage.migrating || storage.deleting || !platform.migrateHaolabData || !platform.selectHaolabDataDirectory}
                onClick={() => void migrateHaolabData()}
              >
                {storage.migrating ? "正在迁移..." : "修改数据存储路径"}
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={storage.migrating || storage.deleting || !platform.deleteDefaultHaolabData || !haolabDataLocation()?.configured}
                onClick={() => void deleteDefaultHaolabData()}
              >
                {storage.deleting ? "正在删除..." : "删除原文件"}
              </Button>
            </div>
            <Show when={storage.message}>
              <p class="mt-2 text-12-regular text-v2-text-text-muted leading-5 break-words">{storage.message}</p>
            </Show>
          </section>
        </div>
      </aside>
    </main>
  )
}
