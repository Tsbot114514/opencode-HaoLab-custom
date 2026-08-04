import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useNavigate } from "@solidjs/router"
import { createResource, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"

type Experiment = {
  id: string
  name: string
  entry: string
  agent?: string
}

type ExperimentManifest = {
  active: string
  experiments: Experiment[]
}

export default function ExperimentPage() {
  const navigate = useNavigate()
  const sdk = useSDK()
  const models = useModels()
  const [manifest, { refetch }] = createResource(loadManifest)
  const [frame, setFrame] = createStore({ loaded: false })
  const [agent, setAgent] = createStore({ busy: false, sessionID: "" })
  const experiment = () => manifest()?.experiments.find((item) => item.id === manifest()?.active)
  let experimentFrame: HTMLIFrameElement | undefined

  const currentModel = () =>
    models.recent.list().map(models.find).find(Boolean) ??
    models
      .list()
      .find((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))

  const sendToExperiment = (message: Record<string, unknown>) => experimentFrame?.contentWindow?.postMessage(message, "*")

  const sendAgentMessage = async (text: string) => {
    const current = experiment()
    const model = currentModel()
    if (!current || !model) throw new Error("当前没有可用模型，请先在 HaoLab 中配置 Provider。")

    const created = agent.sessionID
      ? undefined
      : await sdk.client.session.create({ title: `实验对话：${current.name}`, agent: current.agent ?? "build" })
    const sessionID = agent.sessionID || created?.data?.id
    if (!sessionID) throw new Error("无法创建实验对话 Session。")
    if (!agent.sessionID) setAgent("sessionID", sessionID)
    const response = await sdk.client.session.prompt({
      sessionID,
      agent: current.agent ?? "build",
      model: { providerID: model.provider.id, modelID: model.id },
      tools: {
        apply_patch: false,
        bash: false,
        edit: false,
        glob: false,
        grep: false,
        question: false,
        read: false,
        skill: false,
        task: false,
        todowrite: false,
        webfetch: false,
        write: false,
      },
      system: "You are speaking with a participant inside a psychology experiment page. Answer conversationally and do not use tools, modify files, reveal credentials, or claim to have performed actions.",
      parts: [{ type: "text", text }],
    })
    if (!response.data) throw new Error("Agent 没有返回响应数据。")
    return response.data.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== experimentFrame?.contentWindow) return
    if (!event.data || typeof event.data !== "object") return
    const message = event.data as Record<string, unknown>
    if (message.type === "haolab.agent.reset") {
      if (agent.busy) return
      setAgent("sessionID", "")
      sendToExperiment({ type: "haolab.agent.reset.complete" })
      return
    }
    if (message.type !== "haolab.agent.send") return
    if (typeof message.requestId !== "string" || typeof message.text !== "string") return
    const text = message.text.trim()
    if (!text || text.length > 8_000) {
      sendToExperiment({ type: "haolab.agent.error", requestId: message.requestId, message: "消息不能为空且不能超过 8000 个字符。" })
      return
    }
    if (agent.busy) {
      sendToExperiment({ type: "haolab.agent.error", requestId: message.requestId, message: "Agent 正在回复上一条消息。" })
      return
    }
    setAgent("busy", true)
    void sendAgentMessage(text)
      .then((reply) => {
        sendToExperiment({ type: "haolab.agent.response", requestId: message.requestId, text: reply || "Agent 没有返回文本。" })
      })
      .catch((error: unknown) => {
        sendToExperiment({
          type: "haolab.agent.error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setAgent("busy", false))
  }

  onMount(() => window.addEventListener("message", onMessage))
  onCleanup(() => {
    window.removeEventListener("message", onMessage)
    if (agent.busy && agent.sessionID) void sdk.client.session.abort({ sessionID: agent.sessionID })
  })

  return (
    <div class="flex h-dvh min-h-0 w-screen flex-col bg-background-base text-text-base">
      <header class="flex h-12 shrink-0 items-center justify-between border-b border-border-weak-base px-4">
        <div class="flex min-w-0 items-center gap-2">
          <Icon name="task" class="size-4 shrink-0 text-icon-base" />
          <span class="truncate text-13-medium text-text-strong">{experiment()?.name ?? "实验页面"}</span>
        </div>
        <DropdownMenu>
          <DropdownMenu.Trigger as={Button} variant="ghost" size="small">
            切换页面
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={() => navigate("/classic-manager")}>
                <DropdownMenu.ItemLabel>正式页面</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => navigate("/manager")}>
                <DropdownMenu.ItemLabel>管理页面</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </header>

      <main class="relative min-h-0 flex-1">
        <Suspense fallback={<Status title="正在读取实验配置" description="请稍候。" />}>
          <Show
            when={!manifest.error}
            fallback={
              <Status
                title="无法读取实验配置"
                description={manifest.error instanceof Error ? manifest.error.message : "请检查 experiments/manifest.json。"}
                action="重新加载"
                onAction={() => void refetch()}
              />
            }
          >
            <Show
              when={experiment()}
              fallback={
                <Status
                  title="尚未配置实验"
                  description="请让 Agent 按 experiments/README.md 添加实验包，并在 manifest.json 中设置 active。"
                />
              }
            >
              {(current) => (
                <>
                  <Show when={!frame.loaded}>
                    <Status title={`正在加载 ${current().name}`} description="实验准备完成后将自动显示。" />
                  </Show>
                  <iframe
                    ref={experimentFrame}
                    src={experimentUrl(current())}
                    title={current().name}
                    class="size-full border-0 bg-white"
                    classList={{ invisible: !frame.loaded }}
                    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                    onLoad={() => {
                      setFrame("loaded", true)
                      const model = currentModel()
                      sendToExperiment({
                        type: "haolab.agent.ready",
                        agent: current().agent ?? "build",
                        model: model ? `${model.provider.name} / ${model.name}` : "未配置模型",
                      })
                    }}
                  />
                </>
              )}
            </Show>
          </Show>
        </Suspense>
      </main>
    </div>
  )
}

function Status(props: { title: string; description: string; action?: string; onAction?: () => void }) {
  return (
    <div class="absolute inset-0 flex items-center justify-center p-6">
      <div class="flex max-w-md flex-col items-center text-center">
        <div class="mb-4 grid size-10 place-items-center rounded-xl border border-border-weak-base bg-surface-base">
          <Icon name="task" class="size-5 text-icon-base" />
        </div>
        <h1 class="text-16-medium text-text-strong">{props.title}</h1>
        <p class="mt-2 text-13-regular leading-6 text-text-weak">{props.description}</p>
        <Show when={props.action}>
          <Button class="mt-4" size="small" variant="secondary" onClick={props.onAction}>
            {props.action}
          </Button>
        </Show>
      </div>
    </div>
  )
}

async function loadManifest() {
  const response = await fetch("/experiments/manifest.json", { cache: "no-store" })
  if (!response.ok) throw new Error(`读取实验配置失败（HTTP ${response.status}）。`)
  return parseManifest(await response.json())
}

function parseManifest(value: unknown): ExperimentManifest {
  if (!value || typeof value !== "object") throw new Error("实验配置必须是 JSON 对象。")
  const manifest = value as Record<string, unknown>
  if (typeof manifest.active !== "string") throw new Error("实验配置缺少 active 字段。")
  if (!Array.isArray(manifest.experiments)) throw new Error("实验配置缺少 experiments 数组。")

  const experiments = manifest.experiments.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`experiments[${index}] 必须是对象。`)
    const experiment = item as Record<string, unknown>
    if (typeof experiment.id !== "string" || !experiment.id) throw new Error(`experiments[${index}] 缺少 id。`)
    if (typeof experiment.name !== "string" || !experiment.name) throw new Error(`experiments[${index}] 缺少 name。`)
    if (typeof experiment.entry !== "string" || !safeEntry(experiment.entry)) {
      throw new Error(`experiments[${index}] 的 entry 必须是 experiments 目录内的相对路径。`)
    }
    if (experiment.agent !== undefined && typeof experiment.agent !== "string") {
      throw new Error(`experiments[${index}] 的 agent 必须是字符串。`)
    }
    return { id: experiment.id, name: experiment.name, entry: experiment.entry, agent: experiment.agent }
  })

  if (manifest.active && !experiments.some((item) => item.id === manifest.active)) {
    throw new Error(`找不到 active 指定的实验：${manifest.active}。`)
  }
  return { active: manifest.active, experiments }
}

function safeEntry(entry: string) {
  if (!entry || entry.startsWith("/") || entry.startsWith("\\")) return false
  if (/^[a-z][a-z\d+.-]*:/i.test(entry)) return false
  return !entry.split(/[\\/]/).includes("..")
}

function experimentUrl(experiment: Experiment) {
  return `/experiments/${experiment.entry.replaceAll("\\", "/")}`
}
