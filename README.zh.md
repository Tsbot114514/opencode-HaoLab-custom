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
