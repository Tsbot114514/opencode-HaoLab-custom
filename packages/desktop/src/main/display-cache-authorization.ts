export function validStoreName(name: unknown): name is string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name) || name.includes("..") || name.endsWith(".")) return false
  const protectedNames = ["opencode.sidebar-display.dat", "opencode.transcripts.dat"]
  return !protectedNames.includes(name.toLowerCase()) || protectedNames.includes(name)
}

export function allowDisplayCacheKey(
  name: string,
  key: string,
  currentCacheKey: () => string | undefined,
) {
  if (!validStoreName(name) || typeof key !== "string") return false
  if (!["opencode.sidebar-display.dat", "opencode.transcripts.dat"].includes(name)) return true
  if (key === "sidecar.v1") return true
  if (!/^tunnel\.v1\.[a-f0-9]{64}$/.test(key)) return false
  return key === `tunnel.v1.${currentCacheKey()}`
}
