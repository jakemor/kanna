import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createKannaMcpServer } from "./kanna-mcp"
import { parseToolArgs, resolveToolName, runKannaToolCli, toolHelp } from "./kanna-tool-cli"
import { createKannaToolGateway, KANNA_CHAT_ID_ENV, KANNA_TOOLS_AUTH_ENV, KANNA_TOOLS_URL_ENV, type KannaToolGateway } from "./kanna-tool-gateway"
import { KANNA_TOOL_NAMES, KannaToolRuntime, kannaToolSpecs } from "./kanna-tools"
import type { ChatOrchestrator } from "./orchestrator"

type Spec = Parameters<typeof toolHelp>[0]
const spec = (name: string) => kannaToolSpecs().find((tool) => tool.name === name)! as Spec

async function cli(argv: string[], options: { env?: Record<string, string | undefined>; stdin?: string } = {}) {
  let stdout = "", stderr = ""
  const code = await runKannaToolCli(argv, {
    env: options.env ?? {},
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
    readStdin: async () => options.stdin ?? "",
  })
  return { code, stdout, stderr }
}

describe("one registry, two surfaces", () => {
  test("every tool the MCP server lists is a CLI command, and nothing else is", async () => {
    const runtime = new KannaToolRuntime({ chatId: "chat-1", cwd: "/project", emit: async () => {}, requestInput: async () => ({}) })
    const server = createKannaMcpServer(runtime)
    const client = new Client({ name: "test", version: "1" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
      const mcpTools = (await client.listTools()).tools
      const listed = await cli(["tools", "list", "--json"])
      expect(listed.code).toBe(0)
      const cliTools = JSON.parse(listed.stdout) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>
      expect(cliTools.map((tool) => tool.name)).toEqual(mcpTools.map((tool) => tool.name))
      expect(cliTools.map((tool) => tool.name)).toEqual([...KANNA_TOOL_NAMES])

      const text = (await cli(["tools", "list"])).stdout
      for (const tool of mcpTools) {
        expect(text).toContain(tool.name)
        // Each command takes exactly the MCP tool's parameters, under both spellings.
        expect(resolveToolName(tool.name)).toBe(tool.name)
        expect(resolveToolName(tool.name.replaceAll("_", "-"))).toBe(tool.name)
        const help = await cli([tool.name.replaceAll("_", "-"), "--help"])
        expect(help.code).toBe(0)
        const flags = [...help.stdout.matchAll(/^ {2}--(\w+) </gm)].map((match) => match[1])
        expect(flags).toEqual(Object.keys(tool.inputSchema.properties ?? {}))
      }
    } finally {
      await client.close()
      server.close()
    }
  })

  test("a name that is no tool is refused with a pointer to the list", async () => {
    const result = await cli(["make_coffee"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("tools list")
  })
})

describe("arguments from the schema", () => {
  const noStdin = async () => { throw new Error("stdin read") }

  test("flags take their schema's type, under camelCase or kebab-case names", async () => {
    const { input } = await parseToolArgs(spec("create_chat"), [
      "--title", "Fix the build", "--message=Run bun test", "--delegator", "false",
      "--show-in-sidebar", "--planMode=true", "--model", "gpt-5",
    ], noStdin)
    expect(input).toEqual({ title: "Fix the build", message: "Run bun test", delegator: false, showInSidebar: true, planMode: true, model: "gpt-5" })
  })

  test("numbers are numbers and arrays are JSON", async () => {
    const { input } = await parseToolArgs(spec("read_chat"), ["--chatId", "c1", "--lastTurns", "2", "--kinds", '["reply","tool_call"]', "--after=-1"], noStdin)
    expect(input).toEqual({ chatId: "c1", lastTurns: 2, kinds: ["reply", "tool_call"], after: -1 })
    const schedule = await parseToolArgs(spec("set_schedule"), ["--weekdays", "[1,2,3]", "--everyMinutes", "7.5"], noStdin)
    expect(schedule.input).toEqual({ weekdays: [1, 2, 3], everyMinutes: 7.5 })
  })

  test("--json and stdin give every parameter at once, and flags override them", async () => {
    const fromJson = await parseToolArgs(spec("list_chats"), ["--json", '{"limit":5,"status":"idle"}', "--limit", "2"], noStdin)
    expect(fromJson.input).toEqual({ limit: 2, status: "idle" })
    const stdin = async () => '{"chatId":"c1","kinds":["reply"]}'
    expect((await parseToolArgs(spec("read_chat"), ["-"], stdin)).input).toEqual({ chatId: "c1", kinds: ["reply"] })
    expect((await parseToolArgs(spec("read_chat"), ["--json", "-", "--chatId", "c2"], stdin)).input).toEqual({ chatId: "c2", kinds: ["reply"] })
  })

  test("--text and --help are the CLI's own", async () => {
    expect(await parseToolArgs(spec("get_context"), ["--text"], noStdin)).toEqual({ input: {}, text: true, help: false })
    expect((await parseToolArgs(spec("get_context"), ["-h"], noStdin)).help).toBe(true)
  })

  test("a bad value or an unknown flag is a usage error, exit 2", async () => {
    for (const argv of [
      ["create_chat", "--delegator", "maybe"],
      ["list_chats", "--limit", "ten"],
      ["read_chat", "--kinds", "reply"],
      ["list_chats", "--colour", "red"],
      ["list_chats", "stray"],
      ["list_chats", "--json", "[1]"],
      ["list_chats", "--query"],
    ]) {
      const result = await cli(argv)
      expect(`${argv.join(" ")}: ${result.code}`).toBe(`${argv.join(" ")}: 2`)
      expect(result.stdout).toBe("")
      expect(result.stderr.length).toBeGreaterThan(0)
    }
  })
})

test("--help is the tool's description and each parameter, from its schema", async () => {
  const help = toolHelp(spec("create_chat"))
  expect(help).toStartWith("Usage: kanna create_chat [--parameter value ...] [--json '{...}' | -] [--text]\n")
  expect(help).toContain(spec("create_chat").description)
  expect(help).toContain("  --message <string>  required\n      The chat's first message.")
  expect(help).toContain("  --delegator <boolean>  required\n")
  expect(help).toContain("  --subchat <boolean>\n      Default true")
  expect(toolHelp(spec("send_message"))).toContain("  --delivery <queue|steer>\n")
  expect(toolHelp(spec("read_chat"))).toContain("  --kinds <JSON array>\n")
  expect(toolHelp(spec("request_secrets"))).toContain("Each item: { key: string, label?: string, description?: string, secret?: boolean, optional?: boolean }")
  expect(toolHelp(spec("get_context"))).toContain("Parameters: none")
})

describe("calls through the gateway", () => {
  const chats = new Map([["chat-1", "Fix the build"], ["chat-2", "Write docs"]])
  const orchestration = {
    getContext: (chatId: string) => ({ chat: { chatId, title: chats.get(chatId) } }),
    listChats: (input: { limit?: number }) => ({
      total: chats.size,
      chats: [...chats].slice(0, input.limit ?? 30).map(([chatId, title]) => ({ chatId, title })),
    }),
  } as unknown as ChatOrchestrator
  let gateway: KannaToolGateway | undefined
  let dataDir: string | undefined
  afterEach(async () => {
    gateway?.close()
    gateway = undefined
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  function setup(options: { live?: Set<string>; requestInput?: (request: unknown, signal: AbortSignal) => Promise<unknown> } = {}) {
    const live = options.live ?? new Set(chats.keys())
    gateway = createKannaToolGateway({ isLive: (chatId) => live.has(chatId) })
    const env = (chatId: string) => gateway!.register(chatId, new KannaToolRuntime({
      chatId, cwd: "/project", emit: async () => {}, orchestration, projectId: "p1",
      requestInput: async (request, signal) => options.requestInput?.(request, signal) ?? {},
    }))
    return { env, live }
  }

  test("get_context and list_chats answer as the calling chat, in JSON", async () => {
    const { env } = setup()
    const context = await cli(["get_context"], { env: env("chat-2") })
    expect(context).toMatchObject({ code: 0, stderr: "" })
    expect(JSON.parse(context.stdout)).toMatchObject({ chat: { chatId: "chat-2", title: "Write docs" }, cli: expect.stringContaining(" <tool>") })

    const listed = await cli(["list-chats", "--limit", "1"], { env: env("chat-1") })
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual({ total: 2, chats: [{ chatId: "chat-1", title: "Fix the build" }] })
    // --text is the tool's own reply, which for these is JSON text too.
    expect((await cli(["list_chats", "--text"], { env: env("chat-1") })).stdout).toContain('"total":2')
  })

  test("the real command, as an agent's shell runs it", async () => {
    const { env } = setup()
    const entry = path.join(import.meta.dir, "entry.ts")
    const child = Bun.spawn([process.execPath, entry, "get_context"], { env: { ...process.env, ...env("chat-1") }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout).chat).toEqual({ chatId: "chat-1", title: "Fix the build" })
  })

  test("a tool's own error goes to stderr with exit 1", async () => {
    const { env } = setup()
    const result = await cli(["read_chat", "--chatId", "c1"], { env: env("chat-1") })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith("kanna read_chat: ")
  })

  test("no credential, a wrong one, another chat's, or a deleted chat's is refused", async () => {
    const { env, live } = setup()
    const good = env("chat-1")

    const none = await cli(["get_context"], { env: {} })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain("only inside a Kanna chat")

    const wrong = await cli(["get_context"], { env: { ...good, [KANNA_TOOLS_AUTH_ENV]: "not-the-credential" } })
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain("Not authorized")
    expect(wrong.stdout).toBe("")

    const mismatched = await cli(["get_context"], { env: { ...good, [KANNA_CHAT_ID_ENV]: "chat-2" } })
    expect(mismatched.code).toBe(1)
    expect(mismatched.stderr).toContain("belongs to another chat")

    const url = good[KANNA_TOOLS_URL_ENV]!
    const fromBrowser = await fetch(`${url}/tools/get_context`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${good[KANNA_TOOLS_AUTH_ENV]}`, origin: "https://evil.example" } })
    expect(fromBrowser.status).toBe(403)

    live.delete("chat-1")
    const gone = await cli(["get_context"], { env: good })
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain("no longer exists")
    // And its credential is forgotten, even if the chat came back.
    live.add("chat-1")
    expect((await cli(["get_context"], { env: good })).stderr).toContain("Not authorized")
  })

  test("a chat keeps one credential across its turns, and each chat has its own", () => {
    const { env } = setup()
    expect(env("chat-1")[KANNA_TOOLS_AUTH_ENV]).toBe(env("chat-1")[KANNA_TOOLS_AUTH_ENV]!)
    expect(env("chat-1")[KANNA_TOOLS_AUTH_ENV]).not.toBe(env("chat-2")[KANNA_TOOLS_AUTH_ENV]!)
    expect(env("chat-1")[KANNA_TOOLS_AUTH_ENV]!.length).toBeGreaterThanOrEqual(40)
  })

  test("request_secrets blocks until the user answers, and says so on stderr", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "kanna-tool-cli-"))
    let answer!: (value: unknown) => void
    let asked = false
    const { env } = setup({
      requestInput: (_request) => new Promise((resolve) => {
        asked = true
        answer = resolve
      }),
    })
    const call = cli(["request_secrets", "--reason", "Deploy", "--fields", '[{"key":"FLY_API_TOKEN"}]'], { env: env("chat-1") })
    const deadline = Date.now() + 5_000
    while (!asked && Date.now() < deadline) await Bun.sleep(10)
    expect(asked).toBe(true)
    let settled = false
    void call.then(() => { settled = true })
    await Bun.sleep(50)
    expect(settled).toBe(false)
    answer({ saved: ["FLY_API_TOKEN"], skipped: [] })
    const result = await call
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("Waiting for the user")
    expect(JSON.parse(result.stdout)).toMatchObject({ saved: ["FLY_API_TOKEN"], skipped: [], use: expect.stringContaining("secret exec FLY_API_TOKEN") })
  })
})
