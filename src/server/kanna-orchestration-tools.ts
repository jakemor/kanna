import { z } from "zod"
import type { AgentProvider } from "../shared/types"
import type { KannaToolDefinition, KannaToolResult } from "./kanna-tools"
import { DELEGATOR_DESCRIPTION, DELEGATOR_REQUIRED, READ_CHAT_KINDS, type ChatOrchestrator } from "./orchestrator"

/**
 * The chat tools: what a user can do to chats in Kanna, for an agent to do.
 * The rules live in `orchestrator.ts`; these are the schemas and the words
 * the model reads. `harness-instructions.ts` says when to reach for which.
 *
 * The schemas avoid unions on purpose. Each harness converts them its own
 * way (see `kanna-tool-adapters.ts`), and flat optional fields survive all of
 * them.
 */

const runOptions = {
  provider: z.string().optional().describe("claude, codex, cursor, grok or pi. Defaults to the chat's own. get_context lists them."),
  model: z.string().optional().describe("A model id from get_context. Defaults to the chat's own when the provider is unchanged."),
  effort: z.string().optional().describe("Reasoning effort, where the provider has one."),
  planMode: z.boolean().optional().describe("Run read-only, to plan without editing. Always on when this chat is in plan mode."),
}

/**
 * The result goes to the provider as JSON text only, so a large read is not
 * sent twice. The transcript keeps the value itself, which is what a chat
 * card reads the chat's id from.
 */
function reply(value: unknown): KannaToolResult & { transcriptContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], transcriptContent: value }
}

function orchestration(context: { orchestration?: ChatOrchestrator }) {
  if (!context.orchestration) throw new Error("The chat tools are not available in this session.")
  return context.orchestration
}

type Run = { provider?: AgentProvider; model?: string; effort?: string; planMode?: boolean }

const getContext = z.strictObject({})

const listChats = z.strictObject({
  projectId: z.string().optional().describe("Only chats in this project."),
  query: z.string().optional().describe("Text to find in titles and each chat's latest messages."),
  status: z.enum(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]).optional()
    .describe("waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
  parentChatId: z.string().optional().describe("Only sub-chats of this chat."),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
  offset: z.number().int().min(0).optional(),
})

const readChat = z.strictObject({
  chatId: z.string(),
  after: z.number().int().min(-1).optional().describe("Entries after this index, oldest first. -1 reads from the start."),
  before: z.number().int().min(0).optional().describe("The latest entries before this index."),
  textOffset: z.number().int().min(0).optional().describe("With after: start the first entry at this character. next sets it to finish a cut entry."),
  lastTurns: z.number().int().min(1).optional().describe("Only the last N turns. A turn starts at a prompt; 1 is the latest turn."),
  kinds: z.array(z.enum(READ_CHAT_KINDS)).optional().describe("Entry kinds to return. Default: user_prompt, report, assistant_text, result, interrupted. reply is each turn's final assistant_text."),
  limit: z.number().int().min(1).max(200).optional().describe("Most entries per call. Default 40."),
})

/**
 * A chat's title, which the sidebar shows. Each chat is one piece of work,
 * and the user scans the chat list for what was worked on: a title names its
 * chat's work, and new work gets a chat of its own (a new one, or a fork).
 */
const TITLE_DESCRIPTION = "Required: a short title for the work this chat does. The chat list is the user's record of what was worked on, one chat per piece of work."

/**
 * Where a chat is shown. Hiding delegated work is the default, so the field
 * is for when the user asks, the way T3 Code's `create_threads` is: a model
 * told only what it does lists every chat it makes, and the sidebar fills
 * with work the user never meant to watch.
 */
const SHOW_IN_SIDEBAR_DESCRIPTION = "Lists the chat in the user's sidebar (true) or leaves it out (false). By default a sub-chat is left out and shown under this chat, and any other chat is listed. Pass it only when the user asks to see the chat in their sidebar, or for a separate chat. A sub-chat in the sidebar is still a sub-chat: it reports here."

/** A title the tool will not go without, refused with a line that says what to pass. */
function requiredTitle(message: string) {
  return z.string({ error: message }).trim().min(1, { error: message })
}

const createChat = z.strictObject({
  message: z.string().min(1).describe("The chat's first message. It sees nothing else of this conversation, so say everything it needs."),
  title: requiredTitle("create_chat needs a title: name the work the new chat does.").describe(TITLE_DESCRIPTION),
  subchat: z.boolean().optional().describe("Default true: its result is sent back to this chat when it finishes, and stopping this chat stops it. false makes an independent chat for the user."),
  showInSidebar: z.boolean().optional().describe(SHOW_IN_SIDEBAR_DESCRIPTION),
  delegator: z.boolean({ error: DELEGATOR_REQUIRED("create_chat") }).describe(DELEGATOR_DESCRIPTION),
  projectId: z.string().optional().describe("Defaults to this chat's project."),
  ...runOptions,
})

const forkChat = z.strictObject({
  chatId: z.string().optional().describe("The chat to copy. Defaults to this one, copied as of its last finished turn."),
  message: z.string().optional().describe("A first message for the copy. Without one it sits idle."),
  title: requiredTitle("fork_chat needs a title: a fork does new work, and is named for it.").describe("Required: a short title for the new work the fork does, not the original's. A fork is how a chat's context is reused for new work, so it is named for that work."),
  subchat: z.boolean().optional().describe("Whether the copy reports back to this chat. Defaults to true when a message is given."),
  showInSidebar: z.boolean().optional().describe(SHOW_IN_SIDEBAR_DESCRIPTION),
  delegator: z.boolean().optional().describe("Defaults to the original's role, which suits a fork: it carries on the same conversation, and a new role changes its system prompt under that history. Pass it to change the role: true for a chat that coordinates sub-chats of its own and does none of the work, false for one that does the work."),
  ...runOptions,
})

const sendMessage = z.strictObject({
  chatId: z.string(),
  message: z.string().min(1),
  title: requiredTitle("send_message needs a title: the chat's current one to keep it for a follow-up on its work, or a new one if it takes on new work (prefer fork_chat for that).").describe("Required. For a follow-up on the chat's own work, pass its current title to keep it, or a sharper one. If the message takes the chat on to new work, the title must change to that work, but prefer fork_chat: a fork, titled for the new work, keeps each chat one timeline. Renames the chat before the message goes; only a sub-chat of this one, one it started or adopts (adopt). The result says whether it changed (titleChanged)."),
  delivery: z.enum(["queue", "steer"]).optional().describe("queue (default) starts it now if the chat is idle and after its current turn otherwise. steer interrupts the current turn to deliver it now."),
  adopt: z.boolean().optional().describe("true adopts the chat: this chat becomes its parent, as if it had started it. Use it when you hand work to an existing chat and need the result. From this message on, its reply arrives here as a message when its turn ends, it is listed as this chat's sub-chat, and this chat is not finished while that reply is owed. It stays adopted: later messages need no flag, and there is no undo. It is still the user's chat: it stays in their sidebar, and stopping this chat does not stop it, only drops the reply it owes. A chat that had another parent is taken from it, and that parent is told no more results are coming. A chat above this one, in the chain of chats that started it, cannot be adopted. Leave it unset for a message that needs no answer."),
  showInSidebar: z.boolean().optional().describe("Lists the chat in the user's sidebar (true) or takes it out (false), once the message is sent. Only for a sub-chat of this one: one it started, or adopts with this message. Pass it only when the user asks to see the chat in their sidebar, or to put it away there. It stays a sub-chat either way."),
  ...runOptions,
})

const cancelChat = z.strictObject({
  chatId: z.string(),
  cascade: z.boolean().optional().describe("Default true: the sub-chats it started stop too. false stops only its own turn, and they go on and still report to it."),
})

const updateChat = z.strictObject({
  chatId: z.string().optional().describe("Defaults to this chat."),
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  done: z.boolean().optional().describe("Mark the chat done, or not done."),
  archived: z.boolean().optional().describe("true puts the chat away; it does not stop a running turn. false brings it back."),
  showInSidebar: z.boolean().optional().describe("Lists the chat in the user's sidebar (true) or takes it out (false). Only for a sub-chat of this one: one it started or adopted. Pass it only when the user asks to see the chat in their sidebar, or to put it away there. It stays a sub-chat either way."),
  delegator: z.boolean().optional().describe("true makes the chat a delegator, which hands work to other chats; false makes it do its work itself. Takes effect on its next turn, which restarts its provider session."),
  provider: z.string().optional().describe("claude, codex, cursor, grok or pi, for the chat's next turn. get_context lists them."),
  model: z.string().optional().describe("A model id from get_context, for the chat's next turn. Defaults to the chat's own when the provider is unchanged."),
  effort: z.string().optional().describe("Reasoning effort for the chat's next turn, one the model offers. get_context lists each provider's."),
  planMode: z.boolean().optional().describe("Run the chat's next turn read-only, to plan without editing. Always on when this chat is in plan mode."),
})

const updateQueuedMessage = z.strictObject({
  chatId: z.string(),
  queuedMessageId: z.string().describe("From read_chat's queue."),
  action: z.enum(["remove", "send_now"]).describe("send_now interrupts the chat's current turn to deliver it."),
})

const setSchedule = z.strictObject({
  scheduleId: z.string().optional().describe("Change this schedule. Omit to create one."),
  name: z.string().optional(),
  message: z.string().optional().describe("What to send. Required for a new schedule."),
  chatId: z.string().optional().describe("The chat to send it to. Defaults to this chat. A delegator points it at a sub-chat made for the automation."),
  newChat: z.boolean().optional().describe("Send it to a new chat on each run, instead of to an existing one."),
  delegator: z.boolean().optional().describe(`With newChat, required when the schedule is made: what each new chat is. ${DELEGATOR_DESCRIPTION}`),
  projectId: z.string().optional().describe("With newChat: the project for the new chats. Defaults to this chat's."),
  inMinutes: z.number().min(0).optional().describe("Once, this many minutes from now."),
  runAt: z.string().optional().describe("Once, at this ISO 8601 time."),
  everyMinutes: z.number().min(1).optional().describe("Repeatedly, this often."),
  dailyAt: z.string().optional().describe("Every day at this 24-hour HH:MM, in the server's time zone (see get_context)."),
  weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("With dailyAt: only these days, 0 for Sunday."),
  enabled: z.boolean().optional().describe("false pauses it."),
  maxRuns: z.number().int().min(1).optional().describe("Stop after this many runs."),
  ...runOptions,
})

const listSchedules = z.strictObject({
  chatId: z.string().optional().describe("Only schedules that send to this chat."),
  includeDisabled: z.boolean().optional(),
})

const deleteSchedule = z.strictObject({
  scheduleId: z.string(),
})

export const ORCHESTRATION_TOOLS: readonly KannaToolDefinition[] = [
  {
    name: "get_context",
    description: "Where you are in Kanna: this chat's id, project, provider and model; the other projects; the providers and models a chat can run on; the current time.",
    schema: getContext,
    async execute(_input, context) {
      return reply(orchestration(context).getContext(context.chatId))
    },
  },
  {
    name: "list_chats",
    description: "List Kanna chats, newest first, with each one's status. Covers every project unless projectId is given.",
    schema: listChats,
    async execute(input, context) {
      return reply(orchestration(context).listChats(listChats.parse(input)))
    },
  },
  {
    name: "read_chat",
    description: "Read a chat: its status, sub-chats, queue and transcript. Entries come whole, up to 50,000 characters a call. One longer than what is left is cut, marked truncated, and finished by passing next back. Each entry has an index. With no position given, returns the latest entries. after reads forward from an index, before reads back from one, and lastTurns keeps to the latest turns (1 is the last turn). kinds filters entries: the default is what was said (prompts, reports, the agent's text, failures and stops); [\"reply\"] is just the agent's final reply in each turn; add tool_call and tool_result for tool inputs and outputs. next and earlier, when present, are the arguments for the page after and the page before.",
    schema: readChat,
    async execute(input, context) {
      return reply(orchestration(context).readChat(readChat.parse(input)))
    },
  },
  {
    name: "create_chat",
    description: "Start a new chat for new work, with a first message, on any provider and model, and a title naming that work (required). Returns at once. By default it is a sub-chat of this one: its reply arrives here as a message when its turn ends. If it is still waiting on work it handed off, the message says so and another follows when that work comes back.",
    schema: createChat,
    async execute(input, context) {
      const { message, title, subchat, showInSidebar, delegator, projectId, ...run } = createChat.parse(input)
      return reply(await orchestration(context).createChat(context.chatId, { message, title, subchat, showInSidebar, delegator, projectId, ...(run as Run) }))
    },
  },
  {
    name: "fork_chat",
    description: "Copy a chat, conversation included, into a new chat that continues separately. The default way to take on new work that needs an existing chat's context: the fork does the new work, under a title for it (required), and the original stays one timeline, untouched.",
    schema: forkChat,
    async execute(input, context) {
      const { chatId, message, title, subchat, showInSidebar, delegator, ...run } = forkChat.parse(input)
      return reply(await orchestration(context).forkChat(context.chatId, { chatId, message, title, subchat, showInSidebar, delegator, ...(run as Run) }))
    },
  },
  {
    name: "send_message",
    description: "Send a message to another chat, as the user would: a follow-up on the work it is doing, with its title (required: unchanged, or sharpened). New work goes to a new chat (create_chat), or, when it needs a chat's context, to a fork of it (fork_chat): prefer that to reusing the chat under a new title. It starts a turn if the chat is idle and queues behind the current turn otherwise. A chat this one did not start sends nothing back when it finishes, unless this chat adopts it (adopt). To change a chat's settings without a message, use update_chat.",
    schema: sendMessage,
    async execute(input, context) {
      const { chatId, message, title, delivery, adopt, showInSidebar, ...run } = sendMessage.parse(input)
      return reply(await orchestration(context).sendMessage(context.chatId, { chatId, message, title, delivery, adopt, showInSidebar, ...(run as Run) }))
    },
  },
  {
    name: "cancel_chat",
    description: "Stop a chat's current turn, and every sub-chat running under it.",
    schema: cancelChat,
    async execute(input, context) {
      const { chatId, cascade } = cancelChat.parse(input)
      return reply(await orchestration(context).cancelChat(context.chatId, chatId, { cascade }))
    },
  },
  {
    name: "update_chat",
    description: "Change a chat's settings without sending it a message: rename it, pin it, mark it done, archive it, show it in the sidebar or take it out, make it a delegator or not, or set the provider, model, effort and plan mode its next turn runs with. These apply to the next turn and do not start one; the result lists them as nextRun until it starts. A message already in its queue keeps the settings it was sent with. send_message, create_chat and fork_chat take the same settings with a message.",
    schema: updateChat,
    async execute(input, context) {
      const parsed = updateChat.parse(input)
      return reply(await orchestration(context).updateChat(context.chatId, { ...parsed, provider: parsed.provider as AgentProvider | undefined }))
    },
  },
  {
    name: "update_queued_message",
    description: "Remove a message waiting in a chat's queue, or deliver it now. A stopped chat holds its queue (queuePaused in its summary): nothing in it starts until one is delivered with send_now.",
    schema: updateQueuedMessage,
    async execute(input, context) {
      return reply(await orchestration(context).updateQueuedMessage(updateQueuedMessage.parse(input)))
    },
  },
  {
    name: "set_schedule",
    description: "Send a message later, once or on a repeat, to this chat, another chat, or a new chat each time. Give exactly one of inMinutes, runAt, everyMinutes or dailyAt. Pass scheduleId to change or pause one.",
    schema: setSchedule,
    async execute(input, context) {
      const parsed = setSchedule.parse(input)
      return reply(await orchestration(context).setSchedule(context.chatId, { ...parsed, provider: parsed.provider as AgentProvider | undefined }))
    },
  },
  {
    name: "list_schedules",
    description: "List schedules and when each runs next.",
    schema: listSchedules,
    async execute(input, context) {
      return reply(orchestration(context).listSchedules(listSchedules.parse(input)))
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule.",
    schema: deleteSchedule,
    async execute(input, context) {
      return reply(await orchestration(context).deleteSchedule(deleteSchedule.parse(input).scheduleId))
    },
  },
]
