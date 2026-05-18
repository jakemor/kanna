import { describe, expect, test } from "bun:test"
import type { SubagentOrchestrator } from "../subagent-orchestrator"
import type { DelegationOutcome } from "../subagent-orchestrator"
import { createDelegateSubagentTool } from "./delegate-subagent"

interface DelegateCall {
  chatId: string
  parentUserMessageId: string
  parentRunId: string | null
  parentSubagentId: string | null
  ancestorSubagentIds: string[]
  depth: number
  subagentId: string
  prompt: string
}

function makeFakeOrchestrator(outcome: DelegationOutcome) {
  const calls: DelegateCall[] = []
  const fake = {
    async delegateRun(args: DelegateCall) {
      calls.push(args)
      return outcome
    },
  } as unknown as SubagentOrchestrator
  return { fake, calls }
}

const baseCtx = () => ({
  chatId: "chat-1",
  parentSubagentId: null,
  parentRunId: null,
  ancestorSubagentIds: [],
  depth: 0,
  getParentUserMessageId: () => "umsg-1",
})

describe("createDelegateSubagentTool", () => {
  test("forwards inputs verbatim to orchestrator.delegateRun and returns completed text", async () => {
    const { fake, calls } = makeFakeOrchestrator({
      status: "completed",
      runId: "run-1",
      text: "sub said hi",
    })
    const tool = createDelegateSubagentTool({ orchestrator: fake })
    const result = await tool.handler(
      { subagent_id: "sa-1", prompt: "do the thing" },
      baseCtx(),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-1",
      prompt: "do the thing",
    })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text)
    expect(payload).toEqual({ status: "completed", run_id: "run-1", reply: "sub said hi" })
  })

  test("returns isError=true with error metadata when the run fails", async () => {
    const { fake } = makeFakeOrchestrator({
      status: "failed",
      runId: "run-2",
      errorCode: "PROVIDER_ERROR",
      errorMessage: "boom",
    })
    const tool = createDelegateSubagentTool({ orchestrator: fake })
    const result = await tool.handler(
      { subagent_id: "sa-1", prompt: "go" },
      baseCtx(),
    )
    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0].text)
    expect(payload).toEqual({
      status: "failed",
      run_id: "run-2",
      error_code: "PROVIDER_ERROR",
      error_message: "boom",
    })
  })

  test("refuses to delegate when no active turn is bound (parentUserMessageId is null)", async () => {
    const { fake, calls } = makeFakeOrchestrator({ status: "completed", runId: "x", text: "" })
    const tool = createDelegateSubagentTool({ orchestrator: fake })
    const result = await tool.handler(
      { subagent_id: "sa-1", prompt: "x" },
      { ...baseCtx(), getParentUserMessageId: () => null },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("No active turn")
    expect(calls).toHaveLength(0)
  })

  test("threads sub-spawn-sub context (depth, ancestor, parentRunId) into the orchestrator call", async () => {
    const { fake, calls } = makeFakeOrchestrator({ status: "completed", runId: "r", text: "" })
    const tool = createDelegateSubagentTool({ orchestrator: fake })
    await tool.handler(
      { subagent_id: "sa-c", prompt: "child" },
      {
        chatId: "chat-1",
        parentSubagentId: "sa-b",
        parentRunId: "run-b",
        ancestorSubagentIds: ["sa-a", "sa-b"],
        depth: 2,
        getParentUserMessageId: () => "umsg-1",
      },
    )
    expect(calls[0]).toMatchObject({
      parentRunId: "run-b",
      parentSubagentId: "sa-b",
      ancestorSubagentIds: ["sa-a", "sa-b"],
      depth: 2,
    })
  })
})
