import { create } from "zustand"
import type { ChartToolPayload, DisplayAttachment } from "../../shared/display-tools"
import type { ChatAttachment } from "../../shared/types"
import { settledChatViewer, useRightSidebarStore, type ChatViewerState } from "./rightSidebarStore"

/**
 * The one viewer: what the elevated card beside (or over) the chat is
 * showing, if anything. A changed file's diff, an attachment, or a chart at
 * full size all open here, so they share one surface, one chrome and one set
 * of keys, and nothing else in the app keeps a modal of its own for them.
 *
 * Each chat has its own, kept with the rest of the page's pane layout in the
 * right sidebar store (`chatViewers`), which is what survives a chat switch
 * and a reload. This store only knows which chat the page is showing, so
 * the ones who open a file from deep in the transcript needn't.
 */

/** An attachment from anywhere (the composer, a prompt, an agent's send), in one shape. */
export interface ViewerAttachment {
  url: string
  name: string
  mimeType: string
  size: number | null
}

export type ViewerItem =
  | { kind: "diff"; projectId: string; path: string }
  /** A file in the project, as it is on disk: `path` relative to the project, `line` to jump to. */
  | { kind: "file"; projectId: string; path: string; line?: number }
  | { kind: "attachment"; attachment: ViewerAttachment }
  | { kind: "chart"; payload: ChartToolPayload }

/** The page with no chat yet has a viewer too, just not one worth keeping. */
function chatKeyOf(chatId: string | null) {
  return chatId ?? ""
}

interface ViewerState {
  /** Whose viewer is showing: the chat the page is on. */
  chatKey: string
  /**
   * Counts opens, so opening the same file again (a click on the Changes row
   * you already opened, after scrolling away from it) still jumps back to it.
   */
  openCount: number
  setChat: (chatId: string | null) => void
  open: (item: ViewerItem) => void
  close: () => void
  setScrolledDiffPath: (path: string | null) => void
  toggleExpanded: () => void
  /** The width you dragged the pane to, kept for this chat. */
  setWidth: (widthPx: number) => void
}

function currentViewer(chatKey: string) {
  return useRightSidebarStore.getState().chatViewers[chatKey] ?? null
}

function updateViewer(chatKey: string, update: (viewer: ChatViewerState) => ChatViewerState) {
  const viewer = currentViewer(chatKey)
  if (!viewer) return
  const next = update(viewer)
  if (next !== viewer) useRightSidebarStore.getState().setChatViewer(chatKey, next)
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  chatKey: "",
  openCount: 0,
  setChat: (chatId) => {
    const chatKey = chatKeyOf(chatId)
    const leaving = get().chatKey
    if (chatKey === leaving) return
    // The chat you're leaving reopens where its review had got to.
    updateViewer(leaving, settledChatViewer)
    set({ chatKey })
  },
  open: (item) => {
    const { chatKey } = get()
    const current = currentViewer(chatKey)
    // A dragged width holds while you look at things of one kind: a review
    // and a preview each open at their own width.
    const sameKind = current !== null && (current.item.kind === "diff") === (item.kind === "diff")
    useRightSidebarStore.getState().setChatViewer(chatKey, {
      item,
      expanded: current?.expanded ?? false,
      ...(sameKind && current.widthPx !== undefined ? { widthPx: current.widthPx } : {}),
    })
    set((state) => ({ openCount: state.openCount + 1 }))
  },
  close: () => useRightSidebarStore.getState().setChatViewer(get().chatKey, null),
  setScrolledDiffPath: (path) => updateViewer(get().chatKey, (viewer) => (
    viewer.item.kind !== "diff" || (viewer.reviewPath ?? null) === path
      ? viewer
      : { ...viewer, reviewPath: path ?? undefined }
  )),
  toggleExpanded: () => updateViewer(get().chatKey, (viewer) => ({ ...viewer, expanded: !viewer.expanded })),
  setWidth: (widthPx) => updateViewer(get().chatKey, (viewer) => (
    viewer.widthPx === widthPx ? viewer : { ...viewer, widthPx }
  )),
}))

export function openViewer(item: ViewerItem) {
  useViewerStore.getState().open(item)
}

/** What the page's chat has open in the viewer, and how, or null. */
export function useChatViewer(): ChatViewerState | null {
  const chatKey = useViewerStore((store) => store.chatKey)
  return useRightSidebarStore((store) => store.chatViewers[chatKey] ?? null)
}

/** The same, read once. */
export function getChatViewer(): ChatViewerState | null {
  return currentViewer(useViewerStore.getState().chatKey)
}

export function viewerAttachmentFromChat(attachment: ChatAttachment): ViewerAttachment {
  return { url: attachment.contentUrl, name: attachment.displayName, mimeType: attachment.mimeType, size: attachment.size }
}

export function viewerAttachmentFromDisplay(attachment: DisplayAttachment): ViewerAttachment {
  return { url: attachment.url, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }
}

/**
 * The file the viewer's diff list is on, in this project, or null: the one
 * scrolled to, else the one opened. The Changes card lights it, so the two
 * move together.
 */
export function useReviewedPath(projectId: string | null) {
  const viewer = useChatViewer()
  return projectId && viewer?.item.kind === "diff" && viewer.item.projectId === projectId
    ? viewer.reviewPath ?? viewer.item.path
    : null
}
