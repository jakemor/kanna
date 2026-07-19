import { describe, expect, test } from "bun:test"
import { normalizeToolCall } from "../shared/tools"
import {
  buildRegistryModel,
  extractPiToolResultContent,
  normalizePiUsage,
  translatePiTool,
  PI_TOOL_NAMES,
  type PiConnection,
} from "./pi-agent"

describe("translatePiTool", () => {
  test("maps read onto Read/read_file with offset and limit", () => {
    const { toolName, input } = translatePiTool("read", { path: "/repo/src/index.ts", offset: 10, limit: 50 })
    const tool = normalizeToolCall({ toolName, toolId: "t1", input })
    expect(tool.toolKind).toBe("read_file")
    expect(tool.input).toMatchObject({ filePath: "/repo/src/index.ts" })
  })

  test("maps bash onto Bash and converts the timeout to milliseconds", () => {
    const { toolName, input } = translatePiTool("bash", { command: "bun test", timeout: 90 })
    const tool = normalizeToolCall({ toolName, toolId: "t2", input })
    expect(tool.toolKind).toBe("bash")
    expect(tool.input).toMatchObject({ command: "bun test", timeoutMs: 90_000 })
  })

  test("maps a single edit onto Edit/edit_file", () => {
    const { toolName, input } = translatePiTool("edit", {
      path: "/repo/a.ts",
      edits: [{ oldText: "const a = 1", newText: "const a = 2" }],
    })
    const tool = normalizeToolCall({ toolName, toolId: "t3", input })
    expect(tool.toolKind).toBe("edit_file")
    expect(tool.input).toMatchObject({
      filePath: "/repo/a.ts",
      oldString: "const a = 1",
      newString: "const a = 2",
    })
  })

  test("joins multi-edit calls into one edit_file pair", () => {
    const { toolName, input } = translatePiTool("edit", {
      path: "/repo/a.ts",
      edits: [
        { oldText: "one", newText: "uno" },
        { oldText: "two", newText: "dos" },
      ],
    })
    const tool = normalizeToolCall({ toolName, toolId: "t4", input })
    expect(tool.toolKind).toBe("edit_file")
    expect(tool.input).toMatchObject({ oldString: "one\ntwo", newString: "uno\ndos" })
  })

  test("maps write onto Write/write_file", () => {
    const { toolName, input } = translatePiTool("write", { path: "/repo/new.ts", content: "hi" })
    const tool = normalizeToolCall({ toolName, toolId: "t5", input })
    expect(tool.toolKind).toBe("write_file")
    expect(tool.input).toMatchObject({ filePath: "/repo/new.ts", content: "hi" })
  })

  test("maps grep onto Grep/grep", () => {
    const { toolName, input } = translatePiTool("grep", { pattern: "TODO", path: "src", ignoreCase: true })
    const tool = normalizeToolCall({ toolName, toolId: "t6", input })
    expect(tool.toolKind).toBe("grep")
    expect(tool.input).toMatchObject({ pattern: "TODO" })
  })

  test("maps find onto Glob/glob", () => {
    const { toolName, input } = translatePiTool("find", { pattern: "**/*.ts", path: "src" })
    const tool = normalizeToolCall({ toolName, toolId: "t7", input })
    expect(tool.toolKind).toBe("glob")
    expect(tool.input).toMatchObject({ pattern: "**/*.ts" })
  })

  test("maps ls onto Glob/glob with a directory pattern", () => {
    const { toolName, input } = translatePiTool("ls", { path: "src/server/" })
    const tool = normalizeToolCall({ toolName, toolId: "t8", input })
    expect(tool.toolKind).toBe("glob")
    expect(tool.input).toMatchObject({ pattern: "src/server/*" })
  })

  test("ls without a path lists the working directory", () => {
    const { input } = translatePiTool("ls", {})
    expect(input.pattern).toBe("./*")
  })

  test("every built-in pi tool maps onto a known Kanna tool kind", () => {
    for (const name of PI_TOOL_NAMES) {
      const { toolName, input } = translatePiTool(name, { path: "x", pattern: "y", command: "z", edits: [] })
      const tool = normalizeToolCall({ toolName, toolId: `id-${name}`, input })
      expect(tool.toolKind).not.toBe("unknown_tool")
    }
  })

  test("unknown tools fall through and render as unknown_tool", () => {
    const { toolName, input } = translatePiTool("custom_thing", { foo: 1 })
    const tool = normalizeToolCall({ toolName, toolId: "t9", input })
    expect(tool.toolKind).toBe("unknown_tool")
  })
})

describe("extractPiToolResultContent", () => {
  test("collapses text blocks to a string", () => {
    expect(
      extractPiToolResultContent({ content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] })
    ).toBe("hello world")
  })

  test("keeps block structure when images are present", () => {
    const result = extractPiToolResultContent({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    })
    expect(result).toEqual({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] })
  })

  test("passes through plain strings", () => {
    expect(extractPiToolResultContent("plain output")).toBe("plain output")
  })
})

describe("normalizePiUsage", () => {
  test("maps pi usage into a context window snapshot", () => {
    const usage = normalizePiUsage(
      { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, totalTokens: 1800 },
      262_144,
    )
    expect(usage).toMatchObject({
      usedTokens: 1800,
      inputTokens: 1600,
      cachedInputTokens: 500,
      outputTokens: 200,
      maxTokens: 262_144,
    })
  })

  test("returns null for empty usage", () => {
    expect(normalizePiUsage({}, 100)).toBeNull()
    expect(normalizePiUsage(undefined)).toBeNull()
  })
})

describe("buildRegistryModel", () => {
  const openrouter: PiConnection = {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "k",
  }

  test("synthesizes an OpenRouter model with the openrouter thinking format", () => {
    const model = buildRegistryModel(openrouter, "someone/some-new-model")
    expect(model).toMatchObject({
      id: "someone/some-new-model",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    })
    expect(model.compat?.thinkingFormat).toBe("openrouter")
  })

  test("synthesizes an OpenAI model with the openai thinking format", () => {
    const model = buildRegistryModel(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      "gpt-5.4-mini",
    )
    expect(model).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    })
    expect(model.compat?.thinkingFormat).toBe("openai")
  })

  test("targets custom endpoints verbatim", () => {
    const model = buildRegistryModel(
      { provider: "custom", baseUrl: "https://llm.internal.example/v1", apiKey: "k" },
      "local-coder",
    )
    expect(model).toMatchObject({
      provider: "custom",
      baseUrl: "https://llm.internal.example/v1",
      id: "local-coder",
    })
    expect(model.compat?.thinkingFormat).toBe("openai")
  })
})
