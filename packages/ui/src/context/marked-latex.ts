export function normalizeLatexDelimiters(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$\n${math}\n$$`)
        .replace(/\\\((.*?)\\\)/g, (_, math) => `$${math}$`)
    })
    .join("")
}
