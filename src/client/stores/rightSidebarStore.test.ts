import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  migrateRightSidebarStore,
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

  test("clamps the size to the minimum width", () => {
    useRightSidebarStore.getState().setSize(100)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)

    useRightSidebarStore.getState().setSize(560)
    expect(useRightSidebarStore.getState().size).toBe(560)
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
      })
    })

    test("keeps a v7 pixel width but resets an older percentage", () => {
      expect(migrateRightSidebarStore({ size: 520 }, 7).size).toBe(520)
      expect(migrateRightSidebarStore({ size: 44 }, 6).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
      expect(migrateRightSidebarStore(null).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
    })
  })
})
