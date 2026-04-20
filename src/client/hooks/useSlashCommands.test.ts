import { beforeEach, describe, expect, test } from "bun:test"
import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import { selectSlashCommands, useSlashCommands } from "./useSlashCommands"

describe("useSlashCommands", () => {
  beforeEach(() => {
    useSlashCommandsStore.setState({ byChatId: {} })
  })

  test("selector returns cached commands for known chat", () => {
    useSlashCommandsStore.getState().setForChat("c1", [
      { name: "review", description: "r", argumentHint: "<pr>" },
    ])
    const result = selectSlashCommands(useSlashCommandsStore.getState(), "c1")
    expect(result).toEqual([
      { name: "review", description: "r", argumentHint: "<pr>" },
    ])
  })

  test("selector returns stable empty array for missing chatId", () => {
    const state = useSlashCommandsStore.getState()
    const a = selectSlashCommands(state, "missing")
    const b = selectSlashCommands(state, "missing")
    expect(a).toBe(b)
  })

  test("selector returns stable empty array for null chatId", () => {
    const state = useSlashCommandsStore.getState()
    const a = selectSlashCommands(state, null)
    const b = selectSlashCommands(state, null)
    expect(a).toBe(b)
  })

  test("hook is exported as a function", () => {
    expect(useSlashCommands).toBeTypeOf("function")
  })
})
