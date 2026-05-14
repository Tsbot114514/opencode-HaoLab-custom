# Manager Page Design

## Purpose

The manager page is a dedicated UI for the fixed management agent session. It must feel like an independent manager surface, not a redirect into the normal classic desktop session page.

The page may reuse proven classic chat pieces, but only inside the manager page boundaries:

- message rendering
- composer behavior
- model selection behavior
- provider/auth dialogs when invoked from model selection

It must not replace the manager page with the full classic app shell or full classic route layout.

## Non-Negotiable Constraints

- The manager session id is always `ses_manager_agent`.
- The manager session title is always `管理agent`.
- The manager page owns session bootstrap and must ensure `ses_manager_agent` exists before chat interaction.
- The page must stay bound to the manager session after refresh, navigation, and standalone Electron launch.
- The manager page must not redirect to `/:dir/session/:id` as its primary implementation.
- The classic desktop window remains unchanged.
- The sidecar/backend remains single-instance.
- The standalone manager desktop is a separate Electron window/process and talks to the existing sidecar through the manager dev proxy.

## Current Problem To Avoid

The wrong direction is loading the whole classic `AppInterface` and using `/manager` only as a redirect to the classic session route. That changes too many semantics:

- manager loses its own page structure
- session binding becomes implicit in route navigation
- classic shell/layout decisions leak into manager
- settings/sidebar placement changes accidentally
- page refresh behavior becomes hard to reason about

This design rejects that direction.

## Page Structure

The manager page should use a stable two-column layout with no top title bar:

```text
┌──────────────────────────────────────────────────────────────┬───────────────┐
│ Chat Area                                                     │ Settings      │
│                                                              │ Sidebar       │
│ Message Timeline                                              │ Proxy 设置    │
│ user / assistant / tool / error / streaming                   │ Provider 状态 │
│                                                              │ Session 信息  │
│ Composer                                                      │ 诊断/警告     │
│ 输入框 | 附件/上下文 | 发送/停止                              │               │
│ Model Selector                                                │               │
│ Provider / Model / Manage Models                              │               │
└──────────────────────────────────────────────────────────────┴───────────────┘
```

### Top Bar

There is no visible top title bar in the approved layout.

Do not add a dedicated `管理agent` row. Do not move sidebar settings into a top bar.

### Chat Area

Responsibilities:

- render messages for `ses_manager_agent`
- handle streaming, multi-step assistant output, tool parts, reasoning, errors, and empty state
- keep scroll behavior stable
- host the composer at the bottom
- place model selection below the composer, following the approved classic-style interaction

Implementation direction:

- reuse classic message rendering components where possible
- reuse classic composer behavior where possible
- preserve manager-specific session id by passing `ses_manager_agent` explicitly or through a manager-local provider
- avoid duplicating message parsing/rendering logic

### Settings Sidebar

Responsibilities:

- proxy settings
- provider/account status or shortcuts
- manager-specific diagnostics
- fixed-session metadata warnings, if needed

The sidebar should remain a sidebar. Do not move these settings into the top bar unless a specific setting is only a compact status/action.

## Session Binding Contract

The manager page must run this bootstrap flow:

1. Read `/connection` from the manager dev proxy.
2. Use the proxied SDK/client against `/api`.
3. Get `ses_manager_agent`.
4. If missing, create it with `{ id: "ses_manager_agent", title: "管理agent", agent: "build" }`.
5. Load messages for `ses_manager_agent`.
6. Send prompts only to `ses_manager_agent`.

The page may display the bound directory from `/connection`, but it must not rely on redirecting to a directory route for the manager session to work.

## Component Reuse Plan

Reuse must be scoped and incremental.

### Phase 1: Keep Manager Page Ownership

Keep the manager page as the owner of:

- layout
- fixed session bootstrap
- settings sidebar
- prompt target session id
- standalone manager desktop entry

No full classic app shell. No classic route redirect.

### Phase 2: Extract Or Wrap Message Rendering

Replace only the manager message list with a shared renderer from the classic session page.

Current implementation:

- manager keeps its own `/manager` page, fixed-session bootstrap, composer, model selector, and sidebar
- manager feeds the fixed session's local message/part state into `DataProvider`
- message turns render through the shared `SessionTurn` component used by the classic session UI
- sidecar SSE events update the local manager state after the initial message load

Acceptable approaches:

- extract a `SessionMessageList`-style component from classic session internals
- wrap existing classic timeline components with a manager-local adapter
- pass explicit `sessionID: "ses_manager_agent"` and data/resources into the renderer

Non-acceptable approaches:

- navigate to classic session route
- render the full classic session page wholesale if that imports unrelated shell/layout behavior
- duplicate all classic message rendering logic into manager

### Phase 3: Reuse Composer

Replace only the manager composer with a shared composer component or extracted composer core.

The composer must still submit to `ses_manager_agent`.

Current implementation uses the shared dock surface primitives for the manager composer chrome while preserving manager-owned prompt submission. Full classic `PromptInput` is not mounted because its current submit path assumes classic route params and may create or navigate to a normal session when no `:id` route param exists.

### Phase 4: Reuse Model Selection

Replace only the manager model selector with the classic model selector or a shared model selector component.

The selector should remain below the composer in the manager layout.

Current implementation uses the classic `ModelSelectorPopover` below the composer, backed by manager-local provider context so its model list and provider/model management dialogs can open without entering the classic session route.

## Refresh Behavior

The page should not repeatedly reload or navigate during normal use.

Allowed refresh behavior:

- user manually refreshes the standalone manager window
- Vite hot reload after source edits during development
- explicit restart action after proxy/sidecar-related settings, if implemented later

Not allowed:

- automatic repeated page reload loops
- redirect loops between `/` and `/manager`
- re-creating or re-routing the page after every message refresh

Message updates should happen through sidecar event subscriptions, not polling or page reload.

## Proxy Settings

First version:

- keep proxy settings in the settings sidebar
- save input locally if backend wiring is not ready
- clearly state that sidecar proxy env changes require restart once that behavior is implemented

Do not move proxy configuration into the top bar.

## Provider And Model UX

The manager should reuse provider/model interactions only after a clear component boundary exists.

Desired behavior:

- model selector shows available models
- provider auth/connect flows reuse classic dialogs where feasible
- missing provider auth produces a clear action rather than silent failure

Do not implement a separate simplified provider system unless explicitly approved.

## Implementation Guardrails

- Do not change manager routing without approval.
- Do not change fixed session id/title without approval.
- Do not remove settings sidebar without approval.
- Do not replace the manager page with full `AppInterface` without approval.
- Do not redirect manager to classic session route without approval.
- Do not auto-refresh or restart the manager window while implementing UI changes.
- After each phase, verify `bun typecheck` and `bun run build` from `packages/manager`.

## Open Decisions

- Should provider status live in the sidebar only, or also show compact state near the model selector?
- Should manager adopt more of classic sync state, or keep the current local SSE adapter around `SessionTurn`?
- Should the stable shared boundary remain `SessionTurn`, or should a higher-level turn list be extracted later?

## Immediate Next Step

Before further code changes, choose one implementation slice:

1. Restore and stabilize the current manager-owned page exactly as the baseline.
2. Extract/reuse only message rendering while keeping current manager layout and session binding.
3. Extract/reuse only model selector while keeping current manager layout and session binding.
