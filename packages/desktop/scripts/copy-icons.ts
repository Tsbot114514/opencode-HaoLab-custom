import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()
const branding = Bun.env.OPENCODE_BRANDING

const src = branding === "haolab" ? "./icons/haolab" : `./icons/${channel}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${branding === "haolab" ? "haolab" : channel} icons from ${src} to ${dest}`)
