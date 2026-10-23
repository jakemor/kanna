import { describe, expect, test } from "bun:test"
import { hydrateToolResult, normalizeToolCall } from "./tools"

describe("normalizeToolCall", () => {
  test("maps AskUserQuestion input to typed questions", () => {
    const tool = normalizeToolCall({
      toolName: "AskUserQuestion",
      toolId: "tool-1",
      input: {
        questions: [
          {
            question: "Which runtime?",
            header: "Runtime",
            options: [{ label: "Codex", description: "Use Codex" }],
          },
        ],
      },
    })

    expect(tool.toolKind).toBe("ask_user_question")
    if (tool.toolKind !== "ask_user_question") throw new Error("unexpected tool kind")
    expect(tool.input.questions[0]?.question).toBe("Which runtime?")
  })

  test("keeps an Agent call's description and prompt", () => {
    const tool = normalizeToolCall({
      toolName: "Agent",
      toolId: "tool-9",
      input: {
        subagent_type: "Explore",
        description: "Locate the loop",
        prompt: "Find the agent loop in src/worker.",
      },
    })

    expect(tool.toolKind).toBe("subagent_task")
    if (tool.toolKind !== "subagent_task") throw new Error("unexpected tool kind")
    expect(tool.input).toEqual({
      subagentType: "Explore",
      description: "Locate the loop",
      prompt: "Find the agent loop in src/worker.",
    })
  })

  test("maps Bash snake_case input to camelCase", () => {
    const tool = normalizeToolCall({
      toolName: "Bash",
      toolId: "tool-2",
      input: {
        command: "pwd",
        timeout: 5000,
        run_in_background: true,
      },
    })

    expect(tool.toolKind).toBe("bash")
    if (tool.toolKind !== "bash") throw new Error("unexpected tool kind")
    expect(tool.input.timeoutMs).toBe(5000)
    expect(tool.input.runInBackground).toBe(true)
  })

  test("maps unknown MCP tools to mcp_generic", () => {
    const tool = normalizeToolCall({
      toolName: "mcp__sentry__search_issues",
      toolId: "tool-3",
      input: { query: "regression" },
    })

    expect(tool.toolKind).toBe("mcp_generic")
    if (tool.toolKind !== "mcp_generic") throw new Error("unexpected tool kind")
    expect(tool.input.server).toBe("sentry")
    expect(tool.input.tool).toBe("search_issues")
  })
})

describe("hydrateToolResult", () => {
  test("hydrates AskUserQuestion answers", () => {
    const tool = normalizeToolCall({
      toolName: "AskUserQuestion",
      toolId: "tool-1",
      input: { questions: [] },
    })

    const result = hydrateToolResult(tool, JSON.stringify({ answers: { runtime: "codex" } }))
    expect(result).toEqual({ answers: { runtime: ["codex"] } })
  })

  test("hydrates AskUserQuestion multi-select answers", () => {
    const tool = normalizeToolCall({
      toolName: "AskUserQuestion",
      toolId: "tool-1",
      input: { questions: [] },
    })

    const result = hydrateToolResult(tool, JSON.stringify({ answers: { runtime: ["bun", "node"] } }))
    expect(result).toEqual({ answers: { runtime: ["bun", "node"] } })
  })

  test("hydrates ExitPlanMode decisions", () => {
    const tool = normalizeToolCall({
      toolName: "ExitPlanMode",
      toolId: "tool-2",
      input: { plan: "Do the thing" },
    })

    const result = hydrateToolResult(tool, { confirmed: true, clearContext: true })
    expect(result).toEqual({ confirmed: true, clearContext: true, message: undefined })
  })

  test("hydrates Read file text results", () => {
    const tool = normalizeToolCall({
      toolName: "Read",
      toolId: "tool-3",
      input: { file_path: "/tmp/example.ts" },
    })

    expect(hydrateToolResult(tool, "line 1\nline 2")).toBe("line 1\nline 2")
  })

  test("hydrates read image results with canonical image blocks intact", () => {
    const tool = normalizeToolCall({
      toolName: "Read",
      toolId: "tool-image",
      input: { file_path: "/tmp/example.png" },
    })

    expect(hydrateToolResult(tool, {
      content: [
        {
          type: "text",
          text: "Read image file [image/png]\n[Image: original 10x10, displayed at 10x10.]",
        },
        {
          type: "image",
          data: "ZmFrZS1pbWFnZS1kYXRh",
          mimeType: "image/png",
        },
      ],
    })).toEqual({
      content: "Read image file [image/png]\n[Image: original 10x10, displayed at 10x10.]",
      blocks: [
        {
          type: "text",
          text: "Read image file [image/png]\n[Image: original 10x10, displayed at 10x10.]",
        },
        {
          type: "image",
          data: "ZmFrZS1pbWFnZS1kYXRh",
          mimeType: "image/png",
        },
      ],
    })
  })

  test("hydrates Claude read image results with source.base64 into canonical image blocks", () => {
    const tool = normalizeToolCall({
      toolName: "Read",
      toolId: "tool-image-claude",
      input: { file_path: "/tmp/example.png" },
    })

    expect(hydrateToolResult(tool, {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            data: "ZmFrZS1pbWFnZS1kYXRh",
            media_type: "image/png",
          },
        },
      ],
    })).toEqual({
      content: "",
      blocks: [
        {
          type: "image",
          data: "ZmFrZS1pbWFnZS1kYXRh",
          mimeType: "image/png",
        },
      ],
    })
  })

  // The parsing moved to Schema; what it returns must not move with it.
  // `legacyHydrateToolResult` is the implementation it replaced, verbatim.
  test("returns exactly what the typeof-guard implementation returned", () => {
    const tools = [
      normalizeToolCall({ toolName: "AskUserQuestion", toolId: "a", input: { questions: [] } }),
      normalizeToolCall({ toolName: "ExitPlanMode", toolId: "b", input: {} }),
      normalizeToolCall({ toolName: "Read", toolId: "c", input: { file_path: "/tmp/x" } }),
      normalizeToolCall({ toolName: "Bash", toolId: "d", input: { command: "ls" } }),
    ]
    const corpus: unknown[] = [
      undefined, null, "", "plain text", "{not json", "123", "null", "[1,2]", 0, 7, true, [], {},
      JSON.stringify({ answers: { a: "x", b: ["y", 2], c: null, d: "", e: { answers: [1, "z"] }, f: { answers: "no" }, g: 0, h: false } }),
      { answers: ["not", "a", "record"], discarded: true },
      { q1: "direct", q2: ["list"], discarded: "yes" },
      { answers: { a: "x" }, discarded: true },
      { confirmed: "true", clearContext: 1, message: 5 },
      { confirmed: false, clearContext: true, message: "keep going", discarded: true },
      JSON.stringify({ confirmed: true }),
      [{ type: "text", text: "a" }, { type: "text", text: 1 }, { type: "image", url: "", data: "d", mimeType: 3 }],
      { content: [{ type: "image", url: "/media/x.png", mimeType: "image/png" }, { type: "image", url: "/media/y.png" }] },
      { content: [{ type: "image", source: { type: "base64", data: "AA", media_type: 9 } }, { type: "image", source: { type: "url", data: "AA" } }] },
      { content: [null, 1, "s", ["type"], { type: "video" }, { text: "no type" }] },
      { content: "a string, not blocks" },
      { content: "plain", other: 1 },
      { notContent: [] },
      JSON.stringify({ content: [{ type: "text", text: "from json" }] }),
    ]
    for (const tool of tools) {
      for (const raw of corpus) {
        expect(hydrateToolResult(tool, raw)).toStrictEqual(legacyHydrateToolResult(tool, raw))
      }
    }
  })
})

function legacyAsRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function legacyParseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function legacyNormalizeReadBlocks(value: unknown): unknown[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []
  const normalized: Array<{ type: "text"; text: string } | { type: "image"; data?: string; url?: string; mimeType?: string }> = []
  for (const block of blocks) {
    if (!block || typeof block !== "object" || !("type" in block)) continue
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      normalized.push({ type: "text", text: block.text })
      continue
    }
    if (block.type === "image") {
      const mimeType = "mimeType" in block && typeof block.mimeType === "string" ? block.mimeType : undefined
      if ("url" in block && typeof block.url === "string" && block.url) {
        normalized.push({ type: "image", url: block.url, mimeType })
        continue
      }
      if ("data" in block && typeof block.data === "string") {
        normalized.push({ type: "image", data: block.data, mimeType })
        continue
      }
      if (
        "source" in block
        && block.source
        && typeof block.source === "object"
        && "type" in block.source
        && block.source.type === "base64"
        && "data" in block.source
        && typeof block.source.data === "string"
      ) {
        normalized.push({
          type: "image",
          data: block.source.data,
          mimeType: "media_type" in block.source && typeof block.source.media_type === "string" ? block.source.media_type : undefined,
        })
      }
    }
  }
  return normalized
}

function legacyHydrateToolResult(tool: ReturnType<typeof normalizeToolCall>, raw: unknown): unknown {
  const parsed = legacyParseJsonValue(raw)
  switch (tool.toolKind) {
    case "ask_user_question": {
      const record = legacyAsRecord(parsed)
      const answers = legacyAsRecord(record?.answers) ?? (record ? record : {})
      return {
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => {
            if (Array.isArray(value)) return [key, value.map((entry) => String(entry))]
            if (value && typeof value === "object" && Array.isArray((value as { answers?: unknown }).answers)) {
              return [key, (value as { answers: unknown[] }).answers.map((entry) => String(entry))]
            }
            if (value == null || value === "") return [key, []]
            return [key, [String(value)]]
          })
        ),
        ...(record?.discarded === true ? { discarded: true } : {}),
      }
    }
    case "exit_plan_mode": {
      const record = legacyAsRecord(parsed)
      return {
        confirmed: typeof record?.confirmed === "boolean" ? record.confirmed : undefined,
        clearContext: typeof record?.clearContext === "boolean" ? record.clearContext : undefined,
        message: typeof record?.message === "string" ? record.message : undefined,
        ...(record?.discarded === true ? { discarded: true } : {}),
      }
    }
    case "read_file": {
      if (typeof parsed === "string") return parsed
      const blocks = legacyNormalizeReadBlocks(parsed)
      if (blocks.length > 0) {
        return {
          content: blocks.flatMap((block) => (block as { type: string; text?: string }).type === "text" ? [(block as { text: string }).text] : []).join(""),
          blocks,
        }
      }
      const record = legacyAsRecord(parsed)
      return { content: typeof record?.content === "string" ? record.content : JSON.stringify(parsed, null, 2) }
    }
    default:
      return parsed
  }
}
