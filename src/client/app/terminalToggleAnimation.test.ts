import { describe, expect, test } from "bun:test"
import { easeInOutCubic, interpolateLayout } from "./terminalToggleAnimation"
import { resolveTerminalAnimationState } from "./useTerminalToggleAnimation"

describe("terminalToggleAnimation", () => {
  test("clamps easing at the ends", () => {
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(2)).toBe(1)
  })

  test("interpolates panel layouts", () => {
    expect(interpolateLayout([68, 32], [100, 0], 0)).toEqual([68, 32])
    expect(interpolateLayout([68, 32], [100, 0], 1)).toEqual([100, 0])

    const midpoint = interpolateLayout([100, 0], [68, 32], 0.5)
    expect(midpoint[0]).toBeCloseTo(75.18203798328659, 5)
    expect(midpoint[1]).toBeCloseTo(24.817962016713415, 5)
  })

  test("animates the first open after the project view is already mounted", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: "project-1",
      projectId: "project-1",
      previousShouldRenderTerminalLayout: false,
      previousShowTerminalPane: false,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [68, 32],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.currentLayout).toEqual([100, 0])
    expect(result.targetLayout).toEqual([68, 32])
    expect(result.shouldSkipAnimation).toBe(false)
  })

  test("skips animation on the first render for a newly mounted project", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: null,
      projectId: "project-1",
      previousShouldRenderTerminalLayout: false,
      previousShowTerminalPane: false,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [68, 32],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.shouldSkipAnimation).toBe(true)
  })

  test("skips animation when switching projects", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: "project-1",
      projectId: "project-2",
      previousShouldRenderTerminalLayout: true,
      previousShowTerminalPane: true,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [60, 40],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.shouldSkipAnimation).toBe(true)
    expect(result.currentLayout).toEqual([68, 32])
    expect(result.targetLayout).toEqual([60, 40])
  })
})
