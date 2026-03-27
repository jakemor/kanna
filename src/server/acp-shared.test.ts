import { describe, expect, test } from "bun:test"
import { normalizeAcpToolCall, populateExitPlanFromAssistantText } from "./acp-shared"

describe("normalizeAcpToolCall", () => {
  test("maps Cursor create-plan requests to exit_plan_mode", () => {
    const tool = normalizeAcpToolCall({
      toolCallId: "tool-1",
      title: "Create Plan",
      content: [],
      locations: [],
    })

    expect(tool.toolKind).toBe("exit_plan_mode")
    if (tool.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected tool kind")
    }
    expect(tool.input.summary).toBeUndefined()
  })

  test("maps Cursor create-plan requests with titles to exit_plan_mode summary", () => {
    const tool = normalizeAcpToolCall({
      toolCallId: "tool-2",
      title: "Create Plan: src/server/provider-catalog.ts",
      content: [],
      locations: [],
    })

    expect(tool.toolKind).toBe("exit_plan_mode")
    if (tool.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected tool kind")
    }
    expect(tool.input.summary).toBe("src/server/provider-catalog.ts")
  })

  test("maps update-todos preview tool calls to TodoWrite", () => {
    const tool = normalizeAcpToolCall({
      toolCallId: "tool-5",
      title: "Update Todos",
      content: [],
      locations: [],
    })

    expect(tool.toolKind).toBe("todo_write")
    if (tool.toolKind !== "todo_write") {
      throw new Error("unexpected tool kind")
    }
    expect(tool.input.todos).toEqual([])
  })
})

describe("populateExitPlanFromAssistantText", () => {
  test("fills a missing exit-plan body from streamed assistant text", () => {
    const tool = normalizeAcpToolCall({
      toolCallId: "tool-3",
      title: "Create Plan",
      content: [],
      locations: [],
    })

    const hydrated = populateExitPlanFromAssistantText(tool, "## Plan\n\n- Step 1\n- Step 2")
    expect(hydrated.toolKind).toBe("exit_plan_mode")
    if (hydrated.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected tool kind")
    }
    expect(hydrated.input.plan).toBe("## Plan\n\n- Step 1\n- Step 2")
  })

  test("does not overwrite an explicit exit-plan body", () => {
    const explicit = normalizeAcpToolCall({
      toolCallId: "tool-4",
      title: "Requesting plan approval for: plan.md",
      content: [],
      locations: [],
    })
    const hydrated = populateExitPlanFromAssistantText({
      ...explicit,
      toolKind: "exit_plan_mode",
      input: {
        ...explicit.input,
        plan: "## Existing Plan",
      },
    }, "## Replacement Plan")

    expect(hydrated.toolKind).toBe("exit_plan_mode")
    if (hydrated.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected tool kind")
    }
    expect(hydrated.input.plan).toBe("## Existing Plan")
  })
})
