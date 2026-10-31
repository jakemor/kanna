import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_RIGHT_SIDEBAR_SIZE, persistedChatViewers, persistedRightSidebarState, useRightSidebarStore } from "./rightSidebarStore"
import { getChatViewer, openViewer, useViewerStore } from "./viewerStore"

const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const
const DIFF = { kind: "diff", projectId: "p1", path: "src/a.ts" } as const
const CHAT = { kind: "chat", chatId: "sub-1" } as const
const VISUALIZATION = { kind: "visualization", artifact: { type: "visualization", version: 1, title: "Signups", height: 360, url: "/api/chats/chat-1/media/visualization-abc.html" } } as const
const IMAGE = { kind: "attachment", attachment: { url: "/media/a.png", name: "a.png", mimeType: "image/png", size: 1 } } as const

describe("viewerStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {}, viewerWidthPx: null })
    useViewerStore.setState({ chatKey: "", openCount: 0, chatJump: null, liveChatId: null, floor: null })
    useViewerStore.getState().setChat("chat-1")
  })

  test("each chat keeps its own viewer and expanded state", () => {
    openViewer(FILE)
    useViewerStore.getState().toggleExpanded()

    useViewerStore.getState().setChat("chat-2")
    expect(getChatViewer()).toBeNull()

    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()).toEqual({ item: FILE, expanded: true })
  })

  test("stepping to another attachment keeps the pane as it is: expanded, with its way back", () => {
    const NEXT = { kind: "attachment", attachment: { url: "/media/b.png", name: "b.png", mimeType: "image/png", size: 1 } } as const
    openViewer(CHAT)
    openViewer(IMAGE, { expanded: true })
    const before = getChatViewer()
    useViewerStore.getState().replace(NEXT)
    expect(getChatViewer()).toEqual({ ...before!, item: NEXT })
    expect(useViewerStore.getState().changedByKey).toBe(true)
    useViewerStore.getState().close()
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false })
  })

  test("a width dragged in one chat is the width in every chat, and stays when the pane is shut", () => {
    openViewer(FILE)
    useViewerStore.getState().setWidth(700)
    useViewerStore.getState().setChat("chat-2")
    openViewer(DIFF)
    expect(useRightSidebarStore.getState().viewerWidthPx).toBe(700)
    useViewerStore.getState().setWidth(560)
    useViewerStore.getState().close()
    useViewerStore.getState().setChat("chat-1")
    expect(useRightSidebarStore.getState().viewerWidthPx).toBe(560)
    expect(getChatViewer()).toEqual({ item: FILE, expanded: false })
  })

  test("the width is kept across a reload, with the viewers", () => {
    useViewerStore.getState().setWidth(640)
    expect(persistedRightSidebarState(useRightSidebarStore.getState())).toMatchObject({ viewerWidthPx: 640 })
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
      "chat-4": { item: FILE, expanded: true },
    })).toEqual({
      "chat-1": { item: { ...DIFF, path: "src/b.ts" }, expanded: false },
      "chat-4": { item: FILE, expanded: true },
    })
  })

  test("a chat opened over a file arrives in the pane as it stands", () => {
    openViewer(FILE)
    openViewer(CHAT)
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false })
  })

  test("closing what opened over a chat preview goes back to the chat", () => {
    openViewer(CHAT)
    openViewer(IMAGE)
    openViewer(FILE)
    expect(getChatViewer()?.item).toEqual(FILE)

    useViewerStore.getState().close()
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false })
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()
  })

  test("another chat replaces a preview outright, and closeAll shuts the pane", () => {
    openViewer(CHAT)
    openViewer({ kind: "chat", chatId: "sub-2" })
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()

    openViewer(CHAT)
    openViewer(IMAGE)
    useViewerStore.getState().closeAll()
    expect(getChatViewer()).toBeNull()
  })

  test("a chat preview comes back after a reload, also from under a chart", () => {
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false },
      "chat-2": {
        item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } },
        expanded: true,
        returnTo: { item: CHAT },
      },
    })).toEqual({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false },
      "chat-2": { item: CHAT, expanded: true },
    })
  })

  test("a visualization opens expanded and gives the pane back as it was", () => {
    // From a closed pane: expanded, and closing leaves nothing behind.
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()).toEqual({ item: VISUALIZATION, expanded: true, expandedBefore: false })
    useViewerStore.getState().close()
    openViewer(FILE)
    expect(getChatViewer()).toEqual({ item: FILE, expanded: false })
    useViewerStore.getState().closeAll()

    // Over a docked chat preview: closing goes back to the chat, docked.
    openViewer(CHAT)
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()?.expanded).toBe(true)
    useViewerStore.getState().close()
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false })

    // Something else opened in its place is not left over the chat either.
    openViewer(VISUALIZATION, { expanded: true })
    openViewer(IMAGE)
    expect(getChatViewer()).toMatchObject({ item: IMAGE, expanded: false })
  })

  test("collapsing or expanding a visualization yourself is the pane's setting from then on", () => {
    openViewer(CHAT)
    openViewer(VISUALIZATION, { expanded: true })
    useViewerStore.getState().toggleExpanded()
    expect(getChatViewer()).toMatchObject({ item: VISUALIZATION, expanded: false })
    expect(getChatViewer()).not.toHaveProperty("expandedBefore")
    useViewerStore.getState().toggleExpanded()
    useViewerStore.getState().close()
    expect(getChatViewer()).toMatchObject({ item: CHAT, expanded: true })
  })

  test("a pane already expanded stays so under a visualization, and it survives a reload", () => {
    openViewer(FILE)
    useViewerStore.getState().toggleExpanded()
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()).toEqual({ item: VISUALIZATION, expanded: true })
    expect(persistedChatViewers({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } }))
      .toEqual({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } })
    // A chart does not come back, and the chat under it comes back docked.
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: true, expandedBefore: false, returnTo: { item: CHAT } },
    })).toEqual({ "chat-1": { item: CHAT, expanded: false } })
  })

  test("a jump for the previewed chat is one-shot and dropped with the page's chat", () => {
    useViewerStore.getState().setChatJump("sub-1", "reply")
    const jump = useViewerStore.getState().chatJump
    expect(jump).toMatchObject({ chatId: "sub-1", target: "reply" })
    useViewerStore.getState().clearChatJump("another-request")
    expect(useViewerStore.getState().chatJump).toBe(jump)
    useViewerStore.getState().clearChatJump(jump!.requestId)
    expect(useViewerStore.getState().chatJump).toBeNull()

    useViewerStore.getState().setChatJump("sub-1", "prompt")
    useViewerStore.getState().setChat("chat-2")
    expect(useViewerStore.getState().chatJump).toBeNull()
  })

  describe("on a delegator, whose pane has a floor", () => {
    const LIST = { kind: "delegated", chatId: "chat-1" } as const
    // The page sets the floor, and the navbar's button opens the list.
    const openOnList = () => {
      useViewerStore.getState().setFloor(LIST)
      openViewer(LIST)
    }

    test("setting the floor leaves the pane as it was", () => {
      useViewerStore.getState().setFloor(LIST)
      expect(getChatViewer()).toBeNull()

      openViewer(FILE)
      useViewerStore.getState().setFloor(null)
      useViewerStore.getState().setFloor(LIST)
      expect(getChatViewer()?.item).toEqual(FILE)
    })

    test("Escape steps down one level at a time: to the list, then shut", () => {
      openOnList()
      openViewer(CHAT)
      openViewer({ kind: "chat", chatId: "sub-2", back: ["sub-1"] })
      openViewer(IMAGE)

      useViewerStore.getState().close()
      expect(getChatViewer()?.item).toEqual({ kind: "chat", chatId: "sub-2", back: ["sub-1"] })
      useViewerStore.getState().close()
      expect(getChatViewer()?.item).toEqual(CHAT)
      useViewerStore.getState().close()
      expect(getChatViewer()?.item).toEqual(LIST)
      useViewerStore.getState().close()
      expect(getChatViewer()).toBeNull()
    })

    test("the Close button shuts the pane from any level", () => {
      openOnList()
      openViewer(CHAT)
      openViewer(IMAGE)
      useViewerStore.getState().shut()
      expect(getChatViewer()).toBeNull()
    })

    test("something opened while the pane is shut still has the list under it", () => {
      useViewerStore.getState().setFloor(LIST)
      openViewer(CHAT)
      useViewerStore.getState().stepBack()
      expect(getChatViewer()?.item).toEqual(LIST)
    })

    test("a shut pane stays shut when the page sets its floor again", () => {
      openOnList()
      useViewerStore.getState().shut()
      useViewerStore.getState().setFloor(LIST)
      expect(getChatViewer()).toBeNull()
    })

    test("a file opened over the list goes back to the list", () => {
      openOnList()
      openViewer(FILE)
      useViewerStore.getState().close()
      expect(getChatViewer()).toEqual({ item: LIST, expanded: false })
    })

    test("a chat picked from the list goes back to it", () => {
      openOnList()
      openViewer({ kind: "chat", chatId: "sub-1", delegated: "chat-1" })
      useViewerStore.getState().stepBack()
      expect(getChatViewer()).toEqual({ item: LIST, expanded: false })
    })

    test("content that is gone leaves the list, not a shut pane", () => {
      openOnList()
      openViewer(CHAT)
      openViewer(IMAGE)
      useViewerStore.getState().closeAll()
      expect(getChatViewer()?.item).toEqual(LIST)
    })

    test("taking the floor away shuts a pane that held only it, and leaves anything else", () => {
      openOnList()
      useViewerStore.getState().setFloor(null)
      expect(getChatViewer()).toBeNull()

      openOnList()
      openViewer(CHAT)
      useViewerStore.getState().setFloor(null)
      expect(getChatViewer()?.item).toEqual(CHAT)
      // And with no floor, close shuts the pane.
      useViewerStore.getState().close()
      expect(getChatViewer()).toBeNull()
    })
  })

  describe("stepBack with no floor", () => {
    test("goes back along a chat's trail and then shuts the pane", () => {
      openViewer({ kind: "chat", chatId: "sub-2", back: ["sub-1"] })
      useViewerStore.getState().stepBack()
      expect(getChatViewer()?.item).toEqual(CHAT)
      useViewerStore.getState().stepBack()
      expect(getChatViewer()).toBeNull()
    })

    test("a chat picked from a delegator's list on a phone goes back to the list, which closes", () => {
      openViewer({ kind: "delegated", chatId: "chat-1" })
      openViewer({ kind: "chat", chatId: "sub-1", delegated: "chat-1" })
      useViewerStore.getState().stepBack()
      expect(getChatViewer()?.item).toEqual({ kind: "delegated", chatId: "chat-1" })
      useViewerStore.getState().close()
      expect(getChatViewer()).toBeNull()
    })
  })
})

