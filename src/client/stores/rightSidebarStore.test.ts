import { beforeEach, describe, expect, test } from "bun:test"
import { getDefaultProjectRightSidebarLayout, migrateRightSidebarStore, RIGHT_SIDEBAR_MIN_WIDTH_PX, useRightSidebarStore } from "./rightSidebarStore"

const PROJECT_ID = "project-1"

describe("rightSidebarStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ projects: {} })
  })

  test("defaults to a closed drawer", () => {
    const layout = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultProjectRightSidebarLayout()
    expect(layout.isVisible).toBe(false)
    expect(layout.size).toBe(33)
  })

  test("exports the expected pixel min width", () => {
    expect(RIGHT_SIDEBAR_MIN_WIDTH_PX).toBe(370)
  })

  test("keeps layouts isolated per project", () => {
    useRightSidebarStore.getState().toggleVisibility(PROJECT_ID)
    useRightSidebarStore.getState().setSize(PROJECT_ID, 34)
    useRightSidebarStore.getState().toggleVisibility("project-2")
    useRightSidebarStore.getState().setSize("project-2", 26)

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({
      isVisible: true,
      size: 34,
    })
    expect(useRightSidebarStore.getState().projects["project-2"]).toEqual({
      isVisible: true,
      size: 26,
    })
  })

  test("clamps resized widths", () => {
    useRightSidebarStore.getState().setSize(PROJECT_ID, 4)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.size).toBe(20)

    useRightSidebarStore.getState().setSize(PROJECT_ID, 80)
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.size).toBe(80)
  })

  test("clearing a project removes its saved drawer state", () => {
    useRightSidebarStore.getState().toggleVisibility(PROJECT_ID)
    useRightSidebarStore.getState().clearProject(PROJECT_ID)

    const layout = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultProjectRightSidebarLayout()
    expect(layout.isVisible).toBe(false)
    expect(layout.size).toBe(33)
  })

  test("migration closes persisted sidebars while preserving valid sizes", async () => {
    const migrated = await migrateRightSidebarStore({
        projects: {
          [PROJECT_ID]: {
            isVisible: true,
            size: 34,
          },
        },
      })

    expect(migrated).toEqual({
      projects: {
        [PROJECT_ID]: {
          isVisible: false,
          size: 34,
        },
      },
    })
  })
})
