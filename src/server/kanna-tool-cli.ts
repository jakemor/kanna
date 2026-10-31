import process from "node:process"
import { CLI_COMMAND } from "../shared/branding"
import { KANNA_CHAT_ID_ENV, KANNA_TOOLS_AUTH_ENV, KANNA_TOOLS_URL_ENV } from "./kanna-tool-gateway"
import { KANNA_TOOLS, kannaToolSpecs, type KannaToolResult } from "./kanna-tools"

/**
 * `kanna <tool>`: every Kanna tool as a shell command, for an agent to script
 * with. Nothing here names a tool. The commands, their flags and their help
 * are read off `KANNA_TOOLS`, through the same JSON schemas the MCP servers
 * list, so a tool added there is a command here too.
 *
 * A call goes to the running server's tool gateway (kanna-tool-gateway.ts)
 * with the credential the chat's harness put in the shell's environment, and
 * runs as that chat, as its MCP tools do. The result is JSON on stdout;
 * anything wrong goes to stderr with a non-zero exit.
 */

interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  anyOf?: JsonSchema[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
}

type ToolSpec = ReturnType<typeof kannaToolSpecs>[number] & { inputSchema: JsonSchema }

export interface KannaToolCliDeps {
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
  readStdin: () => Promise<string>
  fetch?: typeof fetch
  /** How help shows the command. */
  command?: string
}

class UsageError extends Error {}

function specs(): ToolSpec[] {
  return kannaToolSpecs() as ToolSpec[]
}

/** `create_chat`, `create-chat`, or the MCP name a model may have in mind. */
export function resolveToolName(name: string): string | undefined {
  const normalized = name.replace(/^mcp__kanna__/, "").replaceAll("-", "_")
  return KANNA_TOOLS.find((tool) => tool.name === normalized)?.name
}

function kebab(name: string) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function types(schema: JsonSchema): string[] {
  if (schema.anyOf) return [...new Set(schema.anyOf.flatMap(types))]
  if (Array.isArray(schema.type)) return schema.type
  return schema.type ? [schema.type] : []
}

function typeLabel(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map(String).join("|")
  const kinds = types(schema)
  if (kinds.length === 1 && kinds[0] === "array") return "JSON array"
  if (kinds.length === 1 && kinds[0] === "object") return "JSON object"
  return kinds.join("|") || "JSON"
}

/** A flag's value as the schema wants it. Arrays and objects come as JSON. */
function coerce(flag: string, raw: string, schema: JsonSchema): unknown {
  const kinds = types(schema)
  if (kinds.length === 1 && kinds[0] === "string") return raw
  if (kinds.length === 1 && kinds[0] === "boolean") {
    if (raw === "true" || raw === "false") return raw === "true"
    throw new UsageError(`--${flag} takes true or false, not ${JSON.stringify(raw)}`)
  }
  if (kinds.length > 0 && kinds.every((kind) => kind === "number" || kind === "integer")) {
    const value = Number(raw)
    if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${flag} takes a number, not ${JSON.stringify(raw)}`)
    return value
  }
  try {
    return JSON.parse(raw)
  } catch {
    if (kinds.includes("string")) return raw
    throw new UsageError(`--${flag} takes JSON (${typeLabel(schema)}), not ${JSON.stringify(raw)}`)
  }
}

function parseJsonObject(text: string, from: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new UsageError(`${from} is not JSON`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${from} must be a JSON object of the tool's parameters`)
  return value as Record<string, unknown>
}

/**
 * The tool's input from its flags: `--name value`, `--name=value`, a bare
 * `--flag` for true, camelCase or kebab-case names. `--json '{…}'`, `--json -`
 * or a lone `-` (stdin) give a base object the flags then override.
 */
export async function parseToolArgs(spec: ToolSpec, argv: string[], readStdin: () => Promise<string>): Promise<{ input: Record<string, unknown>; text: boolean; help: boolean }> {
  const properties = spec.inputSchema.properties ?? {}
  const byFlag = new Map<string, string>()
  for (const name of Object.keys(properties)) {
    byFlag.set(name, name)
    byFlag.set(kebab(name), name)
  }
  let base: Record<string, unknown> = {}
  const flags: Record<string, unknown> = {}
  let text = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--help" || arg === "-h") return { input: {}, text, help: true }
    if (arg === "--text") {
      text = true
      continue
    }
    if (arg === "-") {
      base = parseJsonObject(await readStdin(), "stdin")
      continue
    }
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}. Parameters are flags: --name value`)
    const equals = arg.indexOf("=")
    const flag = arg.slice(2, equals === -1 ? undefined : equals)
    let raw = equals === -1 ? undefined : arg.slice(equals + 1)
    if (flag === "json") {
      raw ??= argv[++index]
      if (raw === undefined) throw new UsageError("--json needs a JSON object, or - to read one from stdin")
      base = raw === "-" ? parseJsonObject(await readStdin(), "stdin") : parseJsonObject(raw, "--json")
      continue
    }
    const name = byFlag.get(flag)
    if (!name) throw new UsageError(`${spec.name} has no parameter --${flag}. Run it with --help for its parameters.`)
    const schema = properties[name]!
    if (raw === undefined) {
      const next = argv[index + 1]
      if (types(schema).includes("boolean") && (next === undefined || next.startsWith("--"))) raw = "true"
      else if (next === undefined) throw new UsageError(`--${flag} needs a value`)
      else raw = argv[++index]!
    }
    flags[name] = coerce(flag, raw, schema)
  }
  return { input: { ...base, ...flags }, text, help: false }
}

export function toolHelp(spec: ToolSpec, command: string = CLI_COMMAND): string {
  const properties = Object.entries(spec.inputSchema.properties ?? {})
  const required = new Set(spec.inputSchema.required ?? [])
  const lines = [
    `Usage: ${command} ${spec.name}${properties.length > 0 ? " [--parameter value ...]" : ""} [--json '{...}' | -] [--text]`,
    "",
    spec.description,
    "",
  ]
  if (properties.length === 0) {
    lines.push("Parameters: none")
  } else {
    lines.push("Parameters:")
    for (const [name, schema] of properties) {
      lines.push(`  --${name} <${typeLabel(schema)}>${required.has(name) ? "  required" : ""}`)
      if (schema.description) lines.push(`      ${schema.description}`)
      if (schema.items?.properties) {
        const itemRequired = new Set(schema.items.required ?? [])
        lines.push(`      Each item: { ${Object.entries(schema.items.properties).map(([key, item]) => `${key}${itemRequired.has(key) ? "" : "?"}: ${typeLabel(item)}`).join(", ")} }`)
      }
    }
  }
  lines.push(
    "",
    "Arrays and objects are JSON; booleans are true or false. --json '{...}', --json - or - (stdin) pass every parameter at once, and flags override it.",
    "The result is JSON on stdout. --text prints the tool's text reply instead. Errors go to stderr with a non-zero exit.",
  )
  return `${lines.join("\n")}\n`
}

function summary(description: string): string {
  const line = description.split("\n")[0]!
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
  return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence
}

export function toolsListText(command: string = CLI_COMMAND): string {
  const all = specs()
  const width = Math.max(...all.map((spec) => spec.name.length))
  return [
    ...all.map((spec) => `${spec.name.padEnd(width)}  ${summary(spec.description)}`),
    "",
    `Run one with ${command} <tool> [--parameter value ...]; ${command} <tool> --help lists its parameters.`,
    "",
  ].join("\n")
}

/** What a script reads: the tool's JSON value when its reply is JSON, else its text with any structured content. */
export function resultJson(result: KannaToolResult): unknown {
  const text = result.content.map((block) => block.text).join("\n")
  if (!result.structuredContent) {
    try {
      return JSON.parse(text)
    } catch {}
  }
  return { text, ...result.structuredContent }
}

export async function runKannaToolCli(argv: string[], deps: KannaToolCliDeps): Promise<number> {
  const command = deps.command ?? CLI_COMMAND
  const [first, ...rest] = argv
  try {
    if (first === "tools") {
      const [action, ...more] = rest
      if (action === undefined || action === "list") {
        const json = more.includes("--json")
        const unknown = more.find((arg) => arg !== "--json")
        if (unknown) throw new UsageError(`unexpected argument ${JSON.stringify(unknown)}`)
        if (json) deps.stdout(`${JSON.stringify(specs().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))}\n`)
        else deps.stdout(toolsListText(command))
        return 0
      }
      if (action === "--help" || action === "-h" || action === "help") {
        deps.stdout(`Usage: ${command} tools list [--json]\n       ${command} <tool> --help\n`)
        return 0
      }
      throw new UsageError(`unknown action ${JSON.stringify(action)}. Try ${command} tools list`)
    }

    const name = first === undefined ? undefined : resolveToolName(first)
    if (!name) throw new UsageError(`unknown command ${JSON.stringify(first ?? "")}. ${command} tools list names every Kanna tool; ${command} --help covers the rest.`)
    const spec = specs().find((candidate) => candidate.name === name)!
    const parsed = await parseToolArgs(spec, rest, deps.readStdin)
    if (parsed.help) {
      deps.stdout(toolHelp(spec, command))
      return 0
    }

    const url = deps.env[KANNA_TOOLS_URL_ENV]
    const auth = deps.env[KANNA_TOOLS_AUTH_ENV]
    if (!url || !auth) {
      deps.stderr(`${command} ${name}: runs only inside a Kanna chat, whose agent's shell has ${KANNA_TOOLS_URL_ENV} and ${KANNA_TOOLS_AUTH_ENV} set.\n`)
      return 1
    }
    if (KANNA_TOOLS.find((tool) => tool.name === name)?.waitsForUser) {
      deps.stderr(`Waiting for the user to answer in Kanna...\n`)
    }
    let response: Response
    try {
      response = await (deps.fetch ?? fetch)(`${url}/tools/${name}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
          ...(deps.env[KANNA_CHAT_ID_ENV] ? { "x-kanna-chat-id": deps.env[KANNA_CHAT_ID_ENV] } : {}),
        },
        body: JSON.stringify(parsed.input),
      })
    } catch {
      deps.stderr(`${command} ${name}: could not reach Kanna at ${url}. Is it still running?\n`)
      return 1
    }
    const body = await response.text()
    if (!response.ok) {
      let message = body.trim()
      try { message = (JSON.parse(body) as { error?: string }).error ?? message } catch {}
      deps.stderr(`${command} ${name}: ${message}\n`)
      return 1
    }
    const result = JSON.parse(body.trim().split("\n").at(-1)!) as KannaToolResult
    const text = result.content.map((block) => block.text).join("\n")
    if (result.isError) {
      deps.stderr(`${command} ${name}: ${text}\n`)
      return 1
    }
    deps.stdout(parsed.text ? `${text}\n` : `${JSON.stringify(resultJson(result))}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    deps.stderr(`${command}: ${error.message}\n`)
    return 2
  }
}

async function readAll(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text()
}

export async function runKannaToolCommand(argv: string[]): Promise<number> {
  return runKannaToolCli(argv, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: readAll,
  })
}
