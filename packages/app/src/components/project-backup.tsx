import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import {
  compareProjectSnapshots,
  compareProjectTime,
  formatProjectTime,
  inspectProject,
  isAbsoluteProjectPath,
  transferProject,
  type ProjectPreview,
} from "@/utils/project-backup"

const comparisons = {
  package: "迁移包较新",
  local: "本地较新",
  same: "时间相同（不代表内容相同）",
  mixed: "文件与会话的新旧方向不同，请分别核对",
  unknown: "时间信息不足，无法判断整体新旧",
}

export function ProjectBackup() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const navigate = useNavigate()
  const context = createMemo(() => JSON.stringify([server.key, server.current?.http]))
  const [state, setState] = createStore({
    mode: undefined as "backup" | "restore" | undefined,
    source: "",
    path: "",
    destination: "",
    manager: "",
    confirmed: false,
    overwrite: false,
    busy: false,
    error: "",
    preview: undefined as ProjectPreview | undefined,
    candidates: [] as string[],
    result: undefined as Awaited<ReturnType<typeof transferProject>> | undefined,
  })
  createEffect(
    on(
      context,
      () =>
        setState({
          source: "",
          path: "",
          destination: "",
          manager: "",
          preview: undefined,
          candidates: [],
          confirmed: false,
          overwrite: false,
          result: undefined,
          error: "服务器已更改，请重新选择路径并读取迁移包。",
        }),
      { defer: true },
    ),
  )
  const close = () => {
    if (!state.busy) setState("mode", undefined)
  }
  const open = (mode: "backup" | "restore") => {
    if (state.busy) return
    setState({
      mode,
      source: server.projects.last() ?? "",
      path: "",
      destination: "",
      manager: "",
      confirmed: false,
      overwrite: false,
      error: "",
      preview: undefined,
      candidates: [],
      result: undefined,
    })
  }
  const change = (field: "source" | "path" | "destination", value: string) => {
    setState(field, value)
    setState({ preview: undefined, confirmed: false, overwrite: false, error: "", result: undefined })
    if (field === "path") setState("candidates", [])
  }
  const validZip = () => isAbsoluteProjectPath(state.path) && /\.zip$/i.test(state.path)
  const canRead = () => validZip() && (!state.destination || isAbsoluteProjectPath(state.destination))
  const canApply = () =>
    !state.busy &&
    state.confirmed &&
    (state.mode === "backup"
      ? validZip() && isAbsoluteProjectPath(state.source)
      : !!state.preview?.previewToken &&
        !!state.preview.directory &&
        state.preview.action !== "select-target" &&
        (state.preview.action !== "replace" || state.overwrite))

  async function pick(field: "source" | "path" | "destination") {
    if (state.busy || !server.isLocal()) return
    const scope = context()
    setState({ busy: true, error: "" })
    try {
      const result =
        field !== "path"
          ? await platform.openDirectoryPickerDialog?.({
              title: field === "source" ? "选择源项目" : "选择目标项目目录",
              multiple: false,
            })
          : state.mode === "backup"
            ? await platform.saveFilePickerDialog?.({ title: "导出项目迁移包", defaultPath: "project-migration.zip" })
            : await platform.openFilePickerDialog?.({
                title: "选择可信的项目迁移包",
                multiple: false,
                extensions: ["zip"],
              })
      const path = Array.isArray(result) ? result[0] : result
      if (scope === context() && path) change(field, path)
    } catch (error) {
      if (scope === context()) setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("busy", false)
    }
  }

  async function readPackage() {
    if (state.busy || !canRead() || !server.current) return
    const scope = context()
    const current = server.current
    setState({ busy: true, error: "", preview: undefined, confirmed: false, overwrite: false, result: undefined })
    try {
      const manager = (await sdk.createClient({}).path.get()).data?.directory
      if (scope !== context()) return
      if (!manager) throw new Error("无法获取管理页面当前目录。")
      const preview = await inspectProject({
        server: current.http,
        fetch: platform.fetch,
        directory: manager,
        path: state.path,
        destination: state.destination || undefined,
      })
      if (scope !== context()) return
      setState({ preview, manager, candidates: preview.candidates })
    } catch (error) {
      if (scope === context()) setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("busy", false)
    }
  }

  async function apply() {
    if (!canApply() || !state.mode || !server.current) return
    const scope = context()
    const current = server.current
    const preview = state.preview
    setState({ busy: true, error: "", result: undefined })
    try {
      const result =
        state.mode === "backup"
          ? await transferProject({
              server: current.http,
              fetch: platform.fetch,
              mode: "backup",
              directory: state.source,
              path: state.path,
            })
          : preview?.previewToken && preview.directory
            ? await transferProject({
                server: current.http,
                fetch: platform.fetch,
                mode: "restore",
                directory: state.manager,
                path: state.path,
                destination: preview.directory,
                previewToken: preview.previewToken,
                overwrite: preview.action === "replace" && state.overwrite,
              })
            : undefined
      if (scope === context()) setState({ result, preview: undefined, confirmed: false, overwrite: false })
    } catch (error) {
      if (scope !== context()) return
      // Any failed apply invalidates consent and the token, including stale previews and uncertain network outcomes.
      setState({
        preview: undefined,
        confirmed: false,
        overwrite: false,
        error: `${error instanceof Error ? error.message : String(error)}${state.mode === "restore" ? " 请重新读取迁移包、核对当前状态并确认后再加载。" : ""}`,
      })
    } finally {
      setState("busy", false)
    }
  }

  return (
    <>
      <section class="rounded-2xl border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-sm">
        <div class="mb-2 text-12-medium text-v2-text-text-base">项目迁移包</div>
        <p class="text-12-regular leading-5 text-v2-text-text-muted">
          A 设备导出项目，B 设备读取并识别已有项目，核对文件与会话时间后加载。独立于整个应用的数据目录迁移。
        </p>
        <div class="mt-3 grid grid-cols-1 gap-2">
          <Button variant="primary" size="small" disabled={state.busy} onClick={() => open("backup")}>
            导出迁移包
          </Button>
          <Button variant="secondary" size="small" disabled={state.busy} onClick={() => open("restore")}>
            加载迁移包
          </Button>
        </div>
      </section>
      <Kobalte
        open={!!state.mode}
        onOpenChange={(value) => {
          if (!value) close()
        }}
      >
        <Kobalte.Portal>
          <Kobalte.Overlay data-component="dialog-overlay" />
          <Dialog
            title={state.mode === "backup" ? "导出项目迁移包" : "读取并加载项目迁移包"}
            fit
            action={
              <Button variant="ghost" size="small" disabled={state.busy} onClick={close}>
                关闭
              </Button>
            }
          >
            <div class="max-h-[70vh] w-[min(calc(100vw-48px),720px)] space-y-4 overflow-y-auto pb-1 text-12-regular leading-5 text-v2-text-text-muted">
              <p>
                迁移包可保存到云同步文件夹、共享磁盘，或手动传到另一台设备。请等待同步完成后再读取；此功能不连接云服务商，不自动同步或合并。
              </p>
              <p class="break-words">
                {server.isLocal()
                  ? "所有路径均为当前服务器上的绝对路径，可选择文件或手动输入。"
                  : "远程服务器：所有路径均指服务器端绝对路径，不是本机路径；此处不会上传或下载文件。"}
              </p>
              <Show when={!state.result}>
                <Show when={state.mode === "backup" && server.projects.list().length > 0}>
                  <label class="flex flex-col gap-2">
                    已知项目（当前服务器）
                    <select
                      class="w-full min-w-0 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base p-2"
                      disabled={state.busy}
                      value={state.source}
                      onChange={(event) => change("source", event.currentTarget.value)}
                    >
                      <option value="">选择项目或在下方输入路径</option>
                      <For each={server.projects.list()}>
                        {(project) => <option value={project.worktree}>{project.worktree}</option>}
                      </For>
                    </select>
                  </label>
                </Show>
                <For
                  each={state.mode === "backup" ? (["source", "path"] as const) : (["path", "destination"] as const)}
                >
                  {(field) => (
                    <div class="flex flex-col gap-2">
                      <TextField
                        label={
                          field === "source"
                            ? "源项目目录（服务器端绝对路径）"
                            : field === "destination"
                              ? "目标目录（可选；留空按项目身份自动匹配）"
                              : state.mode === "backup"
                                ? "输出 ZIP 文件（服务器端绝对路径）"
                                : "迁移包 ZIP 文件（服务器端绝对路径）"
                        }
                        value={state[field]}
                        onChange={(value) => change(field, value)}
                        disabled={state.busy}
                      />
                      <Show
                        when={
                          server.isLocal() &&
                          (field !== "path"
                            ? platform.openDirectoryPickerDialog
                            : state.mode === "backup"
                              ? platform.saveFilePickerDialog
                              : platform.openFilePickerDialog)
                        }
                      >
                        <Button
                          class="self-end"
                          variant="secondary"
                          size="small"
                          disabled={state.busy}
                          onClick={() => void pick(field)}
                        >
                          选择{field === "path" ? " ZIP 文件" : "文件夹"}
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={state.mode === "restore"}>
                  <p>
                    先读取迁移包。未匹配到项目时可新建项目：选择空目录，或输入尚不存在的目录（父目录必须已存在）。也可手动指定已有项目目录，但会替换该目录的文件与全部项目会话，请仔细核对身份。
                  </p>
                  <Show when={state.candidates.length > 0}>
                    <label class="flex flex-col gap-2">
                      匹配到的项目目录（选择后重新读取）
                      <select
                        class="w-full min-w-0 rounded-xl border border-v2-border-border-base bg-v2-background-bg-base p-2"
                        value={state.destination}
                        disabled={state.busy}
                        onChange={(event) => change("destination", event.currentTarget.value)}
                      >
                        <option value="">自动匹配 / 请选择目标</option>
                        <For each={state.candidates}>
                          {(directory) => <option value={directory}>{directory}</option>}
                        </For>
                      </select>
                    </label>
                  </Show>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={state.busy || !canRead()}
                    onClick={() => void readPackage()}
                  >
                    {state.preview ? "重新读取迁移包" : "读取迁移包"}
                  </Button>
                </Show>
                <Show when={state.preview}>
                  {(preview) => (
                    <div class="space-y-3 rounded-2xl border border-v2-border-border-base bg-v2-background-bg-deep p-3">
                      <div class="break-words text-13-medium text-v2-text-text-base">
                        {preview().package.name} ·{" "}
                        {preview().action === "replace"
                          ? "替换已有项目"
                          : preview().action === "create"
                            ? "加载为新项目"
                            : "请选择目标目录并重新读取"}
                      </div>
                      <p class="break-all">项目身份：{preview().package.identity}</p>
                      <p>迁移包创建时间：{formatProjectTime(preview().package.createdAt)}（不是项目内容更新时间）</p>
                      <p class="break-all">目标目录：{preview().directory ?? "尚未确定"}</p>
                      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <For each={["package", "local"] as const}>
                          {(side) => (
                            <div class="min-w-0 space-y-2 rounded-xl border border-v2-border-border-base p-3">
                              <div class="text-12-medium text-v2-text-text-base">
                                {side === "package" ? "迁移包快照" : "当前本地项目（服务器端）"}
                              </div>
                              <Show when={preview()[side]} fallback={<p>无本地快照 / 尚未选择目标</p>}>
                                {(snapshot) => (
                                  <>
                                    <p>
                                      {snapshot().files} 个文件 · {snapshot().sessions} 个会话
                                    </p>
                                    <p class="break-words">
                                      文件最新时间：{formatProjectTime(snapshot().filesUpdatedAt)}
                                    </p>
                                    <p class="break-words">
                                      会话最新时间：{formatProjectTime(snapshot().sessionsUpdatedAt)}
                                    </p>
                                  </>
                                )}
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                      <Show when={preview().local}>
                        {(local) => (
                          <div>
                            <p>
                              文件：
                              {
                                comparisons[
                                  compareProjectTime(preview().package.filesUpdatedAt, local().filesUpdatedAt)
                                ]
                              }
                            </p>
                            <p>
                              会话：
                              {
                                comparisons[
                                  compareProjectTime(preview().package.sessionsUpdatedAt, local().sessionsUpdatedAt)
                                ]
                              }
                            </p>
                            <p>综合时间比较：{comparisons[compareProjectSnapshots(preview().package, local())]}</p>
                          </div>
                        )}
                      </Show>
                      <p>所有时间以 UTC 显示。不同设备时钟可能有偏差，时间仅供参考，不能据此证明内容一致或安全覆盖。</p>
                      <For each={preview().warnings}>
                        {(warning) => <p class="break-words text-icon-warning-base">警告：{warning}</p>}
                      </For>
                      <Show when={preview().action === "replace"}>
                        <div class="space-y-2 rounded-xl border border-danger-base/30 bg-danger-base/5 p-3">
                          <p class="text-danger-base">
                            替换不是合并：会删除本地独有文件与会话，用迁移包快照替换项目文件和全部项目会话。根目录 Git
                            元数据是明确例外，会由后端保留。替换前自动保留安全迁移包。
                          </p>
                          <label class="flex items-start gap-2">
                            <input
                              type="checkbox"
                              class="mt-1 shrink-0"
                              checked={state.overwrite}
                              disabled={state.busy}
                              onChange={(event) => setState("overwrite", event.currentTarget.checked)}
                            />
                            <span>
                              我已核对目标与时间，明确同意覆盖项目文件和全部会话，包括删除本地独有的文件及会话。
                            </span>
                          </label>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
                <div class="space-y-2 rounded-2xl border border-icon-warning-base/25 bg-icon-warning-base/5 p-3">
                  <p>
                    包含会话、会话本地文件和工作区文件，不包含全局凭据。但
                    .env、会话历史等仍可能含密钥或敏感数据，请妥善保管 ZIP。导出不会改动源项目。
                  </p>
                  <p>
                    仅加载可信来源的迁移包，归档可能包含脚本。当前仅支持相同操作系统的设备间迁移，项目目录和应用数据目录可以不同。
                  </p>
                  <p>
                    不包含 Git 历史、依赖与缓存目录、历史撤销快照，以及项目和会话目录以外的附件；不支持符号链接或 Git
                    worktree。恢复后项目配置、会话工具及自定义组装脚本会移入 backup-disabled 目录，请检查后再手动启用。
                  </p>
                  <label class="flex items-start gap-2">
                    <input
                      type="checkbox"
                      class="mt-1 shrink-0"
                      checked={state.confirmed}
                      disabled={state.busy || (state.mode === "restore" && !state.preview?.previewToken)}
                      onChange={(event) => setState("confirmed", event.currentTarget.checked)}
                    />
                    <span>
                      我已停止所有 agent、会话活动和文件编辑，并了解敏感数据与可信归档风险。操作期间不会恢复编辑。
                    </span>
                  </label>
                </div>
                <p>
                  请输入完整服务器端绝对路径，归档文件名须以 .zip 结尾。修改路径、切换服务器或重新读取后，必须重新确认。
                </p>
              </Show>
              <Show when={state.busy}>
                <p role="status">处理中，请勿关闭、切换服务器或编辑项目...</p>
              </Show>
              <Show when={state.error}>
                <p role="alert" class="break-words text-danger-base">
                  {state.error}
                </p>
              </Show>
              <Show when={state.result}>
                {(result) => (
                  <div
                    role="status"
                    class="space-y-2 rounded-xl border border-v2-border-border-base p-3 text-v2-text-text-base"
                  >
                    <p>
                      {state.mode === "backup" ? "迁移包已导出" : "项目已加载"}：{result().sessions} 个会话，
                      {result().files} 个文件。
                    </p>
                    <p class="break-all">目标路径：{result().target}</p>
                    <Show when={result().safetyPath}>
                      <p class="break-all">替换前的安全迁移包（已保留）：{result().safetyPath}</p>
                    </Show>
                    <For each={result().warnings}>
                      {(warning) => <p class="break-words text-icon-warning-base">警告：{warning}</p>}
                    </For>
                    <Show when={state.mode === "restore"}>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={state.busy}
                        onClick={() => {
                          const directory = result().target
                          server.projects.open(directory)
                          server.projects.touch(directory)
                          close()
                          navigate(`/${base64Encode(directory)}/session`)
                        }}
                      >
                        打开项目
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
              <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" size="small" disabled={state.busy} onClick={close}>
                  {state.result ? "完成" : "取消"}
                </Button>
                <Show when={!state.result}>
                  <Button variant="primary" size="small" disabled={!canApply()} onClick={() => void apply()}>
                    {state.mode === "backup"
                      ? "导出迁移包"
                      : state.preview?.action === "replace"
                        ? "确认替换文件与全部会话"
                        : state.preview?.action === "create"
                          ? "加载为新项目"
                          : "读取预览后加载"}
                  </Button>
                </Show>
              </div>
            </div>
          </Dialog>
        </Kobalte.Portal>
      </Kobalte>
    </>
  )
}
