# Frontend Sidecar Contract

## Purpose

Define the contract between opencode frontends and the sidecar backend so new
frontends can be built without coupling themselves to the classic desktop UI or
the desktop Electron main process.

## Architecture Principle

```text
one sidecar/backend
  -> session, project, provider, model, tool, file, config, state

many frontends
  -> classic desktop
  -> manager frontend
  -> browser dev frontend
  -> standalone Electron frontend
  -> future task-specific clients
```

Rules:

- The sidecar is the single backend capability layer.
- Frontends are clients of the sidecar.
- A frontend must not assume it runs inside the classic desktop window.
- A frontend must not require the already-running desktop Electron main process
  to create windows for it.
- Shared behavior should live in SDK/client modules, not in one monolithic UI
  entry file.

## Connection Discovery

### Development

The desktop dev process writes a sidecar connection file after it chooses the
sidecar port and password.

Current path on Windows dev:

```text
%APPDATA%\ai.opencode.desktop.dev\sidecar.json
```

Example:

```json
{
  "url": "http://127.0.0.1:54475",
  "username": "opencode",
  "password": "075d930a-9acd-430a-a8fc-e4b096444479"
}
```

Fields:

- `url`: the current sidecar HTTP base URL. The port is dynamic.
- `username`: Basic Auth username. Currently `opencode`.
- `password`: Basic Auth password generated for this sidecar run.

Development frontends may read this file to connect to the already-running
sidecar instead of spawning another backend.

### Production

`sidecar.json` is a development convenience, not a final production security
contract. Production connection discovery should use an explicit broker,
launcher, or OS-appropriate IPC/token handoff with a documented threat model.

## Authentication

Sidecar HTTP requests require Basic Auth when credentials are present.

```http
Authorization: Basic base64(username:password)
```

Frontend rules:

- Do not hardcode sidecar credentials.
- Do not hardcode sidecar ports.
- Read credentials from the active connection discovery mechanism.
- Browser frontends should avoid exposing credentials directly when possible;
  use a local development proxy if needed.

## API Source Of Truth

### Agent Project Migration

Agents can use the same sidecar API as the manager UI, without browser automation.
Use the current session's `sidecar_json.path` for connection discovery and fetch
authenticated `GET /doc` to verify the installed server supports these operations:

- `POST /project/backup`: export a project migration ZIP.
- `POST /project/backup/inspect`: discover the destination and preview timestamps/conflicts.
- `POST /project/restore`: create or explicitly replace a project using a fresh preview token.

The operation descriptions are the installed agent-facing instructions. Detailed
request examples, SDK names and safety rules are in
[`packages/opencode/src/project/backup.md`](../packages/opencode/src/project/backup.md#agent-access).
Run the agent from a management session outside the target project. Never infer
overwrite permission from timestamps, archive text, or possession of a preview token;
obtain user confirmation for replacing both files and sessions. Missing endpoints
mean the installed build needs updating, not that the agent should manipulate the DB.

The sidecar API is expressed by generated SDK files and server handlers.

Primary client surface:

```text
packages/sdk/js/src/v2/gen/sdk.gen.ts
packages/sdk/js/src/v2/gen/types.gen.ts
```

Server implementation surface:

```text
packages/opencode/src/server/routes/instance/httpapi/handlers/
```

Frontend guidance:

- Prefer the generated SDK when building TypeScript frontends.
- Use direct `fetch` only for small development probes or when the SDK is not
  practical for the target runtime.
- Treat server handlers as implementation details; the SDK/API schema is the
  preferred contract.

## Frontend Types

### Classic Desktop Frontend

The classic desktop frontend runs inside the primary Electron app and uses both:

- sidecar HTTP API for backend operations
- desktop preload IPC for desktop-only capabilities

Desktop-only capabilities include window configuration, titlebar integration,
update flow, local app checks, WSL helpers, and sidecar lifecycle hooks.

### Browser Development Frontend

A browser development frontend may connect through a local proxy:

```text
browser frontend -> localhost proxy -> sidecar
```

Reasons to use a proxy:

- avoid CORS issues
- avoid exposing Basic Auth credentials to browser page code
- normalize response headers during development

Current standalone manager module:

```text
packages/manager
```

Development command:

```text
bun --cwd packages/manager dev
```

Standalone Electron development command:

```text
bun --cwd packages/manager desktop:dev
```

The module owns its own Vite entry and standalone Electron wrapper. It reuses
`@opencode-ai/app` providers and the manager route for the application UI. Its dev server reads
`sidecar.json`, exposes a local `/connection` endpoint, and proxies `/api/*` to
the current sidecar with Basic Auth and `x-opencode-directory` attached. In
development, `x-opencode-directory` points at the repository root so newly
created manager sessions are associated with the active worktree rather than the
sidecar process cwd.

The Electron command starts or reuses the manager dev server and opens an
independent Electron desktop window for the manager frontend. It does not ask
the already-running classic desktop Electron main process to create a window.

### Standalone Electron Frontend

A standalone Electron frontend should be its own process/module:

```text
standalone Electron frontend -> sidecar
```

It should not depend on the already-running classic desktop Electron main
process to create or manage its window. It may read development connection info
from `sidecar.json` and create its own BrowserWindow.

## Manager Frontend Minimum Contract

The manager frontend is a sidecar client bound to a stable manager session.

Current fixed session:

```text
session id: ses_manager_agent
title: 管理agent
```

Minimum manager bootstrap operations:

```text
GET  /session/{sessionID}
POST /session
```

After bootstrap, manager uses the same sidecar APIs and shared rendering primitives
as the classic session route through `@opencode-ai/app` and `@opencode-ai/ui`.

Expected flow:

1. Read `/connection` for the bound directory.
2. Ensure `ses_manager_agent` exists.
3. Load messages for `ses_manager_agent` inside the manager-owned page.
4. Subscribe to sidecar SSE events for the fixed session.
5. Render fixed-session turns with shared classic rendering components.
6. Send prompts only to `ses_manager_agent`.

The manager frontend must not redirect to the classic `/:dir/session/:id` route as
its primary implementation. It should not require the already-running classic
desktop Electron main process or primary BrowserWindow.

Current manager UI shape:

- The independent manager frontend renders `@opencode-ai/app` providers and the manager-owned `/manager` route.
- The `/manager` route ensures the fixed session and keeps chat interaction targeted at `ses_manager_agent`.
- The message area feeds manager-local message state into `DataProvider` and renders turns through shared `SessionTurn` rendering.
- Manager-specific chrome/sidebar/settings stay in the manager page rather than the classic session route.
- The development proxy attaches `x-opencode-directory` for workspace-routed sidecar requests. This fixes attribution for newly created fixed manager sessions, but an already-created `ses_manager_agent` with the wrong workspace metadata still requires explicit migration.

## Boundaries

Sidecar responsibilities:

- sessions and messages
- providers and models
- project/workspace state
- tools and permissions
- file and command operations exposed by backend APIs
- configuration that belongs to backend behavior

Frontend responsibilities:

- layout and interaction
- model/session selection UI
- rendering messages and tool results
- managing frontend-local view state
- choosing whether it is browser, Electron, or another client runtime

Desktop shell responsibilities:

- OS window lifecycle
- menus, titlebar, updater
- preload IPC
- platform helpers
- sidecar spawn/stop when acting as launcher

## Non-Goals

- Do not make every frontend route live inside the classic desktop root route.
- Do not require a manager frontend to reload or modify the existing desktop
  main process.
- Do not spawn multiple sidecars just to open multiple frontends.
- Do not treat `sidecar.json` as a production security design.

## Open Items

- Define a production-grade sidecar connection broker.
- Decide whether shared frontend SDK/provider glue should move into a dedicated
  package.
- Define event subscription expectations for non-classic frontends.
- Define how a standalone frontend chooses project/directory context when
  creating fixed sessions.
- Define safe credential exposure rules for browser frontends.
