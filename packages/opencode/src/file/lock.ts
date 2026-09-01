import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Semaphore } from "effect"

const locks = new Map<string, Semaphore.Semaphore>()

export function withFileLock<A, E, R>(filePath: string, effect: Effect.Effect<A, E, R>) {
  const key = AppFileSystem.resolve(filePath)
  const current = locks.get(key)
  if (current) return current.withPermits(1)(effect)

  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next.withPermits(1)(effect)
}
