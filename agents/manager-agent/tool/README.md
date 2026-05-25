# Session Tools

This folder lets this session add extra tools without changing global config.

Create `.ts` or `.js` files in this folder. Each file may export a default tool, or named tools.

File names become tool ids. For example, `weather.ts` default export becomes `weather`. A named export named `forecast` in `weather.ts` becomes `weather_forecast`.

Session tools are loaded only for this session. They do not replace built-in, MCP, or structured output tools; conflicting ids are skipped.

## Recommended Format

Use a dependency-free JSON Schema tool definition. This works from the session data directory without installing `@opencode-ai/plugin`.

```ts
export default {
  description: "Echo a short message.",
  args: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to echo." },
    },
    required: ["message"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    return {
      title: "Echo",
      output: args.message,
      metadata: { sessionID: ctx.sessionID },
    }
  },
}
```

Rules:

- `description` is shown to the model as the tool description.
- `args` or `inputSchema` must be a JSON Schema object.
- `properties.*.description` is shown to the model as parameter guidance.
- `required` controls required parameters.
- `additionalProperties: false` is recommended to prevent unexpected arguments.
- `execute(args, ctx)` runs when the model calls the tool.
- Call session-local tools with schema properties as top-level arguments. Do not wrap arguments in a `properties` object, even if an external rendering displays that wrapper.
- Return either a string or `{ title?: string, output: string, metadata?: object }`.

The execution context `ctx` includes:

- `sessionID`
- `messageID`
- `agent`
- `directory`
- `worktree`
- `abort`
- `metadata(input)`
- `ask(input)`

## Plugin-Style Format

Tools can also use the same plugin tool shape as config tools when `@opencode-ai/plugin` is resolvable from this directory.

```ts
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Return a demo weather report for a city.",
  args: {
    city: tool.schema.string().describe("City name"),
  },
  async execute(args) {
    return "Weather for " + args.city + ": sunny and 25C"
  },
})
```
