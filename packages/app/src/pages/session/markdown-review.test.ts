import { describe, expect, test } from "bun:test"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import {
  markdownWatcherAction,
  placeMarkdownReviewItems,
  readMarkdownReview,
  resolveMarkdownImagePath,
} from "./markdown-review"
import {
  addMarkdownComment,
  markdownComments,
  markdownRevisions,
  parseMarkdown,
  removeMarkdownComment,
  restoreMarkdownDeletion,
  selectionHasMarkdownDeletion,
  serializeMarkdown,
  trackedDeletion,
  trackedTextInput,
} from "./markdown-review-editor"

describe("Markdown CriticMarkup review", () => {
  test("parses and serializes insertion, deletion, replacement, and comments", () => {
    const source =
      "Text {++added++}, {--removed--}, {~~old~>new~~}, and {==reviewed==}{>>[id=note-1] Check this<<}."
    const output = serializeMarkdown(parseMarkdown(source))

    expect(output).toContain("{++added++}")
    expect(output).toContain("{--removed--}")
    expect(output).toContain("{--old--}{++new++}")
    expect(output).toContain("{==reviewed==}{>>[id=note-1] Check this<<}")
  })

  test("renders review marks without exposing CriticMarkup delimiters", () => {
    const host = document.createElement("div")
    const editor = new EditorView(host, {
      state: EditorState.create({ doc: parseMarkdown("A {++new++} and {--old--} value.") }),
    })

    expect(host.querySelector("ins")?.textContent).toBe("new")
    expect(host.querySelector("del")?.textContent).toBe("old")
    expect(host.textContent).toBe("A new and old value.")
    editor.destroy()
  })

  test("marks typed text as an insertion in the same transaction", () => {
    const state = EditorState.create({ doc: parseMarkdown("Hello world.") })
    const next = state.apply(trackedTextInput(state, 7, 7, "new "))

    expect(serializeMarkdown(next.doc)).toBe("Hello {++new ++}world.")
    expect(markdownRevisions(next.doc)).toMatchObject([{ kind: "insertion", text: "new " }])
  })

  test("merges continuous typing into one insertion marker", () => {
    const initial = EditorState.create({ doc: parseMarkdown("Text.") })
    const first = initial.apply(trackedTextInput(initial, 5, 5, "a"))
    const second = first.apply(trackedTextInput(first, 6, 6, "b"))

    expect(serializeMarkdown(second.doc)).toBe("Text{++ab++}.")
    expect(markdownRevisions(second.doc)).toHaveLength(1)
  })

  test("updates the active paragraph without rebuilding the document DOM", () => {
    const host = document.createElement("div")
    const editor = new EditorView(host, { state: EditorState.create({ doc: parseMarkdown("Stable paragraph.") }) })
    const paragraph = host.querySelector("p")

    editor.dispatch(trackedTextInput(editor.state, 8, 8, "new "))

    expect(host.querySelector("p")).toBe(paragraph)
    expect(serializeMarkdown(editor.state.doc)).toBe("Stable {++new ++}paragraph.")
    editor.destroy()
  })

  test("marks original text as deleted instead of removing it", () => {
    const state = EditorState.create({ doc: parseMarkdown("Hello world.") })
    const next = state.apply(trackedDeletion(state, 7, 12))

    expect(serializeMarkdown(next.doc)).toBe("Hello {--world--}.")
    expect(next.doc.textContent).toBe("Hello world.")
  })

  test("physically removes text that was newly inserted", () => {
    const state = EditorState.create({ doc: parseMarkdown("Hello {++new ++}world.") })
    const next = state.apply(trackedDeletion(state, 7, 11))

    expect(serializeMarkdown(next.doc)).toBe("Hello world.")
  })

  test("detects and restores selected deleted text", () => {
    const state = EditorState.create({ doc: parseMarkdown("Keep {--restored--} text.") })

    expect(selectionHasMarkdownDeletion(state.doc, 6, 14)).toBe(true)
    expect(selectionHasMarkdownDeletion(state.doc, 1, 5)).toBe(false)
    expect(serializeMarkdown(state.apply(restoreMarkdownDeletion(state.tr, 6, 14)).doc)).toBe("Keep restored text.")
  })

  test("records replacements as adjacent deletion and insertion marks", () => {
    const state = EditorState.create({ doc: parseMarkdown("Hello old value.") })
    const next = state.apply(trackedTextInput(state, 7, 10, "new"))

    expect(serializeMarkdown(next.doc)).toBe("Hello {--old--}{++new++} value.")
  })

  test("stores comments directly in Markdown and removes them transactionally", () => {
    const state = EditorState.create({ doc: parseMarkdown("Review this text.") })
    const commented = state.apply(addMarkdownComment(state.tr, 8, 12, "note-1", "Needs evidence"))

    expect(serializeMarkdown(commented.doc)).toBe("Review {==this==}{>>[id=note-1] Needs evidence<<} text.")
    expect(markdownComments(commented.doc)).toMatchObject([
      { id: "note-1", comment: "Needs evidence", quote: "this" },
    ])
    expect(serializeMarkdown(commented.apply(removeMarkdownComment(commented.tr, "note-1")).doc)).toBe(
      "Review this text.",
    )
  })

  test("binds a trailing CriticMarkup comment to an image", () => {
    const source = "![Experiment workflow](images/workflow.png){>>[id=figure-1] Clarify the third step.<<}"
    const document = parseMarkdown(source)
    const image = document.firstChild?.firstChild
    const state = EditorState.create({ doc: document })

    expect(image?.type.name).toBe("image")
    expect(image?.marks.find((mark) => mark.type.name === "comment")?.attrs).toMatchObject({
      id: "figure-1",
      comment: "Clarify the third step.",
    })
    expect(markdownComments(document)).toMatchObject([
      {
        id: "figure-1",
        comment: "Clarify the third step.",
        quote: "![Experiment workflow](images/workflow.png)",
      },
    ])
    expect(serializeMarkdown(document).trim()).toBe(source)
    expect(serializeMarkdown(state.apply(removeMarkdownComment(state.tr, "figure-1")).doc).trim()).toBe(
      "![Experiment workflow](images/workflow.png)",
    )
  })

  test("renders an image comment as image metadata without exposing CriticMarkup", () => {
    const host = document.createElement("div")
    const editor = new EditorView(host, {
      state: EditorState.create({
        doc: parseMarkdown("![Workflow](images/workflow.png){>>[id=figure-1] Check this figure.<<}"),
      }),
    })

    expect(host.querySelector("[data-comment-id=figure-1] img")?.getAttribute("src")).toBe("images/workflow.png")
    expect(host.textContent).toBe("")
    editor.destroy()
  })

  test("produces the same document and review marks after save and reload", () => {
    const source =
      "---\ntitle: Draft\n---\n\n| A | B |\n| --- | --- |\n| {++one++} | {--two--} |\n\n{==Review me==}{>>[id=note-1] Comment<<}"
    const document = parseMarkdown(source)
    const reloaded = parseMarkdown(serializeMarkdown(document))

    expect(reloaded.eq(document)).toBe(true)
    expect(markdownRevisions(reloaded)).toEqual(markdownRevisions(document))
    expect(markdownComments(reloaded)).toEqual(markdownComments(document))
  })

  test("preserves CriticMarkup nested inside strong text", () => {
    const source = "**3{--2--}月：完成研究{++研究2++}{--2a和2b--}。**"
    const document = parseMarkdown(source)

    expect(document.textContent).toBe("32月：完成研究研究22a和2b。")
    expect(serializeMarkdown(document).trim()).toBe(source)
    expect(markdownRevisions(document).map((revision) => [revision.kind, revision.text])).toEqual([
      ["deletion", "2"],
      ["insertion", "研究2"],
      ["deletion", "2a和2b"],
    ])
  })

  test("renders a punctuated strong label followed immediately by CJK text", () => {
    const source = "**收获与启发：**通过阅读，我逐渐认识到这一点。"
    const document = parseMarkdown(source)

    expect(document.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toContain("strong")
    expect(document.textContent).toBe("收获与启发：通过阅读，我逐渐认识到这一点。")
    expect(serializeMarkdown(document).trim()).toBe(source)
  })

  test("strips legacy hidden review metadata while loading visible content", () => {
    const source = 'Text\n<!-- opencode-review:{"version":1,"base":"Text","comments":[]} -->\n'
    expect(readMarkdownReview(source).content).toBe("Text")
  })

  test("ignores the watcher event emitted by autosave", () => {
    const content = { currentContent: "draft", persistedContent: "saved", diskContent: "draft" }
    expect(markdownWatcherAction({ currentRevision: "saved", diskRevision: "saved", dirty: false, ...content })).toBe("ignore")
    expect(markdownWatcherAction({ currentRevision: "saved", diskRevision: "saved", dirty: true, ...content })).toBe("ignore")
  })

  test("reloads only clean external changes and flags dirty conflicts", () => {
    const content = { currentContent: "draft", persistedContent: "saved", diskContent: "external" }
    expect(markdownWatcherAction({ currentRevision: "before", diskRevision: "external", dirty: false, ...content })).toBe("reload")
    expect(markdownWatcherAction({ currentRevision: "before", diskRevision: "external", dirty: true, ...content })).toBe("conflict")
  })

  test("adopts already saved content and rebases unchanged disk content", () => {
    expect(
      markdownWatcherAction({
        currentRevision: "before",
        diskRevision: "after",
        currentContent: "draft",
        persistedContent: "saved",
        diskContent: "draft",
        dirty: true,
      }),
    ).toBe("adopt")
    expect(
      markdownWatcherAction({
        currentRevision: "before",
        diskRevision: "after",
        currentContent: "draft",
        persistedContent: "saved",
        diskContent: "saved",
        dirty: true,
      }),
    ).toBe("rebase")
  })

  test("aligns comment cards to text unless they would overlap", () => {
    expect(
      placeMarkdownReviewItems([
        { id: "first", desired: 80, height: 40 },
        { id: "second", desired: 180, height: 40 },
      ]).tops,
    ).toEqual({ first: 80, second: 180 })
    expect(
      placeMarkdownReviewItems([
        { id: "first", desired: 80, height: 60 },
        { id: "second", desired: 100, height: 40 },
      ]).tops,
    ).toEqual({ first: 80, second: 150 })
  })

  test("resolves local images relative to the Markdown document", () => {
    expect(resolveMarkdownImagePath("chapters/chapter-9-draft.md", "../images/semantic-space.png")).toBe(
      "images/semantic-space.png",
    )
    expect(resolveMarkdownImagePath("chapter-9-draft.md", "./figures/semantic%20space.png?version=2")).toBe(
      "figures/semantic space.png",
    )
    expect(resolveMarkdownImagePath("chapters/chapter-9-draft.md", "/shared/figure.png")).toBe("shared/figure.png")
  })

  test("rejects remote and workspace-escaping image paths", () => {
    expect(resolveMarkdownImagePath("chapter.md", "https://example.com/figure.png")).toBeUndefined()
    expect(resolveMarkdownImagePath("chapter.md", "data:image/png;base64,abc")).toBeUndefined()
    expect(resolveMarkdownImagePath("chapter.md", "../outside.png")).toBeUndefined()
  })
})
