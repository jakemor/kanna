import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_LEFT_SIDEBAR_WIDTH_PX,
  LEFT_SIDEBAR_MAX_WIDTH_PX,
  LEFT_SIDEBAR_MIN_WIDTH_PX,
  migrateLeftSidebarStore,
  useLeftSidebarStore,
} from "./leftSidebarStore"

describe("leftSidebarStore", () => {
  beforeEach(() => {
    useLeftSidebarStore.setState({ widthPx: DEFAULT_LEFT_SIDEBAR_WIDTH_PX })
  })

  test("defaults to the standard desktop sidebar width", () => {
    expect(useLeftSidebarStore.getState().widthPx).toBe(DEFAULT_LEFT_SIDEBAR_WIDTH_PX)
  })

  test("clamps widths below the minimum", () => {
    useLeftSidebarStore.getState().setWidth(LEFT_SIDEBAR_MIN_WIDTH_PX - 50)
    expect(useLeftSidebarStore.getState().widthPx).toBe(LEFT_SIDEBAR_MIN_WIDTH_PX)
  })

  test("clamps widths above the maximum", () => {
    useLeftSidebarStore.getState().setWidth(LEFT_SIDEBAR_MAX_WIDTH_PX + 50)
    expect(useLeftSidebarStore.getState().widthPx).toBe(LEFT_SIDEBAR_MAX_WIDTH_PX)
  })

  test("migration falls back for invalid persisted widths", async () => {
    const migrated = await migrateLeftSidebarStore({ widthPx: Number.NaN })
    expect(migrated).toEqual({ widthPx: DEFAULT_LEFT_SIDEBAR_WIDTH_PX })
  })

  test("migration clamps out-of-range persisted widths", async () => {
    const migrated = await migrateLeftSidebarStore({ widthPx: LEFT_SIDEBAR_MAX_WIDTH_PX + 120 })
    expect(migrated).toEqual({ widthPx: LEFT_SIDEBAR_MAX_WIDTH_PX })
  })
})
