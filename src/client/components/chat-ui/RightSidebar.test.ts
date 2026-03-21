import { describe, expect, test } from "bun:test"
import { getRightSidebarContentMode } from "./RightSidebar"

describe("getRightSidebarContentMode", () => {
  test("shows the project empty state when no project is selected", () => {
    expect(getRightSidebarContentMode({
      projectId: null,
      rootError: null,
      rootEntryCount: 0,
    })).toBe("empty-project")
  })

  test("keeps the tree content mode while hidden so close animations retain content", () => {
    expect(getRightSidebarContentMode({
      projectId: "project-1",
      rootError: null,
      rootEntryCount: 12,
    })).toBe("tree")
  })

  test("shows the error state when the root directory load fails with no entries", () => {
    expect(getRightSidebarContentMode({
      projectId: "project-1",
      rootError: "Permission denied",
      rootEntryCount: 0,
    })).toBe("empty-error")
  })
})
