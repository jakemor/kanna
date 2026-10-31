import { describe, expect, test } from "bun:test"
import { cascadeStopLabel, countCascadingSubchats, resolvePrimaryAction, resolveStop } from "./stop-turn"
import { shouldSteerSubmit } from "./submit-mode"
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

describe("the round button", () => {
  const midTurn = { canCancel: true, holdEngaged: false, stopChoiceOpen: false }

  test("with something to send it sends, mid-turn with sub-chats running too, and never asks", () => {
    expect(resolvePrimaryAction({ ...midTurn, sendable: true })).toBe("send")
    // Waiting on sub-chats there is no turn to stop, so nothing to choose either.
    expect(resolvePrimaryAction({ ...midTurn, canCancel: false, sendable: true })).toBe("send")
    // The send queues or interrupts by Enter While Running, and the modifier does the other.
    expect(shouldSteerSubmit("queue", false)).toBe(false)
    expect(shouldSteerSubmit("queue", true)).toBe(true)
    expect(shouldSteerSubmit("steer", false)).toBe(true)
    expect(shouldSteerSubmit("steer", true)).toBe(false)
  })

  test("with nothing to send it is Stop, the press that asks while sub-chats run", () => {
    expect(resolvePrimaryAction({ ...midTurn, sendable: false })).toBe("stop")
    expect(resolveStop(2, "button")).toEqual({ kind: "ask", count: 2 })
    expect(resolvePrimaryAction({ ...midTurn, sendable: false, stopChoiceOpen: true })).toBe("close-stop-choice")
    expect(resolvePrimaryAction({ ...midTurn, canCancel: false, sendable: false })).toBe("none")
  })

  test("under a held Escape it is the held stop, which asks nothing", () => {
    expect(resolvePrimaryAction({ ...midTurn, sendable: true, holdEngaged: true })).toBe("stop-held")
    expect(resolveStop(2, "keyboard")).toEqual({ kind: "stop", cascade: false })
  })
})
