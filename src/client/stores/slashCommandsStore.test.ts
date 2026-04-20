import { beforeEach, describe, expect, test } from "bun:test"
import { useSlashCommandsStore } from "./slashCommandsStore"

describe("slashCommandsStore", () => {
  beforeEach(() => {
    useSlashCommandsStore.setState({ byChatId: {} })
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

  test("clear removes list", () => {
    useSlashCommandsStore.getState().setForChat("c1", [{ name: "x", description: "", argumentHint: "" }])
    useSlashCommandsStore.getState().clear("c1")
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toBeUndefined()
  })

  test("clear on unknown chat is a no-op", () => {
    useSlashCommandsStore.getState().clear("nope")
    expect(useSlashCommandsStore.getState().byChatId).toEqual({})
  })
})
