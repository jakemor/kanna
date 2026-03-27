import { beforeEach, describe, expect, test } from "bun:test"
import { getDefaultProjectTerminalLayout, useTerminalLayoutStore } from "./terminalLayoutStore"

const PROJECT_ID = "project-1"

describe("terminalLayoutStore", () => {
  beforeEach(() => {
    useTerminalLayoutStore.setState({ projects: {} })
  })

  test("adds the first terminal and shows the workspace", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
    expect(layout.terminals[0]?.title).toBe("Terminal A")
  })

  test("keeps layouts isolated per project", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    useTerminalLayoutStore.getState().addTerminal("project-2")
    useTerminalLayoutStore.getState().addTerminal("project-2")

    expect(useTerminalLayoutStore.getState().projects[PROJECT_ID]?.terminals).toHaveLength(1)
    expect(useTerminalLayoutStore.getState().projects["project-2"]?.terminals).toHaveLength(2)
  })

  test("removing the last terminal hides the workspace", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    const terminalId = useTerminalLayoutStore.getState().projects[PROJECT_ID]?.terminals[0]?.id
    expect(terminalId).toBeString()

    useTerminalLayoutStore.getState().removeTerminal(PROJECT_ID, terminalId!)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.isVisible).toBe(false)
    expect(layout.terminals).toHaveLength(0)
  })

  test("resetting main sizes restores the default split without removing terminals", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    useTerminalLayoutStore.getState().setMainSizes(PROJECT_ID, [80, 20])

    useTerminalLayoutStore.getState().resetMainSizes(PROJECT_ID)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.mainSizes).toEqual([68, 32])
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
  })
})
