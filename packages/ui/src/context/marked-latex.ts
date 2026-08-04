export function normalizeLatexDelimiters(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/^([\t ]*)\\\[[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*\\\][\t ]*$/gm, (_, indent, math) => {
          return `${indent}$$\n${escapePercent(math)}\n${indent}$$`
        })
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$\n${escapePercent(math)}\n$$`)
        .replace(/\\\((.*?)\\\)/g, (_, math) => `$${escapePercent(math)}$`)
    })
    .join("")
}

function escapePercent(math: string) {
  return math.replace(/(^|[^\\])((?:\\\\)*)%/g, "$1$2\\%")
}
