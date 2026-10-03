import type { RemoteStatus } from "../preload/types"

export function validStoreName(name: unknown): name is string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name) || name.includes("..") || name.endsWith(".")) return false
  const protectedNames = ["opencode.sidebar-display.dat", "opencode.transcripts.dat"]
  return !protectedNames.includes(name.toLowerCase()) || protectedNames.includes(name)
}

export async function allowDisplayCacheKey(
  name: string,
  key: string,
  remoteStatus: () => Promise<RemoteStatus>,
  currentCacheKey: (status: RemoteStatus) => string | undefined,
) {
  if (!validStoreName(name) || typeof key !== "string") return false
  if (!["opencode.sidebar-display.dat", "opencode.transcripts.dat"].includes(name)) return true
  if (!/^tunnel\.v1\.[a-f0-9]{64}$/.test(key)) return false
  const status = await remoteStatus().catch(() => undefined)
  return !!status?.online && !!status.connection && key === `tunnel.v1.${status.cacheKey}` &&
    status.cacheKey === currentCacheKey(status)
}
