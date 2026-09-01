import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { dataUrlFromMediaValue } from "@opencode-ai/ui/pierre/media"
import { showToast } from "@opencode-ai/ui/toast"
import { baseKeymap } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { keymap } from "prosemirror-keymap"
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state"
import { tableEditing } from "prosemirror-tables"
import type { Node as ProseMirrorNode } from "prosemirror-model"
import { EditorView } from "prosemirror-view"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { formatServerError } from "@/utils/server-errors"
import { uuid } from "@/utils/uuid"
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
  trackedCharacterRange,
  trackedDeletion,
  trackedTextInput,
  type MarkdownComment,
  type MarkdownRevision,
} from "./markdown-review-editor"
import "prosemirror-view/style/prosemirror.css"
import "./markdown-editor.css"

type Draft = {
  persisted: string
  content: string
  revision: string
}

const drafts = new Map<string, Draft>()

const editorPlugins = () => [
  history(),
  keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
  keymap(baseKeymap),
  tableEditing(),
]

export function MarkdownEditor(props: { path: string; onReady?: VoidFunction }) {
  const file = useFile()
  const language = useLanguage()
  const sdk = useSDK()
  const { sessionKey } = useSessionLayout()
  const [state, setState] = createStore({
    persisted: "",
    content: "",
    revision: "",
    loading: false,
    saving: false,
    dirty: false,
    conflict: false,
    ready: false,
    revisions: [] as MarkdownRevision[],
    comments: [] as MarkdownComment[],
    selection: null as { from: number; to: number } | null,
    activeRevision: -1,
    activeComment: -1,
    commenting: false,
    commentDraft: "",
    editingComment: null as string | null,
    commentTops: {} as Record<string, number>,
    commentEditorTop: 12,
    commentRailHeight: 1056,
    selectionMenu: null as { left: number; top: number; restoreDeletion: boolean } | null,
  })
  let host: HTMLDivElement | undefined
  let sidebar: HTMLElement | undefined
  let commentInput: HTMLTextAreaElement | undefined
  let editor: EditorView | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let geometryFrame: number | undefined
  let commentFocusFrame: number | undefined
  let resizeObserver: ResizeObserver | undefined
  let watcherChecking = false
  let watcherPending = false
  const imageViews = new Map<string, Set<HTMLImageElement>>()
  const imageVersions = new WeakMap<HTMLImageElement, number>()

  const key = () => `${sessionKey()}\n${file.normalize(props.path)}`
  const title = () => getFilename(props.path)
  const additions = createMemo(() =>
    state.revisions.filter((revision) => revision.kind === "insertion").reduce((total, revision) => total + revision.text.length, 0),
  )
  const deletions = createMemo(() =>
    state.revisions.filter((revision) => revision.kind === "deletion").reduce((total, revision) => total + revision.text.length, 0),
  )

  const syncGeometry = () => {
    if (!editor || !sidebar) return

    const sidebarRect = sidebar.getBoundingClientRect()
    const cards = new Map(
      [...sidebar.querySelectorAll<HTMLElement>("[data-comment-card-id]")].map((element) => [
        element.dataset.commentCardId!,
        element,
      ]),
    )
    const items = state.comments
      .filter((comment) => comment.id !== state.editingComment)
      .map((comment) => ({
        id: comment.id,
        desired: editor!.coordsAtPos(comment.from).top - sidebarRect.top,
        height: cards.get(comment.id)?.offsetHeight ?? 88,
      }))
    const commentEditorAnchor = state.editingComment
      ? state.comments.find((comment) => comment.id === state.editingComment)?.from
      : state.selection?.from
    const commentEditor = sidebar.querySelector<HTMLElement>("[data-comment-editor]")
    if (state.commenting && commentEditorAnchor !== undefined) {
      items.push({
        id: "__editor__",
        desired: editor.coordsAtPos(commentEditorAnchor).top - sidebarRect.top,
        height: commentEditor?.offsetHeight ?? 146,
      })
    }

    const placed = placeMarkdownReviewItems(items)
    const commentEditorTop = placed.tops.__editor__
    if (commentEditorTop !== undefined) delete placed.tops.__editor__
    setState({
      commentTops: placed.tops,
      commentEditorTop: commentEditorTop ?? state.commentEditorTop,
      commentRailHeight: Math.max(1056, placed.height),
    })

    if (state.commenting || editor.state.selection.empty || !editor.hasFocus()) {
      setState("selectionMenu", null)
      return
    }
    const from = editor.coordsAtPos(editor.state.selection.from)
    const to = editor.coordsAtPos(editor.state.selection.to)
    setState("selectionMenu", {
      left: Math.max(8, Math.min(window.innerWidth - 220, to.right - 8)),
      top: Math.max(8, Math.min(from.top, to.top) - 42),
      restoreDeletion: selectionHasMarkdownDeletion(
        editor.state.doc,
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    })
  }

  const queueGeometry = () => {
    if (geometryFrame !== undefined) cancelAnimationFrame(geometryFrame)
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = undefined
      syncGeometry()
    })
  }

  const syncDocumentState = () => {
    if (!editor) return
    setState({
      revisions: markdownRevisions(editor.state.doc),
      comments: markdownComments(editor.state.doc),
      selection: editor.state.selection.empty
        ? null
        : { from: editor.state.selection.from, to: editor.state.selection.to },
    })
    queueGeometry()
  }

  const unregisterImage = (path: string | undefined, image: HTMLImageElement) => {
    if (!path) return
    const images = imageViews.get(path)
    if (!images) return
    images.delete(image)
    if (images.size === 0) imageViews.delete(path)
  }

  const loadImage = (path: string, image: HTMLImageElement) => {
    const version = (imageVersions.get(image) ?? 0) + 1
    imageVersions.set(image, version)
    void sdk.client.file
      .read({ path })
      .then((result) => {
        if (!result.data || !image.isConnected || imageVersions.get(image) !== version) return
        const source = dataUrlFromMediaValue(result.data, "image")
        if (source) image.src = source
      })
      .catch(() => {})
  }

  const configureImage = (image: HTMLImageElement, node: ProseMirrorNode, previous?: string) => {
    unregisterImage(previous, image)
    const source = typeof node.attrs.src === "string" ? node.attrs.src : ""
    const comment = node.marks.find((mark) => mark.type.name === "comment")
    image.alt = typeof node.attrs.alt === "string" ? node.attrs.alt : ""
    image.title = typeof node.attrs.title === "string" ? node.attrs.title : ""
    image.classList.toggle("markdown-review-commented-image", !!comment)
    if (comment) {
      image.dataset.commentId = comment.attrs.id
      image.dataset.comment = comment.attrs.comment
    } else {
      delete image.dataset.commentId
      delete image.dataset.comment
    }
    const resolved = resolveMarkdownImagePath(file.normalize(props.path), source)
    if (!resolved) {
      image.src = source
      return
    }

    const path = file.normalize(resolved)
    const images = imageViews.get(path) ?? new Set<HTMLImageElement>()
    images.add(image)
    imageViews.set(path, images)
    loadImage(path, image)
    return path
  }

  const setDocument = (content: string) => {
    if (!editor) return
    editor.updateState(EditorState.create({ doc: parseMarkdown(content), plugins: editorPlugins() }))
    syncDocumentState()
  }

  const apply = (source: string, revision: string, draft?: Draft) => {
    const content = draft?.content ?? readMarkdownReview(source).content
    setState({
      persisted: draft?.persisted ?? content,
      content,
      revision: draft?.revision ?? revision,
      dirty: !!draft && draft.content !== draft.persisted,
      conflict: !!draft && draft.revision !== revision,
      activeRevision: -1,
      activeComment: -1,
      commenting: false,
      editingComment: null,
      commentDraft: "",
    })
    setDocument(content)
    props.onReady?.()
  }

  const load = async (discard = false) => {
    if (discard && saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    setState("loading", true)
    try {
      const result = await sdk.client.file.editable({ path: props.path })
      if (!result.data) throw new Error("File content was not returned.")
      if (discard) drafts.delete(key())
      apply(result.data.content, result.data.revision, discard ? undefined : drafts.get(key()))
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("loading", false)
    }
  }

  const save = async (silent = false) => {
    if (!editor || state.saving || state.conflict) return
    const content = serializeMarkdown(editor.state.doc)
    if (content === state.persisted) return

    setState("saving", true)
    let completed = false
    try {
      const result = await sdk.client.file.write({
        path: props.path,
        content,
        expectedRevision: state.revision,
      })
      if (!result.data) throw new Error("Saved file content was not returned.")
      const current = serializeMarkdown(editor.state.doc)
      drafts.delete(key())
      setState({
        persisted: content,
        content: current,
        revision: result.data.revision,
        dirty: current !== content,
        conflict: false,
      })
      completed = true
      if (!silent) showToast({ variant: "success", title: language.t("markdownEditor.review.saved") })
    } catch (error) {
      const current = await sdk.client.file.editable({ path: props.path }).catch(() => undefined)
      if (current?.data?.content === content) {
        drafts.delete(key())
        setState({
          persisted: content,
          content: serializeMarkdown(editor.state.doc),
          revision: current.data.revision,
          dirty: serializeMarkdown(editor.state.doc) !== content,
          conflict: false,
        })
        completed = true
        return
      }
      if (current?.data && current.data.revision !== state.revision) {
        setState("conflict", true)
        return
      }
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("saving", false)
      if (completed && editor && serializeMarkdown(editor.state.doc) !== content) queueSave()
      if (watcherPending) void checkWatcherUpdate()
    }
  }

  const saveCurrentVersion = async () => {
    if (!editor || state.saving) return
    const content = serializeMarkdown(editor.state.doc)
    setState("saving", true)
    try {
      const current = await sdk.client.file.editable({ path: props.path })
      if (!current.data) throw new Error("File content was not returned.")
      const result = await sdk.client.file.write({
        path: props.path,
        content,
        expectedRevision: current.data.revision,
      })
      if (!result.data) throw new Error("Saved file content was not returned.")
      drafts.delete(key())
      setState({ persisted: content, content, revision: result.data.revision, dirty: false, conflict: false })
      showToast({ variant: "success", title: language.t("markdownEditor.review.saved") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setState("saving", false)
      if (watcherPending) void checkWatcherUpdate()
    }
  }

  const queueSave = (delay = 500) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void save(true)
    }, delay)
  }

  const checkWatcherUpdate = async () => {
    if (state.saving || watcherChecking) {
      watcherPending = true
      return
    }

    watcherChecking = true
    watcherPending = false
    try {
      const result = await sdk.client.file.editable({ path: props.path })
      if (!result.data) return
      const action = markdownWatcherAction({
        currentRevision: state.revision,
        diskRevision: result.data.revision,
        currentContent: editor ? serializeMarkdown(editor.state.doc) : state.content,
        persistedContent: state.persisted,
        diskContent: result.data.content,
        dirty: state.dirty,
      })
      if (action === "ignore") return
      if (action === "adopt") {
        drafts.delete(key())
        setState({
          persisted: result.data.content,
          content: result.data.content,
          revision: result.data.revision,
          dirty: false,
          conflict: false,
        })
        return
      }
      if (action === "rebase") {
        setState("revision", result.data.revision)
        if (state.dirty) queueSave()
        return
      }
      if (action === "conflict") {
        setState("conflict", true)
        return
      }
      apply(result.data.content, result.data.revision)
    } catch {
      // The watcher is advisory; normal load and save paths report actionable failures.
    } finally {
      watcherChecking = false
      if (watcherPending) void checkWatcherUpdate()
    }
  }

  const activateReviewMark = (selector: string, position: number) => {
    if (!editor) return
    editor.dom.querySelectorAll(".markdown-review-active").forEach((element) => element.classList.remove("markdown-review-active"))
    const node = editor.domAtPos(Math.min(position, editor.state.doc.content.size)).node
    const element = node instanceof HTMLElement ? node : node.parentElement
    const mark = element?.closest(selector) ?? element?.querySelector(selector)
    mark?.classList.add("markdown-review-active")
    mark?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  const nextRevision = () => {
    if (state.revisions.length === 0) return
    const index = (state.activeRevision + 1) % state.revisions.length
    setState("activeRevision", index)
    activateReviewMark(`[data-review-kind="${state.revisions[index].kind}"]`, state.revisions[index].from)
  }

  const nextComment = () => {
    if (state.comments.length === 0) return
    const index = (state.activeComment + 1) % state.comments.length
    setState("activeComment", index)
    activateReviewMark(`[data-comment-id="${state.comments[index].id}"]`, state.comments[index].from)
  }

  const startComment = () => {
    if (!state.selection) return
    setState({ commenting: true, editingComment: null, commentDraft: "", selectionMenu: null })
    queueGeometry()
    focusCommentInput()
  }

  const focusCommentInput = () => {
    if (commentFocusFrame !== undefined) cancelAnimationFrame(commentFocusFrame)
    commentFocusFrame = requestAnimationFrame(() => {
      commentFocusFrame = undefined
      if (!commentInput?.isConnected) return
      commentInput.focus()
      commentInput.setSelectionRange(commentInput.value.length, commentInput.value.length)
    })
  }

  const restoreDeletion = () => {
    if (!editor || editor.state.selection.empty) return
    editor.dispatch(
      restoreMarkdownDeletion(editor.state.tr, editor.state.selection.from, editor.state.selection.to),
    )
    editor.focus()
  }

  const cancelComment = () => {
    setState({ commenting: false, editingComment: null, commentDraft: "" })
    queueGeometry()
  }

  const submitComment = () => {
    if (!editor || !state.commentDraft.trim()) return
    const existing = state.editingComment ? state.comments.find((comment) => comment.id === state.editingComment) : undefined
    const selection = existing ?? state.selection
    if (!selection) return
    const id = existing?.id ?? uuid()
    const transaction = existing ? removeMarkdownComment(editor.state.tr, existing.id) : editor.state.tr
    editor.dispatch(addMarkdownComment(transaction, selection.from, selection.to, id, state.commentDraft.trim()))
    setState({ commenting: false, editingComment: null, commentDraft: "" })
  }

  const editComment = (comment: MarkdownComment) => {
    setState({ commenting: true, editingComment: comment.id, commentDraft: comment.comment })
    queueGeometry()
    focusCommentInput()
  }

  const deleteComment = (comment: MarkdownComment) => {
    if (!editor) return
    editor.dispatch(removeMarkdownComment(editor.state.tr, comment.id))
    setState({ commenting: false, editingComment: null, commentDraft: "" })
  }

  onMount(() => {
    if (!host) return
    editor = new EditorView(host, {
      state: EditorState.create({ doc: parseMarkdown(""), plugins: editorPlugins() }),
      nodeViews: {
        image(node) {
          const dom = document.createElement("img")
          let path = configureImage(dom, node)
          return {
            dom,
            update(next) {
              if (next.type !== node.type) return false
              path = configureImage(dom, next, path)
              return true
            },
            destroy() {
              unregisterImage(path, dom)
            },
            ignoreMutation: () => true,
          }
        },
      },
      dispatchTransaction(transaction) {
        if (!editor) return
        editor.updateState(editor.state.apply(transaction))
        syncDocumentState()
        if (!transaction.docChanged) return
        const content = serializeMarkdown(editor.state.doc)
        setState({ content, dirty: content !== state.persisted, activeRevision: -1 })
        queueSave()
      },
      handleTextInput(view, from, to, text) {
        view.dispatch(trackedTextInput(view.state, from, to, text))
        return true
      },
      handleClickOn(view, _position, node, nodePosition, _event, direct) {
        if (!direct || node.type.name !== "image") return false
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePosition)))
        view.focus()
        return true
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain")
        if (!text) return false
        view.dispatch(trackedTextInput(view.state, view.state.selection.from, view.state.selection.to, text.replace(/\r?\n+/g, " ")))
        return true
      },
      handleKeyDown(view, event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = undefined
          void save()
          return true
        }
        const direction = event.key === "Backspace" ? -1 : event.key === "Delete" ? 1 : undefined
        if (!direction) return false
        const range = trackedCharacterRange(view.state, direction)
        if (!range) {
          event.preventDefault()
          return true
        }
        event.preventDefault()
        const transaction = trackedDeletion(view.state, range.from, range.to)
        const position = transaction.mapping.map(range.from, 1)
        view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, position)))
        return true
      },
      handleDOMEvents: {
        cut: (view, event) => {
          if (view.state.selection.empty) return false
          event.preventDefault()
          event.clipboardData?.setData("text/plain", view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, "\n"))
          const transaction = trackedDeletion(view.state, view.state.selection.from, view.state.selection.to)
          view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, transaction.mapping.map(view.state.selection.from, 1))))
          return true
        },
        drop: (_view, event) => {
          event.preventDefault()
          return true
        },
        blur: () => {
          setState("selectionMenu", null)
          if (!state.dirty) return false
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = undefined
          void save(true)
          return false
        },
      },
    })
    resizeObserver = new ResizeObserver(queueGeometry)
    resizeObserver.observe(host)
    if (sidebar) resizeObserver.observe(sidebar)
    window.addEventListener("scroll", queueGeometry, true)
    setState("ready", true)
    void load()
  })

  const stop = sdk.event.listen((event) => {
    if (event.details.type !== "file.watcher.updated") return
    const properties = event.details.properties
    const path = file.normalize(properties.file)
    imageViews.get(path)?.forEach((image) => loadImage(path, image))
    if (path !== file.normalize(props.path)) return
    void checkWatcherUpdate()
  })

  onCleanup(() => {
    stop()
    window.removeEventListener("scroll", queueGeometry, true)
    resizeObserver?.disconnect()
    if (geometryFrame !== undefined) cancelAnimationFrame(geometryFrame)
    if (commentFocusFrame !== undefined) cancelAnimationFrame(commentFocusFrame)
    if (saveTimer) clearTimeout(saveTimer)
    if (state.dirty) {
      drafts.set(key(), { persisted: state.persisted, content: state.content, revision: state.revision })
    } else {
      drafts.delete(key())
    }
    imageViews.clear()
    editor?.destroy()
    editor = undefined
  })

  return (
    <div class="markdown-editor relative flex min-h-full flex-col bg-background-base">
      <div class="markdown-editor-header">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <Icon name="edit" class="size-4 text-icon-weak" />
          <span class="truncate text-13-medium text-text-strong">{title()}</span>
          <span class="markdown-review-mode">{language.t("markdownEditor.review.mode")}</span>
        </div>
        <Show when={state.revisions.length > 0}>
          <div class="markdown-review-counts">
            <span data-kind="added">+{additions()}</span>
            <span data-kind="removed">-{deletions()}</span>
          </div>
        </Show>
        <Button variant="ghost" size="small" disabled={state.revisions.length === 0} onClick={nextRevision}>
          {language.t("markdownEditor.review.nextRevision")}
        </Button>
        <Button variant="ghost" size="small" disabled={state.comments.length === 0} onClick={nextComment}>
          {language.t("markdownEditor.review.nextComment")}
        </Button>
        <Button variant="ghost" size="small" disabled={!state.selection} onClick={startComment}>
          {language.t("markdownEditor.review.addComment")}
        </Button>
        <Show when={state.dirty}>
          <span class="markdown-review-autosave">
            {state.saving
              ? language.t("markdownEditor.review.autoSaving")
              : language.t("markdownEditor.review.autoSavePending")}
          </span>
          <Button variant="ghost" size="small" disabled={state.saving} onClick={() => void load(true)}>
            {language.t("markdownEditor.review.discard")}
          </Button>
        </Show>
      </div>

      <Show when={state.conflict}>
        <div class="flex shrink-0 items-center gap-3 border-b border-border-warning-base bg-surface-warning-base px-3 py-2 text-12-regular text-text-strong">
          <span class="flex-1">{language.t("markdownEditor.conflict")}</span>
          <Button variant="primary" size="small" disabled={state.saving} onClick={() => void saveCurrentVersion()}>
            {language.t("markdownEditor.keepMine")}
          </Button>
          <Button variant="secondary" size="small" onClick={() => void load(true)}>
            {language.t("markdownEditor.reload")}
          </Button>
        </div>
      </Show>

      <div class="markdown-review-layout">
        <div class="markdown-document-workspace">
          <div class="markdown-document-page">
            <div class="markdown-document-host" classList={{ invisible: state.loading || !state.ready }} ref={host} />
          </div>
        </div>

        <aside
          class="markdown-comments-sidebar"
          style={{ "min-height": `${state.commentRailHeight}px` }}
          ref={sidebar}
        >
          <Show when={state.commenting}>
            <div class="markdown-comment-editor" data-comment-editor style={{ top: `${state.commentEditorTop}px` }}>
              <textarea
                ref={commentInput}
                value={state.commentDraft}
                placeholder={language.t("markdownEditor.review.commentPlaceholder")}
                onInput={(event) => {
                  setState("commentDraft", event.currentTarget.value)
                  queueGeometry()
                }}
              />
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="small" onClick={cancelComment}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" size="small" disabled={!state.commentDraft.trim()} onClick={submitComment}>
                  {language.t("ui.lineComment.submit")}
                </Button>
              </div>
            </div>
          </Show>
          <For each={state.comments}>
            {(comment, index) => (
              <Show when={state.editingComment !== comment.id}>
                <div
                  role="button"
                  tabIndex={0}
                  class="markdown-comment-card"
                  data-comment-card-id={comment.id}
                  style={{ top: `${state.commentTops[comment.id] ?? 12}px` }}
                  classList={{ "markdown-review-active": state.activeComment === index() }}
                  onClick={() => {
                    setState("activeComment", index())
                    activateReviewMark(`[data-comment-id="${comment.id}"]`, comment.from)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    setState("activeComment", index())
                    activateReviewMark(`[data-comment-id="${comment.id}"]`, comment.from)
                  }}
                >
                  <span class="markdown-comment-quote">{comment.quote}</span>
                  <span>{comment.comment}</span>
                  <span class="markdown-comment-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        editComment(comment)
                      }}
                    >
                      {language.t("common.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        deleteComment(comment)
                      }}
                    >
                      {language.t("common.delete")}
                    </button>
                  </span>
                </div>
              </Show>
            )}
          </For>
        </aside>
      </div>

      <Show when={state.selectionMenu}>
        {(menu) => (
          <div
            class="markdown-selection-actions"
            style={{ left: `${menu().left}px`, top: `${menu().top}px` }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <button type="button" onClick={startComment}>
              <Icon name="comment" class="size-3.5" />
              {language.t("markdownEditor.review.addComment")}
            </button>
            <Show when={menu().restoreDeletion}>
              <button type="button" onClick={restoreDeletion}>
                <Icon name="arrow-undo-down" class="size-3.5" />
                {language.t("markdownEditor.review.restoreDeletion")}
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={state.loading}>
        <div class="absolute inset-0 grid place-items-center bg-background-base/70 text-13-regular text-text-weak">
          {language.t("common.loading")}
          {language.t("common.loading.ellipsis")}
        </div>
      </Show>
    </div>
  )
}
