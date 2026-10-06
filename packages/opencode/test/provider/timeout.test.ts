import { expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

const cases: { name: string; options: { timeout?: number | false }; expected: number[] }[] = [
  { name: "defaults to a 20 minute overall provider request timeout", options: {}, expected: [1_200_000] },
  { name: "preserves an explicit overall provider request timeout", options: { timeout: 60_000 }, expected: [60_000] },
  { name: "allows disabling the overall provider request timeout", options: { timeout: false }, expected: [] },
]

cases.forEach((entry) => {
  it.live(entry.name, () =>
    provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("test-model"))
          const language = yield* provider.getLanguage(model)
          // Observe the real transport deadline without waiting twenty minutes.
          const timeout = yield* Effect.acquireRelease(
            Effect.sync(() => spyOn(AbortSignal, "timeout")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          )
          yield* Effect.promise(async () => {
            const result = await language.doStream({
              prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            })
            await result.stream.pipeTo(new WritableStream())
          })
          expect(timeout.mock.calls.map((call) => call[0])).toEqual(entry.expected)
        }),
      {
        config: (url) => ({
          provider: {
            test: {
              npm: "@ai-sdk/openai-compatible",
              models: { "test-model": { name: "Test Model" } },
              options: { apiKey: "test-key", baseURL: url, ...entry.options },
            },
          },
        }),
      },
    ),
  )
})
