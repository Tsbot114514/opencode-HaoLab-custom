import type { Event, Message, Part, Session, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DataProvider } from "@opencode-ai/ui/context"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { TextField } from "@opencode-ai/ui/text-field"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useGlobalSDK } from "@/context/global-sdk"
import { useModels } from "@/context/models"
import { useServer } from "@/context/server"
import { Identifier } from "@/utils/id"
import { authTokenFromCredentials } from "@/utils/server"

const managerSessionID = "ses_manager_agent"
const managerTitle = "管理agent"

type ProxyConfig = {
  enabled: boolean
  url: string
}

type WithParts = {
  info: Message
  parts: Part[]
}

function sortByID<T extends { id: string }>(items: T[]) {
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function sortMessages(items: WithParts[]) {
  return items.sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
}

export default function ManagerPage() {
  const sdk = useGlobalSDK()
  const models = useModels()
  const server = useServer()
  const navigate = useNavigate()
  const [proxy, setProxy] = createSignal("")
  const [proxyEnabled, setProxyEnabled] = createSignal(false)
  const [proxyMessage, setProxyMessage] = createSignal("")
  const [proxySaving, setProxySaving] = createSignal(false)
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
    setProxy(config.url)
    setProxyEnabled(config.enabled)
  })

  const saveProxy = async () => {
    setProxySaving(true)
    setProxyMessage("")
    try {
      const next = await updateProxy({ url: proxy(), apply: false })
      setProxy(next.url)
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
      if (enabled && !proxy().trim()) {
        setProxyMessage("请先填写代理地址。")
        return
      }
      const next = await updateProxy({ enabled, url: proxy(), apply: true })
      setProxy(next.url)
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
  onCleanup(unsubscribe)

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
    <main class="h-dvh bg-background-base text-text-base grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] overflow-hidden">
      <section class="min-h-0 min-w-0 flex flex-col bg-background-base">
        <div class="flex-1 overflow-y-auto px-6 py-6">
          <Show when={ready()} fallback={<div class="h-full grid place-items-center text-14-regular text-text-weak">正在加载管理会话...</div>}>
            <div class="mx-auto max-w-3xl min-h-full flex flex-col justify-end">
              <Show
                when={userMessages().length > 0}
                fallback={<div class="text-center text-14-regular text-text-weak pb-12">开始和管理 agent 对话。</div>}
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
        <div class="shrink-0 px-6 pb-6 pt-3 border-t border-border-weak-base bg-background-base/95">
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
                      <div class="mt-1 text-text-weak">
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
                  class="select-text w-full max-h-[240px] resize-none bg-transparent pl-3 pr-13 pt-2 pb-14 text-14-regular leading-6 text-text-strong placeholder:text-text-weak outline-none disabled:opacity-50"
                />
                <div
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-14"
                  style={{
                    background:
                      "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
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
                <div class="pointer-events-none absolute bottom-2 left-3 text-12-regular text-text-weak">
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
                    class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
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
      <aside class="border-t lg:border-t-0 lg:border-l border-border-weak-base bg-surface-base/60 p-4 overflow-y-auto">
        <div class="flex flex-col gap-4">
          <Button variant="ghost" size="large" onClick={() => navigate("/classic")}>切换到经典页面</Button>
          <section class="rounded-2xl border border-border-weak-base bg-background-base p-4 shadow-sm">
            <div class="text-12-medium text-text-strong mb-2">代理设置</div>
            <TextField
              value={proxy()}
              onChange={setProxy}
              placeholder="http://127.0.0.1:7890"
            />
            <div class="mt-3 flex items-center gap-2">
              <Button variant="ghost" size="small" disabled={proxySaving()} onClick={() => void saveProxy()}>
                保存
              </Button>
              <Button variant={proxyEnabled() ? "secondary" : "primary"} size="small" disabled={proxySaving()} onClick={() => void toggleProxy()}>
                {proxyEnabled() ? "关闭代理" : "开启代理"}
              </Button>
            </div>
            <p class="mt-2 text-12-regular text-text-weak leading-5">
              配置保存到本机 proxy.json。开关代理会立即通知 sidecar，对后续新请求生效。
            </p>
            <Show when={proxyMessage()}>
              <p class="mt-2 text-12-regular text-text-weak leading-5">{proxyMessage()}</p>
            </Show>
          </section>
          <section class="rounded-2xl border border-border-weak-base bg-background-base p-4 shadow-sm">
            <div class="text-12-medium text-text-strong mb-2">Provider 状态</div>
            <p class="text-12-regular text-text-weak leading-5">后续复用 classic provider/model 连接状态。</p>
          </section>
          <section class="rounded-2xl border border-border-weak-base bg-background-base p-4 shadow-sm">
            <div class="text-12-medium text-text-strong mb-2">Session 信息</div>
            <div class="text-12-regular text-text-weak leading-5 break-all">{managerSessionID}</div>
          </section>
        </div>
      </aside>
    </main>
  )
}
