# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## HaoLab Desktop Updates

- `checkUpdate()` in `src/main/updater.ts` checks metadata and downloads immediately; UI progress must come from `autoUpdater` events bridged through main -> preload -> app platform.
- GitHub updater discovery first requests `/releases.atom`; a private or inaccessible repo returns 404 before `latest.yml` is read, so that is not an "already latest" signal.
- Local HaoLab Windows packaging may emit `HaoLab OpenCode-win-x64.exe` while `latest.yml` references `HaoLab-OpenCode-win-x64.exe`; align filenames before using local metadata for update tests.
