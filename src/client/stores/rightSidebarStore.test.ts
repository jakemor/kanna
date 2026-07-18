import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  getDefaultRightSidebarVisibilityState,
  migrateRightSidebarStore,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "./rightSidebarStore"

const PROJECT_ID = "project-1"

describe("rightSidebarStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, projectBrowser: {} })
  })

  test("defaults to a closed drawer", () => {
    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.rightPanel).toBe("hidden")
    expect(useRightSidebarStore.getState().size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })

  test("exports the expected pixel min width", () => {
    expect(RIGHT_SIDEBAR_MIN_WIDTH_PX).toBe(370)
  })

  test("keeps visibility isolated per project while sharing width", () => {
    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "git")
    useRightSidebarStore.getState().setSize(430)
    useRightSidebarStore.getState().togglePanel("project-2", "browser")

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({
      rightPanel: "git",
    })
    expect(useRightSidebarStore.getState().projects["project-2"]).toEqual({
      rightPanel: "browser",
    })
    expect(useRightSidebarStore.getState().size).toBe(430)
  })

  test("only one right panel is active per project", () => {
    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "git")
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.rightPanel).toBe("git")

    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "browser")
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.rightPanel).toBe("browser")

    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "browser")
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.rightPanel).toBe("hidden")
  })

  test("clamps resized widths", () => {
    useRightSidebarStore.getState().setSize(100)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)

    useRightSidebarStore.getState().setSize(560)
    expect(useRightSidebarStore.getState().size).toBe(560)
  })

  test("clearing a project removes its saved drawer state without resetting global width", () => {
    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "git")
    useRightSidebarStore.getState().setSize(440)
    useRightSidebarStore.getState().setViewMode(PROJECT_ID, "changes")
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "localhost:3000")
    useRightSidebarStore.getState().clearProject(PROJECT_ID)

    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.rightPanel).toBe("hidden")
    expect(useRightSidebarStore.getState().size).toBe(440)
    expect(useRightSidebarStore.getState().projectUi[PROJECT_ID]).toBeUndefined()
    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]).toBeUndefined()
  })

  test("migration preserves per-project visibility and resets width to the pixel default", async () => {
    const migrated = await migrateRightSidebarStore({
        projects: {
          [PROJECT_ID]: {
            isVisible: true,
            size: 34,
          },
          "project-2": {
            isVisible: false,
            size: 26,
          },
        },
      })

    expect(migrated).toEqual({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {
        [PROJECT_ID]: {
          rightPanel: "git",
        },
        "project-2": {
          rightPanel: "hidden",
        },
      },
      projectUi: {},
      projectBrowser: {},
    })
  })

  test("migration preserves persisted right panel choices", async () => {
    const migrated = await migrateRightSidebarStore({
      projects: {
        [PROJECT_ID]: {
          rightPanel: "browser",
        },
      },
    })

    expect(migrated).toEqual({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {
        [PROJECT_ID]: {
          rightPanel: "browser",
        },
      },
      projectUi: {},
      projectBrowser: {},
    })
  })

  test("keeps browser state isolated per project", () => {
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "localhost:3000")
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "http://localhost:3001")
    useRightSidebarStore.getState().setBrowserZoom(PROJECT_ID, 1.25)

    useRightSidebarStore.getState().navigateBrowser("project-2", "localhost:4000")

    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]).toEqual({
      address: "http://localhost:3001",
      history: ["http://localhost:3000", "http://localhost:3001"],
      historyIndex: 1,
      zoom: 1.3,
    })
    expect(useRightSidebarStore.getState().projectBrowser["project-2"]).toEqual({
      address: "http://localhost:4000",
      history: ["http://localhost:4000"],
      historyIndex: 0,
      zoom: 1,
    })
  })

  test("keeps sidebar ui state isolated per project", () => {
    useRightSidebarStore.getState().setViewMode(PROJECT_ID, "changes")
    useRightSidebarStore.getState().setCommitDraft(PROJECT_ID, { summary: "feat: one", description: "body" })
    useRightSidebarStore.getState().reconcileCollapsedPaths(PROJECT_ID, ["a.ts"])
    useRightSidebarStore.getState().toggleCollapsedPath(PROJECT_ID, "a.ts")

    useRightSidebarStore.getState().setViewMode("project-2", "history")
    useRightSidebarStore.getState().setCommitDraft("project-2", { summary: "feat: two", description: "" })

    expect(useRightSidebarStore.getState().projectUi[PROJECT_ID]).toEqual({
      viewMode: "changes",
      summary: "feat: one",
      description: "body",
      collapsedPaths: { "a.ts": false },
    })
    expect(useRightSidebarStore.getState().projectUi["project-2"]).toEqual({
      viewMode: "history",
      summary: "feat: two",
      description: "",
      collapsedPaths: {},
    })
  })

  test("migration resets persisted global size and preserves project ui", async () => {
    const migrated = await migrateRightSidebarStore({
      size: 44,
      projects: {
        [PROJECT_ID]: {
          isVisible: true,
          size: 34,
        },
      },
      projectUi: {
        [PROJECT_ID]: {
          viewMode: "changes",
          collapsedPaths: { "a.ts": false },
          summary: "feat: one",
          description: "body",
        },
      },
    })

    expect(migrated).toEqual({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {
        [PROJECT_ID]: {
          rightPanel: "git",
        },
      },
      projectUi: {
        [PROJECT_ID]: {
          viewMode: "changes",
          collapsedPaths: { "a.ts": false },
          summary: "feat: one",
          description: "body",
        },
      },
      projectBrowser: {},
    })
  })
})
