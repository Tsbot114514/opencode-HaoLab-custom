## Manager Page

- The HaoLab desktop initial route is chosen in `packages/desktop/src/renderer/index.tsx`, not only in app routing; `haolab.startupPage` in `opencode.global.dat` controls `/manager` vs `/classic-manager`.
- The manager surface owns fixed session `ses_manager_agent`; the formal-page startup path should route through `/classic-manager` to preserve this session binding.
- Update metadata displayed in manager comes from desktop `checkUpdate()` through the platform API; adding fields like release notes requires changing desktop main, IPC/preload types, app platform, and manager UI together.
