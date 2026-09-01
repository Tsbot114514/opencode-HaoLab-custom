const legacyReviewMarker = /\n<!-- opencode-review:(\{.*\}) -->\n?$/

export function readMarkdownReview(source: string) {
  const match = source.match(legacyReviewMarker)
  if (!match || match.index === undefined) return { content: source }
  try {
    const metadata = JSON.parse(match[1]) as { version?: unknown }
    if (metadata.version !== 1 && metadata.version !== 2) return { content: source }
    return { content: source.slice(0, match.index) }
  } catch {
    return { content: source }
  }
}

export function markdownWatcherAction(input: {
  currentRevision: string
  diskRevision: string
  currentContent: string
  persistedContent: string
  diskContent: string
  dirty: boolean
}) {
  if (input.diskRevision === input.currentRevision) return "ignore" as const
  if (input.diskContent === input.currentContent) return "adopt" as const
  if (input.diskContent === input.persistedContent) return "rebase" as const
  if (input.dirty) return "conflict" as const
  return "reload" as const
}

export function placeMarkdownReviewItems(items: { id: string; desired: number; height: number }[]) {
  const tops: Record<string, number> = {}
  let bottom = 12
  items
    .toSorted((a, b) => a.desired - b.desired)
    .forEach((item) => {
      const top = Math.max(12, item.desired, bottom + (bottom === 12 ? 0 : 10))
      tops[item.id] = top
      bottom = top + item.height
    })
  return { tops, height: bottom + 12 }
}

export function resolveMarkdownImagePath(documentPath: string, source: string) {
  const raw = source.trim().split(/[?#]/, 1)[0]?.replaceAll("\\", "/")
  if (!raw || raw.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(raw)) return

  const decoded = (() => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  })()
  const base = decoded.startsWith("/") ? [] : documentPath.replaceAll("\\", "/").split("/").slice(0, -1)
  const resolved = [...base, ...decoded.replace(/^\/+/, "").split("/")].reduce(
    (result, segment) => {
      if (!segment || segment === ".") return result
      if (segment !== "..") return { ...result, parts: [...result.parts, segment] }
      if (result.parts.length === 0) return { ...result, escaped: true }
      return { ...result, parts: result.parts.slice(0, -1) }
    },
    { parts: [] as string[], escaped: false },
  )
  if (resolved.escaped || resolved.parts.length === 0) return
  return resolved.parts.join("/")
}
