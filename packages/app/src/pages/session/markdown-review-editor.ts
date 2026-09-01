import MarkdownIt from "markdown-it"
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown"
import { Node as ProseMirrorNode, Schema, type Mark } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import { tableNodes } from "prosemirror-tables"

export type MarkdownRevision = {
  id: string
  kind: "insertion" | "deletion"
  from: number
  to: number
  text: string
}

export type MarkdownComment = {
  id: string
  comment: string
  from: number
  to: number
  quote: string
}

const schema = new Schema({
  nodes: defaultMarkdownParser.schema.spec.nodes
    .update("list_item", {
      ...defaultMarkdownParser.schema.spec.nodes.get("list_item"),
      attrs: { checked: { default: null } },
      toDOM: (node) => ["li", node.attrs.checked === null ? {} : { "data-checked": String(node.attrs.checked) }, 0],
    })
    .append(tableNodes({ tableGroup: "block", cellContent: "inline*", cellAttributes: {} }))
    .append({
      frontmatter: {
        group: "block",
        atom: true,
        attrs: { value: {} },
        toDOM: (node) => ["pre", { class: "markdown-frontmatter" }, node.attrs.value],
      },
      raw_html_block: {
        group: "block",
        atom: true,
        attrs: { value: {} },
        toDOM: (node) => ["pre", { class: "markdown-raw-html" }, node.attrs.value],
      },
      raw_html_inline: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { value: {} },
        toDOM: (node) => ["code", { class: "markdown-raw-html" }, node.attrs.value],
      },
    }),
  marks: defaultMarkdownParser.schema.spec.marks.append({
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "strike" }],
      toDOM: () => ["s", 0],
    },
    insertion: {
      excludes: "deletion",
      parseDOM: [{ tag: "ins" }],
      toDOM: () => ["ins", { class: "markdown-review-insertion", "data-review-kind": "insertion" }, 0],
    },
    deletion: {
      excludes: "insertion",
      parseDOM: [{ tag: "del[data-review-kind=deletion]" }],
      toDOM: () => ["del", { class: "markdown-review-deletion", "data-review-kind": "deletion" }, 0],
    },
    comment: {
      attrs: { id: {}, comment: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "span[data-comment-id]",
          getAttrs: (element) => ({
            id: (element as HTMLElement).dataset.commentId,
            comment: (element as HTMLElement).dataset.comment ?? "",
          }),
        },
      ],
      toDOM: (mark) => [
        "span",
        {
          class: "markdown-review-commented-text",
          "data-comment": mark.attrs.comment,
          "data-comment-id": mark.attrs.id,
        },
        0,
      ],
    },
  }),
})

const taskLists = (markdown: MarkdownIt) => {
  markdown.core.ruler.after("inline", "task-lists", (state) => {
    const items: (typeof state.tokens)[number][] = []
    for (const token of state.tokens) {
      if (token.type === "list_item_open") {
        items.push(token)
        continue
      }
      if (token.type === "list_item_close") {
        items.pop()
        continue
      }
      if (token.type !== "inline" || items.length === 0) continue
      const match = token.content.match(/^\[([ xX])\]\s+/)
      if (!match) continue
      items.at(-1)?.attrSet("data-checked", String(match[1].toLowerCase() === "x"))
      token.content = token.content.slice(match[0].length)
      const first = token.children?.[0]
      if (first?.type === "text") first.content = first.content.slice(match[0].length)
    }
  })
}

const criticMarkup = (markdown: MarkdownIt) => {
  markdown.inline.ruler.before("emphasis", "critic-markup", (state, silent) => {
    const source = state.src.slice(state.pos)
    const comment = source.match(/^\{==([\s\S]+?)==\}\{>>(?:\[id=([^\]\s]+)\]\s*)?([\s\S]*?)<<\}/)
    const imageComment = source.match(/^\{>>(?:\[id=([^\]\s]+)\]\s*)?([\s\S]*?)<<\}/)
    const replacement = source.match(/^\{~~([\s\S]+?)~>([\s\S]+?)~~\}/)
    const insertion = source.match(/^\{\+\+([\s\S]+?)\+\+\}/)
    const deletion = source.match(/^\{--([\s\S]+?)--\}/)

    const marked = (
      type: "comment" | "insertion" | "deletion",
      value: string,
      length: number,
      attrs?: Record<string, string>,
    ) => {
      if (silent) return true
      const open = state.push(`critic_${type}_open`, "", 1)
      Object.entries(attrs ?? {}).forEach(([key, item]) => open.attrSet(key, item))
      const tokens = [] as typeof state.tokens
      state.md.inline.parse(value, state.md, state.env, tokens)
      state.tokens.push(...tokens)
      state.push(`critic_${type}_close`, "", -1)
      state.pos += length
      return true
    }

    if (comment) {
      return marked("comment", comment[1], comment[0].length, {
        id: comment[2] ?? `comment-${state.pos}-${comment[3].length}`,
        comment: comment[3],
      })
    }
    if (imageComment && state.tokens.at(-1)?.type === "image") {
      if (silent) return true
      const image = state.tokens.pop()!
      const open = state.push("critic_comment_open", "", 1)
      open.attrSet("id", imageComment[1] ?? `comment-${state.pos}-${imageComment[2].length}`)
      open.attrSet("comment", imageComment[2])
      state.tokens.push(image)
      state.push("critic_comment_close", "", -1)
      state.pos += imageComment[0].length
      return true
    }
    if (replacement) {
      if (silent) return true
      marked("deletion", replacement[1], 0)
      marked("insertion", replacement[2], replacement[0].length)
      return true
    }
    if (insertion) return marked("insertion", insertion[1], insertion[0].length)
    if (deletion) return marked("deletion", deletion[1], deletion[0].length)
    return false
  })
}

const adjacentStrong = (markdown: MarkdownIt) => {
  markdown.inline.ruler.before("emphasis", "adjacent-strong", (state, silent) => {
    const match = state.src.slice(state.pos).match(/^\*\*([^\n]+?[\p{P}\p{S}])\*\*(?=\S)/u)
    if (!match) return false
    if (silent) return true

    state.push("strong_open", "strong", 1)
    const tokens = [] as typeof state.tokens
    state.md.inline.parse(match[1], state.md, state.env, tokens)
    state.tokens.push(...tokens)
    state.push("strong_close", "strong", -1)
    state.pos += match[0].length
    return true
  })
}

const tokenizer = MarkdownIt({ html: true, linkify: true }).use(taskLists).use(criticMarkup).use(adjacentStrong)

const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  list_item: {
    block: "list_item",
    getAttrs: (token) => ({ checked: token.attrGet("data-checked") === null ? null : token.attrGet("data-checked") === "true" }),
  },
  s: { mark: "strike" },
  html_block: { node: "raw_html_block", getAttrs: (token) => ({ value: token.content }) },
  html_inline: { node: "raw_html_inline", getAttrs: (token) => ({ value: token.content }) },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header" },
  td: { block: "table_cell" },
  critic_insertion: { mark: "insertion" },
  critic_deletion: { mark: "deletion" },
  critic_comment: {
    mark: "comment",
    getAttrs: (token) => ({ id: token.attrGet("id"), comment: token.attrGet("comment") ?? "" }),
  },
})

let serializer: MarkdownSerializer

const tableCell = (node: ProseMirrorNode) =>
  serializer
    .serialize(schema.topNodeType.create(null, schema.nodes.paragraph.create(null, node.content)))
    .trim()
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")

const criticText = (value: string) => value.replaceAll("<<}", "<\\<}")

serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    paragraph(state, node, parent) {
      if (parent.type.name === "list_item" && parent.attrs.checked !== null) {
        state.write(parent.attrs.checked ? "[x] " : "[ ] ")
      }
      state.renderInline(node)
      state.closeBlock(node)
    },
    table(state, node) {
      const rows = Array.from({ length: node.childCount }, (_, rowIndex) => {
        const row = node.child(rowIndex)
        return Array.from({ length: row.childCount }, (_, cellIndex) => tableCell(row.child(cellIndex)))
      })
      if (rows.length === 0) return
      state.write(`| ${rows[0].join(" | ")} |\n`)
      state.write(`| ${rows[0].map(() => "---").join(" | ")} |`)
      rows.slice(1).forEach((row) => state.write(`\n| ${row.join(" | ")} |`))
      state.closeBlock(node)
    },
    table_row() {},
    table_header() {},
    table_cell() {},
    frontmatter(state, node) {
      state.write(node.attrs.value.trimEnd())
      state.closeBlock(node)
    },
    raw_html_block(state, node) {
      state.write(node.attrs.value.trimEnd())
      state.closeBlock(node)
    },
    raw_html_inline(state, node) {
      state.write(node.attrs.value)
    },
    image(state, node, parent, index) {
      defaultMarkdownSerializer.nodes.image(state, node, parent, index)
      const comment = node.marks.find((mark) => mark.type.name === "comment")
      if (comment) state.write(`{>>[id=${comment.attrs.id}] ${criticText(comment.attrs.comment)}<<}`)
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    insertion: { open: "{++", close: "++}", mixable: false, escape: false },
    deletion: { open: "{--", close: "--}", mixable: false, escape: false },
    comment: {
      open: "{==",
      close: (_state, mark) => `==}{>>[id=${mark.attrs.id}] ${criticText(mark.attrs.comment)}<<}`,
      mixable: false,
      escape: false,
    },
  },
)

export const parseMarkdown = (source: string) => {
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]
  if (!frontmatter) return parser.parse(source)
  const document = parser.parse(source.slice(frontmatter.length))
  return schema.topNodeType.create(null, [schema.nodes.frontmatter.create({ value: frontmatter.trimEnd() }), ...document.content.content])
}

export const serializeMarkdown = (document: ProseMirrorNode) => serializer.serialize(document)

const hasMark = (marks: readonly Mark[], name: "insertion" | "deletion") => marks.some((mark) => mark.type.name === name)

export function trackedDeletion(state: EditorState, from: number, to: number) {
  const transaction = state.tr
  const segments: { from: number; to: number; insertion: boolean; deletion: boolean }[] = []
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText) return
    segments.push({
      from: Math.max(from, position),
      to: Math.min(to, position + node.nodeSize),
      insertion: hasMark(node.marks, "insertion"),
      deletion: hasMark(node.marks, "deletion"),
    })
  })
  segments.reverse().forEach((segment) => {
    if (segment.insertion) {
      transaction.delete(segment.from, segment.to)
      return
    }
    if (!segment.deletion) transaction.addMark(segment.from, segment.to, schema.marks.deletion.create())
  })
  return transaction
}

export function trackedTextInput(state: EditorState, from: number, to: number, text: string) {
  const transaction = from === to ? state.tr : trackedDeletion(state, from, to)
  const position = from === to ? from : transaction.mapping.map(to, -1)
  const marks = state.doc
    .resolve(from)
    .marks()
    .filter((mark) => mark.type.name !== "insertion" && mark.type.name !== "deletion")
    .concat(schema.marks.insertion.create())
  transaction.insert(position, schema.text(text, marks))
  return transaction.setSelection(TextSelection.create(transaction.doc, position + text.length))
}

export function selectionHasMarkdownDeletion(document: ProseMirrorNode, from: number, to: number) {
  let found = false
  document.nodesBetween(from, to, (node, position) => {
    if (found || !node.isText || position >= to || position + node.nodeSize <= from) return
    found = hasMark(node.marks, "deletion")
  })
  return found
}

export function restoreMarkdownDeletion(transaction: Transaction, from: number, to: number) {
  return transaction.removeMark(from, to, schema.marks.deletion)
}

export function trackedCharacterRange(state: EditorState, direction: -1 | 1) {
  if (!state.selection.empty) return { from: state.selection.from, to: state.selection.to }
  const position = state.selection.from
  const resolved = state.doc.resolve(position)
  const node = direction === -1 ? resolved.nodeBefore : resolved.nodeAfter
  if (!node?.isText || !node.text) return
  if (hasMark(node.marks, "deletion")) {
    const next = direction === -1 ? position - node.nodeSize : position + node.nodeSize
    if (next <= 0 || next >= state.doc.content.size) return
    return trackedCharacterRange(EditorState.create({ doc: state.doc, selection: TextSelection.create(state.doc, next) }), direction)
  }
  const character = direction === -1 ? Array.from(node.text).at(-1)! : Array.from(node.text)[0]
  return direction === -1
    ? { from: position - character.length, to: position }
    : { from: position, to: position + character.length }
}

export function markdownRevisions(document: ProseMirrorNode) {
  const revisions: MarkdownRevision[] = []
  document.descendants((node, position) => {
    if (!node.isText || !node.text) return
    const kind = node.marks.find((mark) => mark.type.name === "insertion" || mark.type.name === "deletion")?.type.name as
      | "insertion"
      | "deletion"
      | undefined
    if (!kind) return
    const previous = revisions.at(-1)
    if (previous?.kind === kind && previous.to === position) {
      previous.to += node.nodeSize
      previous.text += node.text
      return
    }
    revisions.push({ id: `${kind}-${position}`, kind, from: position, to: position + node.nodeSize, text: node.text })
  })
  return revisions
}

export function markdownComments(document: ProseMirrorNode) {
  const comments = new Map<string, MarkdownComment>()
  document.descendants((node, position) => {
    if ((!node.isText || !node.text) && node.type.name !== "image") return
    const text = node.isText ? node.text! : `![${node.attrs.alt || node.attrs.src}](${node.attrs.src})`
    node.marks
      .filter((mark) => mark.type.name === "comment")
      .forEach((mark) => {
        const current = comments.get(mark.attrs.id)
        if (current) {
          current.from = Math.min(current.from, position)
          current.to = Math.max(current.to, position + node.nodeSize)
          current.quote += text
          return
        }
        comments.set(mark.attrs.id, {
          id: mark.attrs.id,
          comment: mark.attrs.comment,
          from: position,
          to: position + node.nodeSize,
          quote: text,
        })
      })
  })
  return [...comments.values()]
}

export function addMarkdownComment(transaction: Transaction, from: number, to: number, id: string, comment: string) {
  return transaction.addMark(from, to, schema.marks.comment.create({ id, comment }))
}

export function removeMarkdownComment(transaction: Transaction, id: string) {
  transaction.doc.descendants((node, position) => {
    node.marks
      .filter((mark) => mark.type.name === "comment" && mark.attrs.id === id)
      .forEach((mark) => transaction.removeMark(position, position + node.nodeSize, mark))
  })
  return transaction
}
