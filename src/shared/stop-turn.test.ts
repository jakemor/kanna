import { describe, expect, test } from "bun:test"
import { cascadeStopLabel, countCascadingSubchats, resolveStop } from "./stop-turn"
import type { SubagentActivity } from "./types"

function row(overrides: Partial<SubagentActivity>): SubagentActivity {
  return { id: "x", type: "chat", label: "Sub-chat", status: "running", startedAt: 0, ...overrides }
}

describe("stop", () => {
  test("counts the running sub-chats this chat started, and nothing else", () => {
    expect(countCascadingSubchats(undefined)).toBe(0)
    expect(countCascadingSubchats([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "done", status: "completed" }),
      row({ id: "adopted", adopted: true }),
      row({ id: "agent", type: "subagent" }),
    ])).toBe(2)
  })

  test("with no sub-chats running, a stop is one press and sends no cascade", () => {
    expect(resolveStop(0, "button")).toEqual({ kind: "stop" })
    expect(resolveStop(0, "keyboard")).toEqual({ kind: "stop" })
  })

  test("with sub-chats running, the button asks and the key stops only the turn", () => {
    expect(resolveStop(2, "button")).toEqual({ kind: "ask", count: 2 })
    expect(resolveStop(2, "keyboard")).toEqual({ kind: "stop", cascade: false })
  })

  test("names how many go with it", () => {
    expect(cascadeStopLabel(1)).toBe("Stop this turn and 1 sub-chat")
    expect(cascadeStopLabel(3)).toBe("Stop this turn and 3 sub-chats")
  })
})
