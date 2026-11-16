import { expect, test } from "bun:test"
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { claudeToolset } from "./agent"
import { requireClaudeExecutable } from "./claude-executable"

/*
 * Claude sessions keep MCP tools deferred. `claudeToolset` is an explicit
 * allowlist, and without `ToolSearch` in it Claude Code has no way to defer
 * MCP tools: it inlines every server's full schemas into each request, and
 * again after each compaction, so a session with a few large MCP servers
 * starts most of the way to its compaction threshold.
 *
 * Runs a real one-turn Claude Code session (network, a little API spend on a
 * cheap model), so it's out of `bun test`'s default sweep:
 *
 *   bun test ./src/server/claude-tool-search.e2e.ts
 *
 * The MCP server is in-process and synthetic and no settings files are
 * loaded, so the result doesn't depend on the machine's own MCP config.
 */
const TOOL_COUNT = 200
const DESCRIPTION = "Looks up a record in the reporting warehouse by its identifier and returns every field on it, "
  .repeat(20)

test("MCP tool schemas stay out of the context until a tool is needed", async () => {
  const pathToClaudeCodeExecutable = await requireClaudeExecutable()
  const bulk = createSdkMcpServer({
    name: "bulk",
    version: "1.0.0",
    tools: Array.from({ length: TOOL_COUNT }, (_, index) =>
      tool(`lookup_${index}`, DESCRIPTION, { id: z.string().describe("Record identifier") }, async () => ({
        content: [{ type: "text" as const, text: "{}" }],
      }))),
  })
  const schemaTokens = (TOOL_COUNT * DESCRIPTION.length) / 4

  let tools: string[] = []
  let inputTokens = 0
  const run = query({
    prompt: "Reply with the single word: ok",
    options: {
      model: "claude-haiku-5-5",
      tools: claudeToolset(false),
      mcpServers: { bulk },
      settingSources: [],
      maxTurns: 1,
      pathToClaudeCodeExecutable,
    },
  })
  for await (const message of run) {
    if (message.type === "system" && message.subtype === "init") tools = message.tools
    if (message.type === "result") {
      const usage = message.usage
      inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    }
  }
  const bulkTools = tools.filter((name) => name.startsWith("mcp__bulk__")).length
  console.log(`first call: ${inputTokens} input tokens (MCP schemas ≈ ${schemaTokens}); bulk tools: ${bulkTools}; ToolSearch offered: ${tools.includes("ToolSearch")}`)
  expect(bulkTools).toBe(TOOL_COUNT)
  expect(tools).toContain("ToolSearch")
  expect(inputTokens).toBeGreaterThan(0)
  expect(inputTokens).toBeLessThan(schemaTokens / 2)
}, 180_000)
