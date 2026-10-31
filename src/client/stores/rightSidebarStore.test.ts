import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  migrateRightSidebarStore,
  persistedChatViewers,
  RIGHT_SIDEBAR_MAX_WIDTH_PX,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "./rightSidebarStore"

const PROJECT_ID = "project-1"

describe("rightSidebarStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {} })
  })

  test("widgets start closed with the default size", () => {
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.widgetsOpen ?? false).toBe(false)
    expect(useRightSidebarStore.getState().size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })

  test("toggling is per project; size is shared", () => {
    useRightSidebarStore.getState().toggleWidgets(PROJECT_ID)
    useRightSidebarStore.getState().setSize(430)

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({ widgetsOpen: true })
    expect(useRightSidebarStore.getState().projects["project-2"]).toBeUndefined()
    expect(useRightSidebarStore.getState().size).toBe(430)

    useRightSidebarStore.getState().toggleWidgets(PROJECT_ID)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({ widgetsOpen: false })
  })

  test("open and hide are idempotent", () => {
    const store = useRightSidebarStore.getState()
    store.openWidgets(PROJECT_ID)
    store.openWidgets(PROJECT_ID)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({ widgetsOpen: true })
    store.hideWidgets(PROJECT_ID)
    store.hideWidgets(PROJECT_ID)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({ widgetsOpen: false })
  })

  test("a chat key keeps each chat's state apart from the project's and from other chats", () => {
    const store = useRightSidebarStore.getState()
    store.toggleWidgets(PROJECT_ID, "chat-a")

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({ widgetsOpen: false, chats: { "chat-a": true } })

    store.toggleWidgets(PROJECT_ID)
    store.hideWidgets(PROJECT_ID, "chat-a")
    store.openWidgets(PROJECT_ID, "chat-b")
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({
      widgetsOpen: true,
      chats: { "chat-a": false, "chat-b": true },
    })

    store.clearProject(PROJECT_ID)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toBeUndefined()
  })

  test("clamps the size between the minimum and the left sidebar's maximum", () => {
    useRightSidebarStore.getState().setSize(100)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)

    useRightSidebarStore.getState().setSize(480)
    expect(useRightSidebarStore.getState().size).toBe(480)

    useRightSidebarStore.getState().setSize(900)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MAX_WIDTH_PX)
  })

  test("clearProject drops a project's state but keeps the shared size", () => {
    useRightSidebarStore.getState().toggleWidgets(PROJECT_ID)
    useRightSidebarStore.getState().setSize(440)
    useRightSidebarStore.getState().setWidgetExpanded(PROJECT_ID, "changes", true)
    useRightSidebarStore.getState().clearProject(PROJECT_ID)

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toBeUndefined()
    expect(useRightSidebarStore.getState().projectUi[PROJECT_ID]).toBeUndefined()
    expect(useRightSidebarStore.getState().size).toBe(440)
  })

  test("keeps widget ui state isolated per project", () => {
    useRightSidebarStore.getState().setWidgetExpanded(PROJECT_ID, "changes", true)
    useRightSidebarStore.getState().setCommitDraft(PROJECT_ID, { summary: "feat: one", description: "body" })

    useRightSidebarStore.getState().setCommitDraft("project-2", { summary: "feat: two", description: "" })

    expect(useRightSidebarStore.getState().projectUi[PROJECT_ID]).toEqual({
      expanded: { changes: true },
      summary: "feat: one",
      description: "body",
    })
    expect(useRightSidebarStore.getState().projectUi["project-2"]).toEqual({
      expanded: {},
      summary: "feat: two",
      description: "",
    })
  })

  describe("migration to widgets (v8)", () => {
    test("any open panel, or the legacy isVisible flag, means the widgets are open", () => {
      const migrated = migrateRightSidebarStore({
        projects: {
          git: { rightPanel: "git" },
          browser: { rightPanel: "browser" },
          hidden: { rightPanel: "hidden" },
          legacyOpen: { isVisible: true, size: 34 },
          legacyClosed: { isVisible: false, size: 26 },
        },
      }, 7)

      expect(migrated.projects).toEqual({
        git: { widgetsOpen: true },
        browser: { widgetsOpen: true },
        hidden: { widgetsOpen: false },
        legacyOpen: { widgetsOpen: true },
        legacyClosed: { widgetsOpen: false },
      })
    })

    test("keeps the commit draft; drops collapsed paths, the history picker and the browser", () => {
      const migrated = migrateRightSidebarStore({
        projects: {},
        projectUi: {
          [PROJECT_ID]: {
            viewMode: "changes",
            collapsedPaths: { "a.ts": false },
            summary: "feat: one",
            description: "body",
          },
        },
        projectBrowser: { [PROJECT_ID]: { address: "http://localhost:3000" } },
      }, 7)

      expect(migrated).toEqual({
        size: DEFAULT_RIGHT_SIDEBAR_SIZE,
        projects: {},
        projectUi: {
          [PROJECT_ID]: {
            expanded: {},
            summary: "feat: one",
            description: "body",
          },
        },
        chatViewers: {},
        viewerWidthPx: null,
      })
    })

    test("v10 keeps one viewer width for every chat, and drops each chat's own", () => {
      const v9 = migrateRightSidebarStore({
        size: 420,
        chatViewers: {
          "chat-1": { item: { kind: "chat", chatId: "a" }, expanded: false, widthPx: 520 },
          "chat-2": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, widthPx: 700, returnTo: { item: { kind: "chat", chatId: "b" }, widthPx: 480 } },
        },
      }, 9)
      expect(v9.chatViewers).toEqual({
        "chat-1": { item: { kind: "chat", chatId: "a" }, expanded: false },
        "chat-2": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "chat", chatId: "b" } } },
      })
      expect(v9.viewerWidthPx).toBeNull()
      expect(migrateRightSidebarStore({ size: 420, viewerWidthPx: 640 }, 10).viewerWidthPx).toBe(640)
    })

    test("v11 opens a ticket left open as its delegator's pane, and a chat forgets its ticket", () => {
      const v10 = migrateRightSidebarStore({
        size: 420,
        chatViewers: {
          "deleg": { item: { kind: "ticket", chatId: "deleg", ticketId: "tk_00000d" }, expanded: false },
          "deleg-2": { item: { kind: "chat", chatId: "a", delegated: "deleg-2", ticket: "tk_00000e" }, expanded: false },
          "chat-3": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "ticket", chatId: "deleg", ticketId: "tk_00000d" } } },
        },
      }, 10)
      expect(v10.chatViewers).toEqual({
        "deleg": { item: { kind: "delegated", chatId: "deleg" }, expanded: false },
        "deleg-2": { item: { kind: "chat", chatId: "a", delegated: "deleg-2" }, expanded: false },
        "chat-3": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "delegated", chatId: "deleg" } } },
      })
    })

    test("keeps a v7 pixel width but resets an older percentage", () => {
      expect(migrateRightSidebarStore({ size: 520 }, 7).size).toBe(520)
      expect(migrateRightSidebarStore({ size: 44 }, 6).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
      expect(migrateRightSidebarStore(null).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
    })
  })
})

describe("persistedChatViewers", () => {
  const attachment = (name: string, mimeType: string) => ({
    item: { kind: "attachment" as const, attachment: { url: `/api/chats/c1/media/${name}`, name, mimeType, size: 1 } },
    expanded: false,
  })

  // A reload must never reopen something that downloads on mount.
  test("keeps an attachment the viewer shows, and drops one it would only download", () => {
    const kept = persistedChatViewers({ shot: attachment("a.png", "image/png"), zip: attachment("a.tar.gz", "application/gzip") })
    expect(Object.keys(kept)).toEqual(["shot"])
  })

  test("a dropped attachment falls back to what it was opened over", () => {
    const chat = { item: { kind: "chat" as const, chatId: "sub" }, expanded: false }
    const kept = persistedChatViewers({ zip: { ...attachment("a.tar.gz", "application/gzip"), returnTo: chat } as never })
    expect(kept.zip?.item).toEqual(chat.item)
  })
})
