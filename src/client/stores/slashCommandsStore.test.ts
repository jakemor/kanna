import { beforeEach, describe, expect, test } from "bun:test"
import { useSlashCommandsStore } from "./slashCommandsStore"

describe("slashCommandsStore", () => {
  beforeEach(() => {
    useSlashCommandsStore.setState({ byChatId: {}, loadingByChatId: {} })
  })

  test("setForChat stores list", () => {
    useSlashCommandsStore.getState().setForChat("c1", [
      { name: "review", description: "r", argumentHint: "<pr>" },
    ])
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toEqual([
      { name: "review", description: "r", argumentHint: "<pr>" },
    ])
  })

  test("setForChat replaces existing list", () => {
    useSlashCommandsStore.getState().setForChat("c1", [{ name: "a", description: "", argumentHint: "" }])
    useSlashCommandsStore.getState().setForChat("c1", [{ name: "b", description: "", argumentHint: "" }])
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toEqual([
      { name: "b", description: "", argumentHint: "" },
    ])
  })

  test("clear removes list and loading state", () => {
    useSlashCommandsStore.getState().setForChat("c1", [{ name: "x", description: "", argumentHint: "" }])
    useSlashCommandsStore.getState().setLoadingForChat("c1", true)
    useSlashCommandsStore.getState().clear("c1")
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toBeUndefined()
    expect(useSlashCommandsStore.getState().loadingByChatId["c1"]).toBeUndefined()
  })

  test("clear on unknown chat is a no-op", () => {
    useSlashCommandsStore.getState().clear("nope")
    expect(useSlashCommandsStore.getState().byChatId).toEqual({})
    expect(useSlashCommandsStore.getState().loadingByChatId).toEqual({})
  })

  test("setLoadingForChat toggles loading flag", () => {
    useSlashCommandsStore.getState().setLoadingForChat("c1", true)
    expect(useSlashCommandsStore.getState().loadingByChatId["c1"]).toBe(true)
    useSlashCommandsStore.getState().setLoadingForChat("c1", false)
    expect(useSlashCommandsStore.getState().loadingByChatId["c1"]).toBe(false)
  })

  test("setLoadingForChat is a no-op when value unchanged", () => {
    useSlashCommandsStore.getState().setLoadingForChat("c1", true)
    const before = useSlashCommandsStore.getState().loadingByChatId
    useSlashCommandsStore.getState().setLoadingForChat("c1", true)
    const after = useSlashCommandsStore.getState().loadingByChatId
    expect(after).toBe(before)
  })
})
