import { describe, expect, test } from "bun:test"
import type { TranscriptEntry } from "../shared/types"
import { cloneTranscriptEntriesForClient, readStructuredResult } from "./events"

function toolCall(toolKind: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    _id: `call-${toolKind}`,
    createdAt: 1,
    kind: "tool_call",
    tool: { kind: "tool", toolKind, toolName: toolKind, toolId: `tid-${toolKind}`, input, ...extra },
  } as unknown as TranscriptEntry
}

function toolResult(toolKind: string, content: unknown, extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    _id: `result-${toolKind}`,
    createdAt: 2,
    kind: "tool_result",
    toolId: `tid-${toolKind}`,
    content,
    ...extra,
  } as unknown as TranscriptEntry
}

const call = (entries: TranscriptEntry[]) => cloneTranscriptEntriesForClient(entries)
const inputOf = (entry: TranscriptEntry) => (entry as unknown as { tool: { input: Record<string, unknown> } }).tool.input
const asResult = (entry: TranscriptEntry) => entry as unknown as { content?: unknown; isError?: boolean; structuredResult?: unknown; trimmed?: true }

describe("cloneTranscriptEntriesForClient", () => {
  test("keeps inline results when their calls are outside the streamed slice", () => {
    for (const kind of ["display", "ask_user_question", "exit_plan_mode", "todo_write", "bash"]) {
      const result = toolResult(kind, { value: "result" })
      const [cloned] = cloneTranscriptEntriesForClient([result], id => id === `tid-${kind}` ? kind : undefined)
      if (kind === "bash") {
        expect(asResult(cloned!).trimmed).toBe(true)
        expect(asResult(cloned!).content).toBeUndefined()
      } else {
        expect(cloned).toEqual(result)
      }
    }
  })

  test("drops the unbounded input field of each kind that has one", () => {
    const [write, edit, remove, mcp, unknown] = call([
      toolCall("write_file", { filePath: "a.ts", content: "x".repeat(1000) }),
      toolCall("edit_file", { filePath: "a.ts", oldString: "before", newString: "after" }),
      toolCall("delete_file", { filePath: "a.ts", content: "gone" }),
      toolCall("mcp_generic", { server: "s", tool: "t", payload: { big: true } }),
      toolCall("unknown_tool", { payload: { big: true } }),
    ])

    // The fields a collapsed header draws survive; the unbounded ones do not.
    expect(inputOf(write!)).toEqual({ filePath: "a.ts" })
    expect(inputOf(edit!)).toEqual({ filePath: "a.ts" })
    expect(inputOf(remove!)).toEqual({ filePath: "a.ts" })
    expect(inputOf(mcp!)).toEqual({ server: "s", tool: "t" })
    expect(inputOf(unknown!)).toEqual({})
    for (const entry of [write, edit, remove, mcp, unknown]) {
      expect(entry!.trimmed).toBe(true)
    }
  })

  test("drops an Agent call's prompt and keeps its description for the row title", () => {
    const [agent] = call([
      toolCall("subagent_task", { subagentType: "Explore", description: "Locate the loop", prompt: "x".repeat(2000) }),
    ])

    expect(inputOf(agent!)).toEqual({ subagentType: "Explore", description: "Locate the loop" })
    expect(agent!.trimmed).toBe(true)
  })

  test("leaves header-sized inputs whole and unmarked", () => {
    const [bash, read, grep] = call([
      toolCall("bash", { command: "ls -la", description: "List files", timeoutMs: 5000 }),
      toolCall("read_file", { filePath: "src/index.ts" }),
      toolCall("grep", { pattern: "TODO", outputMode: "content" }),
    ])

    expect(inputOf(bash!)).toEqual({ command: "ls -la", description: "List files", timeoutMs: 5000 })
    expect(inputOf(read!)).toEqual({ filePath: "src/index.ts" })
    expect(inputOf(grep!)).toEqual({ pattern: "TODO", outputMode: "content" })
    // No marker: there is nothing more to fetch.
    for (const entry of [bash, read, grep]) {
      expect(entry!.trimmed).toBeUndefined()
    }
  })

  test("drops rawInput even from a kind whose input is otherwise header-sized", () => {
    const [bash] = call([
      toolCall("bash", { command: "ls" }, { rawInput: { command: "ls", extra: "x".repeat(500) } }),
    ])

    expect((bash as unknown as { tool: { rawInput?: unknown } }).tool.rawInput).toBeUndefined()
    expect(bash!.trimmed).toBe(true)
  })

  test("drops tool result content but keeps what a collapsed row reads", () => {
    const [, result] = call([
      toolCall("bash", { command: "ls" }),
      toolResult("bash", "a".repeat(100_000), { isError: true }),
    ])

    expect(asResult(result!).content).toBeUndefined()
    expect(asResult(result!).isError).toBe(true)
    expect(result!.trimmed).toBe(true)
    expect(result!._id).toBe("result-bash")
  })

  test("keeps interactive kinds whole — call and result — since they render inline", () => {
    for (const kind of ["ask_user_question", "exit_plan_mode", "todo_write"]) {
      const [callEntry, resultEntry] = call([
        toolCall(kind, { plan: "p".repeat(5000), payload: { deep: true } }),
        toolResult(kind, { answers: { a: ["yes"] } }),
      ])

      expect(inputOf(callEntry!)).toEqual({ plan: "p".repeat(5000), payload: { deep: true } })
      expect(callEntry!.trimmed).toBeUndefined()
      expect(asResult(resultEntry!).content).toEqual({ answers: { a: ["yes"] } })
      expect(resultEntry!.trimmed).toBeUndefined()
    }
  })

  test("lifts tool_use_result out of debugRaw for the structured kinds", () => {
    const [, result] = call([
      toolCall("exit_plan_mode", { plan: "do it" }),
      toolResult("exit_plan_mode", "ok", {
        debugRaw: JSON.stringify({ tool_use_result: { approved: true } }),
      }),
    ])

    expect(asResult(result!).structuredResult).toEqual({ approved: true })
    expect(asResult(result!).content).toBe("ok")
  })

  test("uses a persisted structuredResult without touching debugRaw", () => {
    const [, result] = call([
      toolCall("exit_plan_mode", { plan: "do it" }),
      toolResult("exit_plan_mode", "ok", {
        structuredResult: { approved: false },
        debugRaw: JSON.stringify({ tool_use_result: { approved: true } }),
      }),
    ])

    expect(asResult(result!).structuredResult).toEqual({ approved: false })
    expect(result!.debugRaw).toBeUndefined()
  })

  test("survives corrupt debugRaw rather than failing the transcript", () => {
    const [, result] = call([
      toolCall("ask_user_question", { questions: [] }),
      toolResult("ask_user_question", "ok", { debugRaw: "{not json" }),
    ])

    expect(asResult(result!).structuredResult).toBeUndefined()
    expect(asResult(result!).content).toBe("ok")
  })

  test("strips debugRaw from every kind", () => {
    const entries = call([
      { _id: "s", createdAt: 1, kind: "system_init", debugRaw: "{}" } as unknown as TranscriptEntry,
      toolCall("bash", { command: "ls" }, {}),
      toolResult("bash", "out", { debugRaw: "{}" }),
    ])

    for (const entry of entries) expect(entry.debugRaw).toBeUndefined()
  })

  test("trims an orphan result whose call is absent", () => {
    const [orphan] = call([toolResult("bash", "output")])

    expect(asResult(orphan!).content).toBeUndefined()
    expect(orphan!.trimmed).toBe(true)
  })

  test("passes non-tool entries through unchanged", () => {
    const source: TranscriptEntry[] = [
      { _id: "u", createdAt: 1, kind: "user_prompt", content: "hello" } as unknown as TranscriptEntry,
      { _id: "a", createdAt: 2, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry,
    ]

    expect(call(source)).toEqual(source)
  })

  test("never mutates the entries it was given", () => {
    // The store hands out its cached array; trimming it in place would corrupt
    // the full-fidelity copy that export and handoff read.
    const source = [
      toolCall("write_file", { filePath: "a.ts", content: "body" }),
      toolResult("write_file", "written"),
    ]
    const snapshot = structuredClone(source)

    call(source)

    expect(source).toEqual(snapshot)
  })
})

describe("readStructuredResult", () => {
  test("reads tool_use_result from a raw Claude message as older builds stored it", () => {
    const raw = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      parent_tool_use_id: null,
      session_id: "s1",
      tool_use_result: { answers: { "Which?": "A" }, questions: [{ question: "Which?" }] },
    })
    expect(readStructuredResult(raw)).toEqual({ answers: { "Which?": "A" }, questions: [{ question: "Which?" }] })
  })

  test("keeps a non-object tool_use_result as it is", () => {
    expect(readStructuredResult(JSON.stringify({ tool_use_result: "Error: denied" }))).toBe("Error: denied")
    expect(readStructuredResult(JSON.stringify({ tool_use_result: null }))).toBeNull()
  })

  test("reads nothing from a message without one, from corrupt JSON, or from JSON that is not an object", () => {
    expect(readStructuredResult(undefined)).toBeUndefined()
    expect(readStructuredResult(JSON.stringify({ type: "user" }))).toBeUndefined()
    expect(readStructuredResult("{not json")).toBeUndefined()
    expect(readStructuredResult("null")).toBeUndefined()
    expect(readStructuredResult("[1,2]")).toBeUndefined()
    expect(readStructuredResult("\"text\"")).toBeUndefined()
  })
})
