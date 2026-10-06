import type { CreateQueryResult } from "@tanstack/solid-query"
import type { Platform } from "@/context/platform"

export function downloadedUpdateVersion(
  query: CreateQueryResult<Awaited<ReturnType<NonNullable<Platform["checkUpdate"]>>>>,
) {
  // Reading data while pending registers the whole shell with Solid Suspense.
  if (query.isLoading || query.isPending) return
  if (!query.data?.updateAvailable || !query.data.downloaded) return
  return query.data.version ?? ""
}
