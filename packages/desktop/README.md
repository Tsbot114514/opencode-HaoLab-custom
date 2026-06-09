# HaoLab OpenCode Desktop

Electron desktop app for the HaoLab OpenCode custom distribution, forked from upstream OpenCode.

This package still uses upstream OpenCode internals where compatibility matters, but HaoLab production builds are branded and published as `HaoLab OpenCode`.

Upstream attribution:

```text
Upstream: https://github.com/anomalyco/opencode
Custom distribution: https://github.com/Tsbot114514/opencode-HaoLab-custom
```

## Development

```bash
bun install
bun dev
```

From the repository root, the desktop dev command is:

```bash
bun dev:desktop
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## HaoLab Windows Release Build

For a HaoLab production Windows installer:

```powershell
$env:OPENCODE_VERSION='1.15.13'
$env:OPENCODE_CHANNEL='prod'
$env:OPENCODE_BRANDING='haolab'
bun ./scripts/prepare.ts
bun run build
bun run package:win
```

The GitHub updater is configured in `electron-builder.config.ts` to publish HaoLab production builds to:

```text
https://github.com/Tsbot114514/opencode-HaoLab-custom
```

Release assets expected by the updater:

```text
latest.yml
HaoLab-OpenCode-win-x64.exe
HaoLab-OpenCode-win-x64.exe.blockmap
```

Local packaging may emit `HaoLab OpenCode-win-x64.exe`; align filenames with `latest.yml` before testing or uploading release assets.

## Startup Preference

HaoLab builds default to the manager page. Users can switch the startup target in the manager UI between:

- manager page
- classic session page

The desktop renderer reads `haolab.startupPage` from local desktop storage before choosing the initial route.
