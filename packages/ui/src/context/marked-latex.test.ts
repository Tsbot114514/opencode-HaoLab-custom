import { describe, expect, test } from "bun:test"
import { normalizeLatexDelimiters } from "./marked-latex"

describe("normalizeLatexDelimiters", () => {
  test("converts LaTeX inline and display delimiters", () => {
    expect(normalizeLatexDelimiters(String.raw`Inline \(x + y\).

\[
\Delta\text{-F1}
\]`)).toBe(`Inline $x + y$.

$$

\\Delta\\text{-F1}

$$`)
  })

  test("preserves delimiters in code", () => {
    const markdown = ["Use \\(x\\) and:", "", "`\\(inline\\)`", "", "```tex", "\\[block\\]", "```"].join("\n")
    const expected = ["Use $x$ and:", "", "`\\(inline\\)`", "", "```tex", "\\[block\\]", "```"].join("\n")

    expect(normalizeLatexDelimiters(markdown)).toBe(expected)
  })
})
