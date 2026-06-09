# HaoLab OpenCode

HaoLab OpenCode is a custom desktop distribution forked from [OpenCode](https://opencode.ai), focused on a manager-first local workflow for HaoLab experiments.

This repository is a fork/custom build, not the upstream OpenCode project. Upstream package names, configuration paths, schemas, and many internal module names still intentionally use `opencode` because the distribution remains compatible with the OpenCode runtime and ecosystem.

Fork attribution:

```text
Upstream: https://github.com/anomalyco/opencode
Custom distribution: https://github.com/Tsbot114514/opencode-HaoLab-custom
```

## What Is Different

- HaoLab-branded desktop app: `HaoLab OpenCode`.
- Manager-first startup flow with a dedicated manager page.
- Fixed manager session support for local manager-agent workflows.
- Desktop startup page preference: manager page or classic session page.
- GitHub Release based updater for the HaoLab custom repository.
- Windows-focused packaging and update validation.
- Network resilience changes for long-running LLM streaming and transient provider failures.

## Downloads

Download the latest HaoLab Windows installer from this repository's GitHub Releases:

```text
https://github.com/Tsbot114514/opencode-HaoLab-custom/releases
```

Current Windows installer asset name:

```text
HaoLab-OpenCode-win-x64.exe
```

Updater metadata is published through the same release channel with `latest.yml` and the matching `.blockmap` file.

## Desktop Behavior

On HaoLab builds, the desktop app defaults to the manager page. The manager page can switch the startup preference between:

- `管理页面`: the HaoLab manager page.
- `正式页面`: the classic OpenCode session page.

The preference is stored locally by the desktop app and applied on the next startup.

## Development

Install dependencies from the repository root:

```bash
bun install
```

Common development commands:

```bash
bun dev:desktop
bun dev:web
bun dev:manager
```

Run type checks from package directories when working on a package, for example:

```bash
cd packages/desktop
bun typecheck
```

Do not run tests from the repository root; package tests should be run from their package directories.

## Building HaoLab Desktop

From `packages/desktop`, build a HaoLab production Windows package with:

```powershell
$env:OPENCODE_VERSION='1.15.13'
$env:OPENCODE_CHANNEL='prod'
$env:OPENCODE_BRANDING='haolab'
bun ./scripts/prepare.ts
bun run build
bun run package:win
```

Local packaging may emit filenames with spaces, while updater metadata expects hyphenated names. Before publishing release assets, align the installer and blockmap filenames with `latest.yml`:

```text
HaoLab-OpenCode-win-x64.exe
HaoLab-OpenCode-win-x64.exe.blockmap
latest.yml
```

## Repository Status

This fork keeps upstream OpenCode internals where compatibility matters. Public distribution docs and desktop metadata should say HaoLab OpenCode; config names such as `.opencode`, `opencode.json`, `@opencode-ai/*`, and `https://opencode.ai/config.json` should remain unchanged unless the runtime is intentionally forked.

## Upstream And Attribution

HaoLab OpenCode is forked from OpenCode and keeps upstream compatibility where possible:

```text
https://github.com/anomalyco/opencode
https://opencode.ai
```

For upstream documentation about core OpenCode configuration, agents, tools, and plugins, refer to the upstream docs unless this fork explicitly overrides behavior.

This fork is maintained as a HaoLab custom distribution and is not an official release from the upstream OpenCode maintainers.
