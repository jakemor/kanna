import { beforeEach, describe, expect, test } from "bun:test"
import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import {
  selectSlashCommands,
  selectSlashCommandsLoading,
  useSlashCommands,
  useSlashCommandsLoading,
} from "./useSlashCommands"

describe("useSlashCommands", () => {
  beforeEach(() => {
    useSlashCommandsStore.setState({ byChatId: {}, loadingByChatId: {} })
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

  test("loading selector returns false when flag not set", () => {
    expect(selectSlashCommandsLoading(useSlashCommandsStore.getState(), "c1")).toBe(false)
  })

  test("loading selector returns true once flag set", () => {
    useSlashCommandsStore.getState().setLoadingForChat("c1", true)
    expect(selectSlashCommandsLoading(useSlashCommandsStore.getState(), "c1")).toBe(true)
  })

  test("loading selector returns false for null chatId", () => {
    expect(selectSlashCommandsLoading(useSlashCommandsStore.getState(), null)).toBe(false)
  })

  test("hooks are exported as functions", () => {
    expect(useSlashCommands).toBeTypeOf("function")
    expect(useSlashCommandsLoading).toBeTypeOf("function")
  })
})
