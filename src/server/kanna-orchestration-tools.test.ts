import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { z } from "zod"
import { ServerPlatform } from "./effect/runtime"
import { ORCHESTRATION_TOOLS } from "./kanna-orchestration-tools"
import { KannaToolRuntime } from "./kanna-tools"
import { testPlatformContext } from "./platform/testing"

/** Upstream's zod schemas for the tools that take a title, as the reference the Effect schemas must match. */
const upstreamRunOptions = {
  provider: z.string().optional().describe("claude, codex, cursor, grok or pi. Defaults to the chat's own. get_context lists them."),
  model: z.string().optional().describe("A model id from get_context. Defaults to the chat's own when the provider is unchanged."),
  effort: z.string().optional().describe("Reasoning effort, where the provider has one."),
  planMode: z.boolean().optional().describe("Run read-only, to plan without editing. Always on when this chat is in plan mode."),
}

const UPSTREAM_TITLE_DESCRIPTION = "Required: a short title for the work this chat does. The chat list is the user's record of what was worked on, one chat per piece of work."

function upstreamRequiredTitle(message: string) {
  return z.string({ error: message }).trim().min(1, { error: message })
}

const upstreamCreateChat = z.strictObject({
  message: z.string().min(1).describe("The chat's first message. It sees nothing else of this conversation, so say everything it needs."),
  title: upstreamRequiredTitle("create_chat needs a title: name the work the new chat does.").describe(UPSTREAM_TITLE_DESCRIPTION),
  subchat: z.boolean().optional().describe("Default true: its result is sent back to this chat when it finishes, and stopping this chat stops it. false makes an independent chat for the user."),
  projectId: z.string().optional().describe("Defaults to this chat's project."),
  ...upstreamRunOptions,
})

const upstreamForkChat = z.strictObject({
  chatId: z.string().optional().describe("The chat to copy. Defaults to this one, copied as of its last finished turn."),
  message: z.string().optional().describe("A first message for the copy. Without one it sits idle."),
  title: upstreamRequiredTitle("fork_chat needs a title: a fork does new work, and is named for it.").describe("Required: a short title for the new work the fork does, not the original's. A fork is how a chat's context is reused for new work, so it is named for that work."),
  subchat: z.boolean().optional().describe("Whether the copy reports back to this chat. Defaults to true when a message is given."),
  ...upstreamRunOptions,
})

const upstreamSendMessage = z.strictObject({
  chatId: z.string(),
  message: z.string().min(1),
  title: upstreamRequiredTitle("send_message needs a title: the chat's current one to keep it for a follow-up on its work, or a new one if it takes on new work (prefer fork_chat for that).").describe("Required. For a follow-up on the chat's own work, pass its current title to keep it, or a sharper one. If the message takes the chat on to new work, the title must change to that work, but prefer fork_chat: a fork, titled for the new work, keeps each chat one timeline. Renames the chat before the message goes; only a sub-chat of this one, one it started or adopts (adopt). The result says whether it changed (titleChanged)."),
  delivery: z.enum(["queue", "steer"]).optional().describe("queue (default) starts it now if the chat is idle and after its current turn otherwise. steer interrupts the current turn to deliver it now."),
  adopt: z.boolean().optional().describe("true adopts the chat: this chat becomes its parent, as if it had started it. Use it when you hand work to an existing chat and need the result. From this message on, its reply arrives here as a message when its turn ends, it is listed as this chat's sub-chat, and this chat is not finished while that reply is owed. It stays adopted: later messages need no flag, and there is no undo. It is still the user's chat: it stays in their sidebar, and stopping this chat does not stop it, only drops the reply it owes. A chat that had another parent is taken from it, and that parent is told no more results are coming. A chat above this one, in the chain of chats that started it, cannot be adopted. Leave it unset for a message that needs no answer."),
  ...upstreamRunOptions,
})

test("a chat write the call started runs to the end when the call is cancelled", async () => {
  const entered = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  let created = false
  const createChat = ORCHESTRATION_TOOLS.find((tool) => tool.name === "create_chat")!
  const orchestrator = {
    createChat: () => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(Effect.sync(() => { created = true; return { chatId: "chat-2" } })),
    ),
  }
  const context = {
    chatId: "chat-1",
    cwd: "/project",
    orchestration: orchestrator as never,
    requestInput: () => Effect.succeed(""),
  }
  const fiber = Effect.runFork(createChat.execute({ message: "Do it", title: "  The work  " }, context).pipe(Effect.provide(ServerPlatform)))
  await Effect.runPromise(Deferred.await(entered))
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await interrupted
  // Interrupting between its steps would leave a chat with no first message.
  expect(created).toBe(true)
})

test("create_chat, fork_chat and send_message refuse a missing or blank title as zod did, and pass it trimmed", async () => {
  const seen: unknown[] = []
  const orchestration = {
    createChat: (_actor: string, input: unknown) => Effect.sync(() => { seen.push(input); return {} }),
    forkChat: (_actor: string, input: unknown) => Effect.sync(() => { seen.push(input); return {} }),
    sendMessage: (_actor: string, input: unknown) => Effect.sync(() => { seen.push(input); return {} }),
  }
  const runtime = new KannaToolRuntime({
    platform: testPlatformContext,
    chatId: "chat-1", cwd: "/project", emit: async () => {}, requestInput: async () => ({}),
    orchestration: orchestration as never,
  }, ORCHESTRATION_TOOLS)
  const cases = [
    ["create_chat", upstreamCreateChat, { message: "m" }],
    ["create_chat", upstreamCreateChat, { message: "m", title: "   " }],
    ["create_chat", upstreamCreateChat, { message: "m", title: 3 }],
    ["fork_chat", upstreamForkChat, {}],
    ["send_message", upstreamSendMessage, { chatId: "c", message: "m", title: "" }],
  ] as const
  for (const [name, schema, input] of cases) {
    const result = await runtime.execute(name, input)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(schema.safeParse(input).error!.message)
  }
  expect(seen).toEqual([])
  await runtime.execute("send_message", { chatId: "c", message: "m", title: "  Sharper  " })
  expect(seen).toEqual([{ chatId: "c", message: "m", title: "Sharper" }])
})

test("orchestration tools expose the original strict object schemas", () => {
  const tools = Object.fromEntries(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool]))
  const reference = {
    get_context: z.strictObject({}),
    list_chats: z.strictObject({
      projectId: z.string().optional().describe("Only chats in this project."),
      query: z.string().optional().describe("Text to find in titles and each chat's latest messages."),
      status: z.enum(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]).optional().describe("waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
      parentChatId: z.string().optional().describe("Only sub-chats of this chat."),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
      offset: z.number().int().min(0).optional(),
    }),
    create_chat: upstreamCreateChat,
    fork_chat: upstreamForkChat,
    send_message: upstreamSendMessage,
  }
  for (const [name, schema] of Object.entries(reference)) {
    expect(JSON.parse(JSON.stringify(tools[name]!.inputSchema))).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(schema))))
  }
})

test("native orchestration tools preserve invalid argument text and transcript content", async () => {
  const events: Array<{ kind: string; content?: unknown }> = []
  const runtime = new KannaToolRuntime({
    platform: testPlatformContext,
    chatId: "chat-1", cwd: "/project", emit: async (entry) => { events.push(entry) },
    requestInput: async () => ({}),
    orchestration: { getContext: () => Effect.succeed({ chatId: "chat-1" }) } as never,
  }, ORCHESTRATION_TOOLS)
  const invalid = await runtime.execute("get_context", { unexpected: true })
  expect(invalid.isError).toBe(true)
  expect(invalid.content[0]!.text).toBe(z.strictObject({}).safeParse({ unexpected: true }).error!.message)
  const result = await runtime.execute("get_context", {})
  expect(result).toEqual({ content: [{ type: "text", text: '{"chatId":"chat-1"}' }] })
  expect(events.at(-1)?.content).toEqual({ chatId: "chat-1" })
  const unavailable = new KannaToolRuntime({
    platform: testPlatformContext,
    chatId: "chat-1", cwd: "/project", emit: async () => {}, requestInput: async () => ({}),
  }, ORCHESTRATION_TOOLS)
  expect(await unavailable.execute("get_context", {})).toEqual({
    content: [{ type: "text", text: "The chat tools are not available in this session." }], isError: true,
  })
})
