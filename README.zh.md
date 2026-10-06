# HaoLab OpenCode

HaoLab OpenCode 是 fork 自 [OpenCode](https://opencode.ai) 的自定义桌面发行版，面向 HaoLab 的本地 manager-first 工作流和实验场景。

这是一个 fork/custom build，不是上游 OpenCode 官方仓库。仓库内部仍会保留很多 `opencode` 名称，例如包名、配置路径、schema、模块名等。这些不是单纯品牌文案，而是运行时兼容接口，不应随意改名。

Fork 关系：

```text
上游项目: https://github.com/anomalyco/opencode
自定义发行版: https://github.com/Tsbot114514/opencode-HaoLab-custom
```

## 主要差异

- HaoLab 品牌桌面应用：`HaoLab OpenCode`。
- 默认启动到管理页面，而不是直接进入 classic session 页面。
- 支持固定管理会话和本地 manager-agent 工作流。
- 可在管理页面中选择下次启动进入“管理页面”或“正式页面”。
- 自动更新走本 custom 仓库的 GitHub Release。
- 当前主要验证 Windows 打包、安装和更新流程。
- 增强了长时间 LLM streaming 和瞬时网络错误的重试/恢复能力。

## 下载

从本仓库 GitHub Releases 下载最新 HaoLab Windows 安装包：

```text
https://github.com/Tsbot114514/opencode-HaoLab-custom/releases
```

当前 Windows 安装包文件名：

```text
HaoLab-OpenCode-win-x64.exe
```

自动更新依赖同一个 Release 中的：

```text
latest.yml
HaoLab-OpenCode-win-x64.exe
HaoLab-OpenCode-win-x64.exe.blockmap
```

## 桌面启动行为

HaoLab 构建默认进入管理页面。管理页面可以设置下次启动入口：

- `管理页面`: 进入 HaoLab manager 页面。
- `正式页面`: 进入 classic OpenCode session 页面。

该偏好保存在桌面应用的本地配置中，重启后生效。

## 远程连接（待双设备验证）

HaoLab Desktop 内置无 GUI 的 Tailscale 组网组件，不要求用户单独安装 Tailscale。设备 A 在管理页面开启本机共享，首次通过页面给出的链接授权加入 tailnet。然后在 Tailscale 管理台生成**可复用**的 Auth Key，粘贴到 A 管理页的“共享本机”中并保存。上线后，“本机信息”显示含 Auth Key 的新版配对文本和二维码。设备 B 在自己的管理页面粘贴 A 的新版配对文本，即可自动使用 Auth Key 加入同一 tailnet 并连接 A 当前运行的 sidecar，无需单独打开授权页面。若 tailnet 要求设备审批，请在生成 Auth Key 时启用预授权，或由管理员审批 B。B 退出不会停止 A 的任务。

连接仅在 tailnet 内可达，不使用公网 Funnel。A 的 Desktop 必须保持运行；关闭本机共享会暂停访问，重新开启后原配对文本仍有效。配对文本同时含访问令牌和入网 Auth Key，A 更新 Auth Key 后应重新分享配对信息。A 的 Auth Key 和 B 的配对信息保存在各自的桌面用户数据中；sidecar 的本地随机端口和密码不会写入配对文本。之前已保存的不含 Auth Key 的旧配对文本仍按原方式要求 B 手动授权。

A 开启共享时提供当前侧栏的完整目录路径清单（不共享整个桌面设置文件）。B 连接 A 的后端并读到清单后，按 A 的路径显示项目和读取 A 的会话；B 的本地侧栏记录只用于界面显示，不是项目数据。A 后续调整侧栏时，关闭再开启共享，并让 B 重新选择远端连接即可获取新清单。

B 会记住上次选择的服务器。重启后若配对连接已恢复，会自动选回 A；远端会话仍从 A 读取，优先加载上次使用的项目，其他项目在后台依次加载。

切换到 A 或重启时，Desktop 会先显示该配对身份缓存的项目、会话标题和最近消息，再在后台与服务器对账新增、更新、归档及删除的标题。B 的标题与已查看的消息以有界缓存保存在内存和本地磁盘中；本机 sidecar 不启用磁盘展示缓存，避免切换数据库目录时显示另一份数据。A 仍保管权威会话数据，消息正文按选中后的 20 条分页读取，已缓存的历史页可直接读取。多窗口通过主进程统一管理消息缓存，避免旧窗口写回已删除的数据；断开配对会清除远端磁盘缓存。两端更新到新版后使用增量游标对账；若 A 仍是旧版，B 会退回原有的标题列表读取。

构建桌面安装包需要 Go 1.26.6（仅构建时）；安装包包含远程组网组件，最终用户无需安装 Go。本功能已通过单机编译和单元测试，尚未在两台实际设备之间完成连接测试。

## iOS 客户端

iOS 原生客户端独立维护于 [opencode-HaoLab-ios](https://github.com/Tsbot114514/opencode-HaoLab-ios)。本仓库负责设备端后端、Desktop、SDK 和共享 Web UI，不包含 iOS 原生工程。iOS 仓库通过固定提交版本获取并构建共享 Web UI；个人签名、配对凭据、缓存和构建产物不上传。

消息增量同步需要 A、B 都包含新版接口。首次读取最近消息快照，后续使用持久化消息变更游标同步新增、续写、修改和删除；旧 A 不支持该接口时，iOS 客户端退回有界分页校对。

## 开发

在仓库根目录安装依赖：

```bash
bun install
```

常用开发命令：

```bash
bun dev:desktop
bun dev:web
bun dev:manager
```

类型检查请在具体 package 目录中运行，例如：

```bash
cd packages/desktop
bun typecheck
```

不要从仓库根目录运行测试；测试应在具体 package 目录中运行。

## 构建 HaoLab 桌面版

在 `packages/desktop` 目录中运行：

```powershell
$env:OPENCODE_VERSION='1.15.13'
$env:OPENCODE_CHANNEL='prod'
$env:OPENCODE_BRANDING='haolab'
bun ./scripts/prepare.ts
bun run build
bun run package:win
```

本地打包时可能生成带空格的文件名，而 updater metadata 需要连字符文件名。发布前请确保文件名与 `latest.yml` 对齐：

```text
HaoLab-OpenCode-win-x64.exe
HaoLab-OpenCode-win-x64.exe.blockmap
latest.yml
```

## 命名边界

公开发行版文档、安装包、桌面产品名应该使用 HaoLab OpenCode。

以下名称通常应保持 OpenCode/opencode 原样，除非明确要 fork 运行时接口：

- `.opencode`
- `opencode.json`
- `@opencode-ai/*`
- `https://opencode.ai/config.json`
- CLI/server/sdk 内部兼容接口

## 上游项目与归属说明

HaoLab OpenCode fork 自 OpenCode，并尽量保持与上游运行时和配置生态兼容：

```text
https://github.com/anomalyco/opencode
https://opencode.ai
```

核心配置、agent、tool、plugin 等通用能力仍可参考上游文档；本 fork 的自定义行为以本仓库文档和代码为准。

本 fork 由 HaoLab 作为自定义发行版维护，不是上游 OpenCode 维护者发布的官方版本。
