import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { TSchema } from "typebox"
import { kannaToolSpecs, type KannaToolHost } from "./kanna-tools"

/**
 * The in-process MCP server for the Claude Agent SDK.
 *
 * This does not use the SDK's `createSdkMcpServer` and `tool`. Those convert
 * each zod schema with a converter bundled inside the SDK, and that converter
 * calls into whatever zod is installed. With Agent SDK 0.3.277 and zod 4.6.5,
 * `tools/list` threw on every `z.record` field ("ctx.deferred.push"), the
 * server still reported "connected", and Claude got no Kanna tools. A global
 * install resolves newer versions than the lockfile, so only nightly builds
 * broke. Here `kannaToolSpecs()` converts the schemas with our own zod, the
 * same way the HTTP server in `kanna-mcp.ts` does. `KannaToolRuntime.execute`
 * validates the input.
 *
 * Both adapters stay Promise code: each sits between an SDK's Promise
 * callback and `KannaToolHost`, and only passes the call and its signal on.
 */
export function createClaudeKannaTools(host: KannaToolHost): McpSdkServerConfigWithInstance {
  const server = new Server({ name: "kanna", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
    // Without this, Claude Code defers the tools behind tool search when the user has many MCP tools.
    tools: kannaToolSpecs().map((spec) => ({ ...spec, _meta: { "anthropic/alwaysLoad": true } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, (call, extra) =>
    host.execute(call.params.name, call.params.arguments ?? {}, extra.signal))
  // The SDK only calls `instance.connect(transport)`, which the low-level server has too.
  return { type: "sdk", name: "kanna", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] }
}

function piSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(piSchema)
  if (!schema || typeof schema !== "object") return schema
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, piSchema(value)]))
  const variants = result.anyOf
  if (Array.isArray(variants) && variants.length > 0 && variants.every(variant =>
    variant && typeof variant === "object" && Object.keys(variant).length === 1
    && ["string", "number", "integer", "boolean", "null"].includes(variant.type),
  )) {
    // Pi coerces anyOf values into the first matching branch, which turns chart numbers into strings.
    // A type array accepts the same values and preserves their types, including null and numeric category labels.
    result.type = [...new Set(variants.map(variant => variant.type))]
    delete result.anyOf
  }
  return result
}

export function createPiKannaTools(host: KannaToolHost): ToolDefinition[] {
  return kannaToolSpecs().map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    promptSnippet: definition.description,
    parameters: piSchema(definition.inputSchema) as TSchema,
    // Pi reports a tool failure by the rejection, so an error result is thrown with its text.
    execute: (_callId, input, signal) => host.execute(definition.name, input, signal).then((result) => {
      if (result.isError) throw new Error(result.content.map((block) => block.text).join("\n"))
      return { content: result.content, details: result.structuredContent ?? {} }
    }),
  }))
}
