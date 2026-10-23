import { Context, Effect, Layer, Schema } from "effect"
import type { ClientCommand } from "../shared/protocol"
import type { KannaStatus, MessageSource } from "../shared/types"
import type { AgentCoordinator } from "./agent"

type Command<TType extends ClientCommand["type"]> = Extract<ClientCommand, { type: TType }>

/**
 * A turn could not be started, queued, steered or stopped. The coordinator
 * threw, and its words are what the user or the agent reads, so `message`
 * is the cause's own.
 */
export class ChatAgentError extends Schema.TaggedError<ChatAgentError>()(
  "@kanna/server/chat-agent/ChatAgentError",
  {
    operation: Schema.Literals(["send", "enqueue", "steer", "dequeue", "cancel", "closeChat", "forkChat"]),
    chatId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/**
 * The agent coordinator as chat commands and the orchestrator need it: the
 * calls that start, queue and stop turns, as Effects, and the reads of what
 * is running, which answer from memory at once.
 *
 * Narrow so tests can stand in for it, and so neither depends on the
 * coordinator itself, which is still Promise code (`agent.ts`, wave 4).
 * `fromCoordinator` adapts it.
 */
export class ChatAgent extends Context.Service<ChatAgent, {
  readonly isBusy: (chatId: string) => boolean
  readonly isDraining: (chatId: string) => boolean
  /** Work handed to another agent of the provider's is still going. What a chat waits on. */
  readonly hasDelegatedWork: (chatId: string) => boolean
  /** The kinds of task it left running that it is not waiting on: `shell`, `monitor`. */
  readonly getLeftRunning: (chatId: string) => string[]
  readonly isPlanning: (chatId: string) => boolean
  readonly getActiveStatuses: () => Map<string, KannaStatus>

  /** Starts a turn when the chat is idle, and queues behind the running one otherwise. */
  readonly send: (
    command: Command<"chat.send">,
    extras?: { source?: MessageSource },
  ) => Effect.Effect<{ chatId: string; queuedMessageId?: string; queued?: true }, ChatAgentError>
  readonly enqueue: (
    command: Command<"message.enqueue">,
    extras?: { source?: MessageSource; effort?: string },
  ) => Effect.Effect<{ queuedMessageId: string }, ChatAgentError>
  readonly steer: (command: Command<"message.steer">) => Effect.Effect<void, ChatAgentError>
  readonly dequeue: (command: Command<"message.dequeue">) => Effect.Effect<void, ChatAgentError>
  readonly cancel: (chatId: string) => Effect.Effect<void, ChatAgentError>
  readonly closeChat: (chatId: string) => Effect.Effect<void, ChatAgentError>
  readonly forkChat: (
    chatId: string,
    lineage?: { parentChatId?: string; createdByChatId?: string },
  ) => Effect.Effect<{ chatId: string }, ChatAgentError>
}>()("@kanna/server/ChatAgent") {
  /**
   * The coordinator's Promise methods behind the Effect shape. `coordinator`
   * is read on every call, not when this is built: the server builds its
   * layers before the coordinator exists.
   */
  static readonly fromCoordinator = (coordinator: () => CoordinatorLike): ChatAgent["Service"] => {
    const attempt = <A>(operation: ChatAgentError["operation"], chatId: string | undefined, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new ChatAgentError({ operation, ...(chatId === undefined ? {} : { chatId }), cause }),
      })
    return {
      isBusy: (chatId) => coordinator().isBusy(chatId),
      isDraining: (chatId) => coordinator().isDraining(chatId),
      hasDelegatedWork: (chatId) => coordinator().hasDelegatedWork(chatId),
      getLeftRunning: (chatId) => coordinator().getLeftRunning(chatId),
      isPlanning: (chatId) => coordinator().isPlanning(chatId),
      getActiveStatuses: () => coordinator().getActiveStatuses(),
      send: (command, extras) => attempt("send", command.chatId, () => coordinator().send(command, extras)),
      enqueue: (command, extras) => attempt("enqueue", command.chatId, () => coordinator().enqueue(command, extras)),
      steer: (command) => attempt("steer", command.chatId, () => coordinator().steer(command)),
      dequeue: (command) => attempt("dequeue", command.chatId, () => coordinator().dequeue(command)),
      cancel: (chatId) => attempt("cancel", chatId, () => coordinator().cancel(chatId)),
      closeChat: (chatId) => attempt("closeChat", chatId, () => coordinator().closeChat(chatId)),
      forkChat: (chatId, lineage) => attempt("forkChat", chatId, () => coordinator().forkChat(chatId, lineage)),
    }
  }

  static readonly layerFromCoordinator = (coordinator: () => CoordinatorLike) =>
    Layer.succeed(this, this.fromCoordinator(coordinator))
}

/** What `fromCoordinator` calls on the coordinator. */
export type CoordinatorLike = Pick<
  AgentCoordinator,
  | "isBusy"
  | "isDraining"
  | "hasDelegatedWork"
  | "getLeftRunning"
  | "isPlanning"
  | "getActiveStatuses"
  | "send"
  | "enqueue"
  | "steer"
  | "dequeue"
  | "cancel"
  | "closeChat"
  | "forkChat"
>
