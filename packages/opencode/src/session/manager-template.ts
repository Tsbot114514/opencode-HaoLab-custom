import path from "node:path"

declare const OPENCODE_MANAGER_TEMPLATE: TemplateFile[] | undefined

type TemplateFile = {
  path: string
  content: string
}

export const id = "ses_manager_agent"

export async function files() {
  if (typeof OPENCODE_MANAGER_TEMPLATE !== "undefined") return OPENCODE_MANAGER_TEMPLATE
  const root = path.resolve(import.meta.dir, "../../../../agents/manager-agent")
  const manifest = (await Bun.file(path.join(root, "agent.json")).json()) as { files: string[] }
  return Promise.all(
    manifest.files.map(async (file) => ({
      path: file,
      content: await Bun.file(path.join(root, file)).text(),
    })),
  )
}

export * as ManagerSessionTemplate from "./manager-template"
