import { $ } from "bun"
import path from "path"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`bun script/build-node.ts`
  .cwd(path.resolve(import.meta.dir, "../../opencode"))
  .env({
    ...process.env,
    MODELS_DEV_API_JSON:
      process.env.MODELS_DEV_API_JSON ?? path.resolve(import.meta.dir, "../../opencode/test/tool/fixtures/models-api.json"),
  })
