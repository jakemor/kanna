import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { validateToolArguments } from "@mariozechner/pi-ai"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { TranscriptEntry } from "../shared/types"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import {
  CANCELLED_TOOL_RESULT,
  defineKannaTool,
  KannaToolEmitError,
  KannaToolEventFilter,
  KannaToolRuntime,
  KANNA_TOOL_NAMES,
  kannaToolSpecs,
  makeKannaToolExecutor,
  runKannaToolCall,
  type KannaTool,
  type KannaToolDefinition,
  type KannaToolSession,
} from "./kanna-tools"
import { createClaudeKannaTools, createPiKannaTools } from "./kanna-tool-adapters"
import { serveKannaMcp } from "./kanna-mcp"
import { runTest } from "./effect/testing"
import { parseTranscriptMediaUrl, getTranscriptMediaDir, retargetEntryMediaUrls } from "./transcript-media"
import { openEventStore } from "./event-store-bridge"
import { splitTranscriptEntry } from "./transcript-payloads"
import { testPlatformContext } from "./platform/testing"

const visualization = { title: "Sales", html: '<svg aria-label="Sales"><text>Jan: 10, Feb: 20</text></svg>' }
let testDataDir: string
beforeEach(async () => { testDataDir = await mkdtemp(path.join(tmpdir(), "kanna-tools-")) })
afterEach(async () => { await rm(testDataDir, { recursive: true, force: true }) })
const attachments = { attachments: [{ url: "https://example.com/chart.png" }, { url: "https://example.com/report.pdf" }] }
const inputTool = defineKannaTool({
  name: "test_input", description: "Test input", parameters: Schema.Struct({}), waitsForUser: true,
  execute: Effect.fn(function* (_args, context) {
    const value = yield* context.requestInput("Value")
    return { content: [{ type: "text" as const, text: value }], structuredContent: { answers: { value: [value] } } }
  }),
})
function setup(dataDir: string = testDataDir, definitions?: readonly (KannaTool | KannaToolDefinition)[]) {
  const entries: TranscriptEntry[] = []
  const replies: Array<(value: unknown) => void> = []
  const runtime = new KannaToolRuntime({ platform: testPlatformContext, chatId: "chat-1", cwd: dataDir ?? "/project", dataDir,
    emit: async entry => { entries.push(entry) },
    requestInput: async (_request, signal) => new Promise(resolve => {
      replies.push(resolve)
      signal.addEventListener("abort", () => resolve({ discarded: true }), { once: true })
    }),
  }, definitions)
  return { runtime, entries, replies }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(5) }
  throw new Error("Condition did not become true")
}

describe("shared Kanna display tools", () => {
  test("attachment inputs omit descriptions and captions", async () => {
    const spec = kannaToolSpecs().find(tool => tool.name === "send_attachments")!
    expect(Object.keys(spec.inputSchema.properties ?? {})).toEqual(["attachments"])
    expect(JSON.stringify(spec.inputSchema)).not.toContain('"caption"')
    const { runtime } = setup()
    const result = await runtime.execute("send_attachments", attachments)
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent?.attachments).toEqual([
      { type: "attachment", url: "https://example.com/chart.png", name: "chart.png", kind: "image", mimeType: "image/png", size: null },
      { type: "attachment", url: "https://example.com/report.pdf", name: "report.pdf", kind: "file", mimeType: "application/pdf", size: null },
    ])
  })
  test("replaces show_chart with a general visualization tool and keeps only metadata in headers", async () => {
    expect(KANNA_TOOL_NAMES).toEqual([
      "show_visualization", "send_attachments", "generate_images",
      "get_context", "list_chats", "read_chat", "create_chat", "fork_chat", "send_message",
      "cancel_chat", "update_chat", "update_queued_message", "set_schedule", "list_schedules", "delete_schedule",
    ])
    const { runtime, entries } = setup()
    expect(await runtime.execute("show_visualization", visualization)).toMatchObject({ structuredContent: { displayed: true } })
    expect(entries.map(entry => entry.kind)).toEqual(["tool_call", "tool_result"])
    expect(entries[0]).toMatchObject({ tool: { toolKind: "display", input: { payload: { title: "Sales" } } } })
    expect(splitTranscriptEntry(entries[0]!, () => true).payload).toBeNull()
    expect(JSON.stringify(entries)).not.toContain(visualization.html)
    expect(await runtime.execute("show_chart", {})).toMatchObject({ isError: true })
    expect(await runtime.execute("tool_test_smiley", {})).toMatchObject({ isError: true })
    expect(await runtime.execute("tool_test_input", {})).toMatchObject({ isError: true })
  })
  test("rejects ambiguous, empty, and invalid visualization inputs", async () => {
    const { runtime } = setup()
    for (const input of [{ title: "Empty" }, { ...visualization, path: "also.html" }, { ...visualization, html: "" }, { ...visualization, height: -1 }]) {
      expect(await runtime.execute("show_visualization", input)).toMatchObject({ isError: true })
    }
  })
  test("resolves media types and rejects unsafe URLs or ambiguous sources", async () => {
    const { runtime, entries } = setup()
    const result = await runtime.execute("send_attachments", attachments)
    expect(result).not.toHaveProperty("transcriptContent")
    expect(entries[1]).toMatchObject({ content: [{ kind: "image" }, { kind: "file" }] })
    expect(await runtime.execute("send_attachments", { attachments: [{ url: "https://example.com/photo?id=1", kind: "image" }] }))
      .toMatchObject({ structuredContent: { attachments: [{ kind: "image" }] } })
    for (const item of [{ url: "javascript:alert(1)" }, { url: "https://user:password@example.com/a.png" }, {}, { path: "a", url: "https://example.com/a" }]) {
      expect(await runtime.execute("send_attachments", { attachments: [item] })).toMatchObject({ isError: true })
    }
  })
  test("copies local files and retargets forked links", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-attachments-"))
    try {
      await writeFile(path.join(dir, "report.txt"), "Saved report")
      const { runtime, entries } = setup(dir)
      expect(await runtime.execute("send_attachments", { attachments: [{ path: "report.txt" }] })).not.toHaveProperty("isError")
      const result = entries[1]!
      if (result.kind !== "tool_result") throw new Error("Expected result")
      const [attachment] = result.content as Array<{ url: string }>
      const parsed = parseTranscriptMediaUrl(attachment!.url)!
      await rm(path.join(dir, "report.txt"))
      expect(await readFile(path.join(getTranscriptMediaDir(dir, "chat-1"), parsed.name), "utf8")).toBe("Saved report")
      expect(retargetEntryMediaUrls(result, "chat-1", "fork")).toMatchObject({ content: [{ url: attachment!.url.replace("chat-1", "fork") }] })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  test("display payloads survive a store restart without extra fetches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-display-store-"))
    try {
      const store = await openEventStore(dir)
      const project = await store.openProject(dir, "Display tools")
      const chat = await store.createChat(project.id)
      const runtime = new KannaToolRuntime({ platform: testPlatformContext, chatId: chat.id, cwd: dir, dataDir: dir,
        emit: entry => store.appendMessage(chat.id, entry).then(() => {}), requestInput: async () => ({}),
      })
      await runtime.execute("show_visualization", visualization)
      await runtime.execute("send_attachments", attachments)
      const reopened = await openEventStore(dir)
      await reopened.prepareTranscript(chat.id)
      const entries = reopened.getClientTranscript(chat.id).messages
      expect(entries[0]).toMatchObject({ tool: { toolKind: "display", input: { payload: { title: "Sales" } } } })
      expect(entries[3]).toMatchObject({ content: [{ type: "attachment", kind: "image" }, { type: "attachment", kind: "file" }] })
      expect(entries.every(entry => !("trimmed" in entry))).toBe(true)
      // A live push often contains only the result, after an earlier push sent its call.
      expect(store.getClientTranscript(chat.id, 3).messages).toEqual([entries[3]!])
      expect(reopened.getClientTranscript(chat.id, 3).messages).toEqual([entries[3]!])
      expect(store.getClientTranscript(chat.id, 1).messages[0]).toEqual(entries[1])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  test("keeps generic input waiting, serialization, and cancellation", async () => {
    const { runtime, replies } = setup(undefined, [inputTool])
    let resolved = false
    const first = runtime.execute("test_input", {}).then(result => { resolved = true; return result })
    const second = runtime.execute("test_input", {})
    await until(() => replies.length === 1)
    expect(resolved).toBe(false)
    replies[0]!({ answers: { value: [" exact value "] } })
    expect(await first).toMatchObject({ content: [{ text: " exact value " }] })
    await until(() => replies.length === 2)
    runtime.abort()
    expect(await second).toMatchObject({ isError: true, structuredContent: { discarded: true } })
  })
  test("suppresses provider copies without dropping other tools", () => {
    const filter = new KannaToolEventFilter()
    expect(filter.skip({ kind: "tool_call", tool: { toolName: "mcp__kanna__show_visualization", toolId: "native-1" } } as TranscriptEntry)).toBe(true)
    expect(filter.skip({ kind: "tool_result", toolId: "native-1" } as TranscriptEntry)).toBe(true)
    expect(filter.skip({ kind: "tool_result", toolId: "other" } as TranscriptEntry)).toBe(false)
  })
  test("Claude exposes and executes both tools through MCP", async () => {
    const { runtime } = setup()
    const server = createClaudeKannaTools(runtime)
    const client = new Client({ name: "test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(KANNA_TOOL_NAMES)
      expect(await client.callTool({ name: "show_visualization", arguments: visualization })).toMatchObject({ structuredContent: { displayed: true } })
      expect(await client.callTool({ name: "send_attachments", arguments: attachments })).toMatchObject({ structuredContent: { displayed: true } })
    } finally { runtime.abort(); await client.close(); await server.instance.close() }
  })
  test("Pi registers and executes both tools", async () => {
    const { runtime } = setup()
    const tools = createPiKannaTools(runtime)
    expect(tools.map(tool => tool.name)).toEqual(KANNA_TOOL_NAMES)
    for (const [index, input] of [visualization, attachments].entries()) {
      const tool = tools[index]!
      const validated = validateToolArguments(tool, { type: "toolCall", id: "pi-1", name: tool.name, arguments: input })
      expect(await tool.execute("pi-1", validated, undefined, undefined, {} as never)).toMatchObject({ details: { displayed: true } })
    }
  })
  test("Pi validation preserves HTML and optional sizing", async () => {
    const { runtime, entries } = setup()
    const tool = createPiKannaTools(runtime).find(tool => tool.name === "show_visualization")!
    const input = { ...visualization, height: 420, html: '<p data-value="001">0 &lt; 2.5</p>' }
    const validated = validateToolArguments(tool, { type: "toolCall", id: "pi-viz", name: tool.name, arguments: input })
    expect(validated).toEqual(input)
    expect(await tool.execute("pi-viz", validated, undefined, undefined, {} as never)).toMatchObject({ details: { displayed: true } })
    expect(entries[0]).toMatchObject({ tool: { input: { payload: { title: "Sales", height: 420 } } } })
    expect(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: tool.name,
      arguments: { ...input, html: { nested: true } },
    })).toThrow("Validation failed")
  })
  test("Pi validation keeps the chat tools' optional fields and number types", async () => {
    const { runtime } = setup()
    const tools = createPiKannaTools(runtime)
    const validate = (name: string, input: Record<string, unknown>) =>
      validateToolArguments(tools.find(tool => tool.name === name)!, { type: "toolCall", id: "pi-1", name, arguments: input })
    expect(validate("list_chats", { status: "running", limit: 10, offset: 20, includeArchived: true }))
      .toEqual({ status: "running", limit: 10, offset: 20, includeArchived: true })
    expect(validate("set_schedule", { message: "ping", dailyAt: "09:00", weekdays: [1, 3], planMode: true }))
      .toEqual({ message: "ping", dailyAt: "09:00", weekdays: [1, 3], planMode: true })
    expect(validate("read_chat", { chatId: "c", after: -1, textOffset: 50000, lastTurns: 1, kinds: ["reply", "tool_result"], limit: 5 }))
      .toEqual({ chatId: "c", after: -1, textOffset: 50000, lastTurns: 1, kinds: ["reply", "tool_result"], limit: 5 })
    expect(() => validate("read_chat", { chatId: "c", kinds: ["assistant"] })).toThrow("Validation failed")
    expect(validate("create_chat", { message: "go", title: "Lexer fix" })).toEqual({ message: "go", title: "Lexer fix" })
    expect(() => validate("create_chat", {})).toThrow("Validation failed")
    // Without a server behind the runtime the tools say so instead of failing oddly.
    expect(await runtime.execute("list_chats", {})).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not available") }] })
  })
  test("no tool has anything of tickets or checkpoints left", async () => {
    const names = kannaToolSpecs().map((spec) => spec.name)
    expect(names.some((name) => /ticket|checkpoint/.test(name))).toBe(false)
    expect(JSON.stringify(kannaToolSpecs())).not.toMatch(/ticket|checkpoint/i)
  })

  test("every chat tool requires a title, and leans to a fork for new work", async () => {
    const spec = (name: string) => kannaToolSpecs().find((tool) => tool.name === name)!
    const schemaOf = (name: string) => spec(name).inputSchema as unknown as { required?: string[]; properties: { title: { description: string } } }
    for (const name of ["create_chat", "fork_chat", "send_message"]) expect(schemaOf(name).required).toContain("title")
    expect(spec("fork_chat").description).toContain("The default way to take on new work that needs an existing chat's context")
    expect(schemaOf("fork_chat").properties.title.description).toContain("not the original's")
    expect(spec("send_message").description).toContain("prefer that to reusing the chat under a new title")
    const sendTitle = schemaOf("send_message").properties.title.description
    expect(sendTitle).toContain("pass its current title to keep it")
    expect(sendTitle).toContain("the title must change to that work, but prefer fork_chat")
    expect(sendTitle).toContain("titleChanged")
    // Only its own sub-chats are renamed by a message.
    expect(sendTitle).toContain("adopt")

    // Refused, with a line that says what to pass, before anything runs.
    const { runtime } = setup()
    try {
      const missing = await runtime.execute("send_message", { chatId: "other", message: "and the tests" })
      expect(missing).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("send_message needs a title") }] })
      const blank = await runtime.execute("fork_chat", { title: "  " })
      expect(blank).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("fork_chat needs a title") }] })
      expect((await runtime.execute("create_chat", { message: "go" })).content[0]!.text).toContain("create_chat needs a title")
    } finally { runtime.abort() }
  })

  test("every tool description fits in what Claude Code shows of one (2,048 characters)", () => {
    const over = kannaToolSpecs().filter((spec) => spec.description.length > 2_048).map((spec) => spec.name)
    expect(over).toEqual([])
  })
  test("HTTP MCP authenticates requests and isolates chats", async () => {
    const first = setup(), second = setup()
    const client = new Client({ name: "test", version: "1" })
    await runTest(Effect.gen(function* () {
      const servers = [yield* serveKannaMcp(first.runtime), yield* serveKannaMcp(second.runtime)]
      yield* Effect.promise(async () => {
        expect((await fetch(servers[0]!.url)).status).toBe(401)
        expect((await fetch(servers[0]!.url, { headers: servers[1]!.headers })).status).toBe(401)
        expect((await fetch(servers[0]!.url.replace("/mcp", "/other"), { headers: servers[0]!.headers })).status).toBe(401)
        expect((await fetch(servers[0]!.url, { headers: { ...servers[0]!.headers, Origin: "https://example.com" } })).status).toBe(403)
        await client.connect(new StreamableHTTPClientTransport(new URL(servers[0]!.url), { requestInit: { headers: servers[0]!.headers } }))
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(KANNA_TOOL_NAMES)
        expect(await client.callTool({ name: "show_visualization", arguments: visualization })).toMatchObject({ structuredContent: { displayed: true } })
        expect(first.entries).toHaveLength(2)
        expect(second.entries).toHaveLength(0)
        await client.close()
      })
    }))
  })
  test("HTTP MCP stops listening when its scope closes", async () => {
    const { runtime } = setup()
    const url = await runTest(serveKannaMcp(runtime).pipe(Effect.map(endpoint => endpoint.url)))
    expect(await fetch(url).then(() => "answered", () => "refused")).toBe("refused")
  })
})

describe("the Effect tool executor", () => {
  const session = (entries: TranscriptEntry[], requestInput: KannaToolSession["requestInput"] = () => Effect.never): KannaToolSession => ({
    chatId: "chat-1", cwd: testDataDir, dataDir: testDataDir,
    emit: (entry) => Effect.sync(() => { entries.push(entry) }),
    requestInput,
  })

  test("interrupting a started call records it as cancelled", async () => {
    const entries: TranscriptEntry[] = []
    const asked = Effect.runSync(Deferred.make<void>())
    await runTest(Effect.gen(function* () {
      const executor = yield* makeKannaToolExecutor(session(entries, () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never))), [inputTool])
      const fiber = yield* Effect.forkChild(executor.execute("test_input", {}))
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
    }))
    expect(entries.map(entry => entry.kind)).toEqual(["tool_call", "tool_result"])
    expect(entries[1]).toMatchObject({ kind: "tool_result", content: { discarded: true }, isError: true })
  })

  test("interrupting while the call is being recorded still records a result", async () => {
    const entries: TranscriptEntry[] = []
    await runTest(Effect.gen(function* () {
      const callWritten = yield* Deferred.make<void>()
      const releaseCall = yield* Deferred.make<void>()
      const delayedSession: KannaToolSession = {
        ...session(entries),
        emit: (entry) => Effect.gen(function* () {
          entries.push(entry)
          if (entry.kind === "tool_call") {
            yield* Deferred.succeed(callWritten, undefined)
            yield* Deferred.await(releaseCall)
          }
        }),
      }
      const executor = yield* makeKannaToolExecutor(delayedSession, [inputTool])
      const call = yield* Effect.forkChild(executor.execute("test_input", {}))
      yield* Deferred.await(callWritten)
      const interruption = yield* Effect.forkChild(Fiber.interrupt(call))
      yield* Effect.sleep("10 millis")
      yield* Deferred.succeed(releaseCall, undefined)
      yield* Fiber.join(interruption)
    }))
    expect(entries.map(entry => entry.kind)).toEqual(["tool_call", "tool_result"])
    expect(entries[1]).toMatchObject({ kind: "tool_result", content: { discarded: true }, isError: true })
  })

  test("a signal that aborts a call returns the cancelled result, and one already aborted records nothing", async () => {
    const entries: TranscriptEntry[] = []
    const executor = await runTest(makeKannaToolExecutor(session(entries), [inputTool]))
    const controller = new AbortController()
    const pending = runKannaToolCall(executor.execute("test_input", {}), controller.signal)
    await until(() => entries.length === 1)
    controller.abort()
    expect(await pending).toEqual(CANCELLED_TOOL_RESULT)
    expect(entries.map(entry => entry.kind)).toEqual(["tool_call", "tool_result"])

    expect(await runKannaToolCall(executor.execute("test_input", {}), AbortSignal.abort())).toEqual(CANCELLED_TOOL_RESULT)
    expect(entries).toHaveLength(2)
  })

  test("a failure to record the call is the call's error, and a bug in a tool is reported, not thrown", async () => {
    const failing: KannaToolSession = {
      ...session([]),
      emit: () => Effect.fail(new KannaToolEmitError({ chatId: "chat-1", message: "disk full", cause: null })),
    }
    const buggy = defineKannaTool({
      name: "buggy", description: "Throws", parameters: Schema.Struct({}),
      execute: () => Effect.sync(() => { throw new TypeError("x is not a function") }),
    })
    const executor = await runTest(makeKannaToolExecutor(failing, [buggy]))
    expect(await runKannaToolCall(executor.execute("buggy", {}))).toEqual({ content: [{ type: "text", text: "disk full" }], isError: true })
    const entries: TranscriptEntry[] = []
    const ok = await runTest(makeKannaToolExecutor(session(entries), [buggy]))
    expect(await runKannaToolCall(ok.execute("buggy", {}))).toEqual({ content: [{ type: "text", text: "x is not a function" }], isError: true })
    expect(entries.map(entry => entry.kind)).toEqual(["tool_call", "tool_result"])
  })

  test("a zod tool with a Promise body still runs, with zod's error text and the call's signal", async () => {
    let seen: AbortSignal | undefined
    const legacy: KannaToolDefinition = {
      name: "legacy", description: "A zod tool", schema: z.strictObject({ count: z.number().int() }),
      execute: (input, context) => {
        seen = context.signal
        return new Promise(resolve => context.signal.addEventListener("abort", () => resolve({ content: [{ type: "text", text: String(input.count) }] })))
      },
    }
    const { runtime, entries } = setup(testDataDir, [legacy])
    expect(kannaToolSpecs().some(spec => spec.name === "legacy")).toBe(false)
    expect((await runtime.execute("legacy", { count: 1.5 })).content[0]!.text).toBe(z.strictObject({ count: z.number().int() }).safeParse({ count: 1.5 }).error!.message)
    const pending = runtime.execute("legacy", { count: 2 })
    await until(() => seen !== undefined)
    runtime.abort()
    expect(await pending).toEqual(CANCELLED_TOOL_RESULT)
    expect(seen!.aborted).toBe(true)
    expect(entries.at(-1)).toMatchObject({ kind: "tool_result", content: { discarded: true } })
  })

  test("a reply that does not answer the question is the call's error", async () => {
    const executor = await runTest(makeKannaToolExecutor(session([], () => Effect.succeed({ answers: { value: [] } })), [inputTool]))
    const result = await runKannaToolCall(executor.execute("test_input", {}))
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Too small: expected array to have >=1 items")
    const exit = await Effect.runPromiseExit(executor.execute("nope", {}))
    expect(Exit.isSuccess(exit) && exit.value.content[0]!.text).toBe("Unknown Kanna tool: nope")
  })
})
