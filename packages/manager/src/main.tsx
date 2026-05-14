// @refresh reload

import "@opencode-ai/app/index.css"
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode-ai/app"
import { render } from "solid-js/web"

const root = document.getElementById("root")

if (!root) throw new Error("missing root element")

const platform: Platform = {
  platform: "web",
  version: "manager-dev",
  openLink: (url) => window.open(url, "_blank"),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  restart: async () => window.location.reload(),
  notify: async () => undefined,
}

const server: ServerConnection.Http = {
  type: "http",
  http: {
    url: `${location.origin}/api`,
  },
}

if (location.pathname === "/") history.replaceState(null, "", "/manager")

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface
          defaultServer={ServerConnection.Key.make(server.http.url)}
          servers={[server]}
          disableHealthCheck
        />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  root,
)
