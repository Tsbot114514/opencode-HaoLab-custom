import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import markedKatex from "marked-katex-extension"
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

  test("preserves display math indentation inside lists", async () => {
    const markdown = String.raw`1. First
2. Probability:
   \[
   d=0.25
   \]
   in each observation.
3. Last

## Results

\[
1-d^n
\]

| n | probability |
|---:|---:|
| 1 | 75% |`
    const normalized = normalizeLatexDelimiters(markdown)

    expect(normalized).toContain("   $$\n   d=0.25\n   $$")

    const html = await new Marked(
      markedKatex({
        throwOnError: false,
        nonStandard: true,
      }),
    ).parse(normalized)

    expect(html.match(/katex-display/g)).toHaveLength(2)
    expect(html).toContain("<h2>Results</h2>")
    expect(html).toContain("<table>")
  })

  test("escapes unescaped percentages in LaTeX delimiters", async () => {
    const normalized = normalizeLatexDelimiters(
      [
        "\\[",
        "\\boxed{\\text{若要求100%零错误恢复，任何有限案例数都不够。}}",
        "\\]",
        "",
        "Inline \\(95\\%\\).",
      ].join("\n"),
    )

    expect(normalized).toContain(String.raw`100\%`)
    expect(normalized).toContain(String.raw`$95\%$`)

    const html = await new Marked(
      markedKatex({
        throwOnError: false,
        strict: "ignore",
        nonStandard: true,
      }),
    ).parse(normalized)

    expect(html).not.toContain("katex-error")
    expect(html).toContain("若要求")
  })

  test("preserves delimiters in code", () => {
    const markdown = ["Use \\(x\\) and:", "", "`\\(inline\\)`", "", "```tex", "\\[block\\]", "```"].join("\n")
    const expected = ["Use $x$ and:", "", "`\\(inline\\)`", "", "```tex", "\\[block\\]", "```"].join("\n")

    expect(normalizeLatexDelimiters(markdown)).toBe(expected)
  })
})
