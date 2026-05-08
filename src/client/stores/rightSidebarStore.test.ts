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
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {} })
  })

  test("defaults to a closed drawer", () => {
    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.isVisible).toBe(false)
    expect(useRightSidebarStore.getState().size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })

  test("exports the expected pixel min width", () => {
    expect(RIGHT_SIDEBAR_MIN_WIDTH_PX).toBe(370)
  })

  test("keeps visibility isolated per project while sharing width", () => {
    useRightSidebarStore.getState().toggleVisibility(PROJECT_ID)
    useRightSidebarStore.getState().setSize(430)
    useRightSidebarStore.getState().toggleVisibility("project-2")

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({
      isVisible: true,
    })
    expect(useRightSidebarStore.getState().projects["project-2"]).toEqual({
      isVisible: true,
    })
    expect(useRightSidebarStore.getState().size).toBe(430)
  })

  test("clamps resized widths", () => {
    useRightSidebarStore.getState().setSize(100)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)

    useRightSidebarStore.getState().setSize(560)
    expect(useRightSidebarStore.getState().size).toBe(560)
  })

  test("clearing a project removes its saved drawer state without resetting global width", () => {
    useRightSidebarStore.getState().toggleVisibility(PROJECT_ID)
    useRightSidebarStore.getState().setSize(440)
    useRightSidebarStore.getState().setViewMode(PROJECT_ID, "changes")
    useRightSidebarStore.getState().clearProject(PROJECT_ID)

    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.isVisible).toBe(false)
    expect(useRightSidebarStore.getState().size).toBe(440)
    expect(useRightSidebarStore.getState().projectUi[PROJECT_ID]).toBeUndefined()
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
          isVisible: true,
        },
        "project-2": {
          isVisible: false,
        },
      },
      projectUi: {},
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
          isVisible: true,
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
  })
})
