import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_RIGHT_SIDEBAR_SIZE, persistedChatViewers, useRightSidebarStore } from "./rightSidebarStore"
import { getChatViewer, openViewer, useViewerStore } from "./viewerStore"

const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const
const DIFF = { kind: "diff", projectId: "p1", path: "src/a.ts" } as const

describe("viewerStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {} })
    useViewerStore.setState({ chatKey: "", openCount: 0 })
    useViewerStore.getState().setChat("chat-1")
  })

  test("each chat keeps its own viewer, expanded state and width", () => {
    openViewer(FILE)
    useViewerStore.getState().toggleExpanded()
    useViewerStore.getState().setWidth(700)

    useViewerStore.getState().setChat("chat-2")
    expect(getChatViewer()).toBeNull()

    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()).toEqual({ item: FILE, expanded: true, widthPx: 700 })
  })

  test("a dragged width holds within a kind and resets across review and preview", () => {
    openViewer(FILE)
    useViewerStore.getState().setWidth(700)
    openViewer({ ...FILE, path: "docs/b.md" })
    expect(getChatViewer()?.widthPx).toBe(700)
    openViewer(DIFF)
    expect(getChatViewer()?.widthPx).toBeUndefined()
  })

  test("a review left for another chat reopens at the file it was scrolled to", () => {
    openViewer(DIFF)
    useViewerStore.getState().setScrolledDiffPath("src/b.ts")
    expect(getChatViewer()?.item).toEqual(DIFF)

    useViewerStore.getState().setChat("chat-2")
    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()?.item).toEqual({ ...DIFF, path: "src/b.ts" })
  })

  test("closing clears only this chat's viewer", () => {
    openViewer(FILE)
    useViewerStore.getState().setChat("chat-2")
    openViewer(DIFF)
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()
    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()?.item).toEqual(FILE)
  })

  test("keeps across a reload what can come back, a review at its scrolled file", () => {
    expect(persistedChatViewers({
      "chat-1": { item: DIFF, expanded: false, reviewPath: "src/b.ts" },
      "chat-2": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: false },
      "chat-3": { item: { kind: "attachment", attachment: { url: "blob:abc", name: "a.png", mimeType: "image/png", size: 1 } }, expanded: false },
      "": { item: FILE, expanded: false },
      "chat-4": { item: FILE, expanded: true, widthPx: 640 },
    })).toEqual({
      "chat-1": { item: { ...DIFF, path: "src/b.ts" }, expanded: false },
      "chat-4": { item: FILE, expanded: true, widthPx: 640 },
    })
  })
})
