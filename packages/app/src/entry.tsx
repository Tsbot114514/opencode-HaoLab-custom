// @refresh reload

import * as Sentry from "@sentry/solid"
import { Button } from "@opencode-ai/ui/button"
import { createResource, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { createMobileTranscriptStorage } from "@/utils/mobile-transcript-storage"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"
import { checkServerHealth } from "./utils/server-health"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if ((window as Window & { __HAOLAB_MOBILE__?: boolean }).__HAOLAB_MOBILE__ === true) {
  document.documentElement.dataset.haolabMobile = ""
}
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  transcriptStorage: createMobileTranscriptStorage(window),
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
  clearAuthToken()
  const app = (credentials = auth) => {
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!credentials,
      http: { url: getCurrentUrl(), ...credentials },
    }
    return (
      <AppInterface defaultServer={ServerConnection.Key.make(getDefaultUrl())} servers={[server]} disableHealthCheck />
    )
  }

  function DevelopmentConnection() {
    const [credentials, setCredentials] = createSignal(auth)
    const [password, setPassword] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal(false)
    const [requiresAuth] = createResource(async () => {
      if (auth) return false
      const response = await fetch(new URL("/global/health", getCurrentUrl())).catch(() => undefined)
      return response?.status === 401
    })

    const connect = async (event: SubmitEvent) => {
      event.preventDefault()
      setBusy(true)
      setError(false)
      const next = { username: "opencode", password: password() }
      const result = await checkServerHealth({ url: getCurrentUrl(), ...next }, fetch, { retryCount: 0 })
      setBusy(false)
      if (!result.healthy) {
        setError(true)
        return
      }
      setCredentials(next)
    }

    return (
      <Show when={!requiresAuth.loading}>
        <Show
          when={!requiresAuth() || credentials()}
          fallback={
            <div class="min-h-dvh flex items-center justify-center bg-background-base px-6">
              <form onSubmit={connect} class="w-full max-w-sm rounded-xl border border-border-base bg-surface-base p-6">
                <h1 class="text-18-medium text-text-strong">
                  {getLocale() === "zh" ? "连接到本机服务器" : "Connect to local server"}
                </h1>
                <p class="mt-2 text-14-regular text-text-weak">{getCurrentUrl()}</p>
                <label class="mt-6 block text-14-regular text-text-base">
                  {getLocale() === "zh" ? "Sidecar 密码" : "Sidecar password"}
                  <input
                    type="password"
                    required
                    autofocus
                    value={password()}
                    onInput={(event) => setPassword(event.currentTarget.value)}
                    class="mt-2 w-full rounded-md border border-border-base bg-background-base px-3 py-2 text-text-base"
                  />
                </label>
                <Show when={error()}>
                  <p class="mt-2 text-14-regular text-danger-base">
                    {getLocale() === "zh" ? "连接失败，请检查密码。" : "Connection failed. Check the password."}
                  </p>
                </Show>
                <Button type="submit" variant="primary" disabled={busy()} class="mt-5">
                  {getLocale() === "zh" ? "连接" : "Connect"}
                </Button>
              </form>
            </div>
          }
        >
          {app(credentials())}
        </Show>
      </Show>
    )
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>{import.meta.env.DEV ? <DevelopmentConnection /> : app()}</AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
