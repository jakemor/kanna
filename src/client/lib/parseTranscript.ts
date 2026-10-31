import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"
import { drawnMessageSource } from "./message-source"

function createTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    inputTrimmed: entry.trimmed,
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

/**
 * The structured result for the two tool kinds that need it.
 *
 * `structuredResult` is lifted server-side out of `debugRaw`. The `debugRaw`
 * fallback covers entries served by an older server that still shipped the raw
 * payload inline.
 */
function getStructuredToolResult(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): unknown {
  if (entry.structuredResult !== undefined) return entry.structuredResult
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result
  } catch {
    return undefined
  }
}

/**
 * A tool call still waiting for its result: where it sits, and its wire form.
 *
 * A subagent's call sits inside its parent's `children`; then `index` is the
 * parent's position and `childIndex` the call's position in that list.
 */
interface PendingToolCall {
  index: number
  childIndex?: number
  normalized: NormalizedToolCall
}

/**
 * What a hydration run leaves behind so the next one can pick up after it:
 * the entries it consumed, the tool calls still open at the end, and where
 * each Agent call sits so later sidechain entries can find their parent.
 */
interface HydrationState {
  entries: TranscriptEntry[]
  pendingToolCalls: Map<string, PendingToolCall>
  agentCallIndexes: Map<string, number>
}

/** Every entry kind except `tool_result`, which folds into an earlier row instead. */
function hydrateEntry(entry: Exclude<TranscriptEntry, { kind: "tool_result" }>): HydratedTranscriptMessage {
  switch (entry.kind) {
    case "user_prompt":
      return {
        ...createBaseMessage(entry),
        kind: "user_prompt",
        content: entry.content,
        attachments: entry.attachments ?? [],
        steered: entry.steered,
        // Only a sender it draws: an old ticket reply reads as the user's prompt.
        ...(drawnMessageSource(entry.source) ? { source: entry.source } : {}),
      }
    case "system_init":
      return {
        ...createBaseMessage(entry),
        kind: "system_init",
        provider: entry.provider,
        model: entry.model,
        tools: entry.tools,
        agents: entry.agents,
        slashCommands: entry.slashCommands,
        mcpServers: entry.mcpServers,
        debugRaw: entry.debugRaw,
      }
    case "account_info":
      return {
        ...createBaseMessage(entry),
        kind: "account_info",
        accountInfo: entry.accountInfo,
      }
    case "assistant_text":
      return {
        ...createBaseMessage(entry),
        kind: "assistant_text",
        text: entry.text,
      }
    case "tool_call":
      return hydrateToolCall(entry)
    case "result":
      return {
        ...createBaseMessage(entry),
        kind: "result",
        success: !entry.isError,
        cancelled: entry.subtype === "cancelled",
        result: entry.result,
        durationMs: entry.durationMs,
        costUsd: entry.costUsd,
      }
    case "status":
      return {
        ...createBaseMessage(entry),
        kind: "status",
        status: entry.status,
      }
    case "context_window_updated":
      return {
        ...createBaseMessage(entry),
        kind: "context_window_updated",
        usage: entry.usage,
      }
    case "compact_boundary":
      return {
        ...createBaseMessage(entry),
        kind: "compact_boundary",
      }
    case "compact_summary":
      return {
        ...createBaseMessage(entry),
        kind: "compact_summary",
        summary: entry.summary,
      }
    case "context_cleared":
      return {
        ...createBaseMessage(entry),
        kind: "context_cleared",
      }
    case "handoff_boundary":
      return {
        ...createBaseMessage(entry),
        kind: "handoff_boundary",
        fromProvider: entry.fromProvider,
        toProvider: entry.toProvider,
      }
    case "session_restored":
      return {
        ...createBaseMessage(entry),
        kind: "session_restored",
        provider: entry.provider,
      }
    case "interrupted":
      return {
        ...createBaseMessage(entry),
        kind: "interrupted",
      }
    default:
      return {
        ...createBaseMessage(entry),
        kind: "unknown",
        json: JSON.stringify(entry, null, 2),
      }
  }
}

/** A copy of `call` with `entry`'s result folded in. Never mutates `call`. */
function applyToolResult(
  call: HydratedToolCall,
  normalized: NormalizedToolCall,
  entry: Extract<TranscriptEntry, { kind: "tool_result" }>
): HydratedToolCall {
  const hydrated = { ...call }
  // Recorded whether or not the body came with it: this is what marks
  // the call finished, and what the expanded view fetches by.
  hydrated.isError = entry.isError
  hydrated.resultEntryId = entry._id
  hydrated.resultTimestamp = createTimestamp(entry.createdAt)
  hydrated.resultTrimmed = entry.trimmed

  // A trimmed result has no body to hydrate — the expanded view fetches
  // it and hydrates there, so nothing is derived from an absent payload.
  if (!entry.trimmed) {
    const rawResult = (
      normalized.toolKind === "ask_user_question" ||
      normalized.toolKind === "exit_plan_mode"
    )
      ? getStructuredToolResult(entry) ?? entry.content
      : entry.content

    hydrated.result = hydrateToolResult(normalized, rawResult) as never
    hydrated.rawResult = rawResult
  }
  return hydrated
}

const hydrationStates = new WeakMap<HydratedTranscriptMessage[], HydrationState>()

/**
 * Do `entries` begin with exactly the entries the previous run consumed?
 *
 * Entry objects keep their identity across pushes (the fold splices arrays,
 * it never copies entries), so a reference check is enough. An optimistic
 * prompt that the server's copy replaces fails the check at that index and
 * forces a full rebuild, which is the right answer for it.
 */
function isPrefix(previous: TranscriptEntry[], entries: TranscriptEntry[]): boolean {
  if (previous.length > entries.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== entries[index]) return false
  }
  return true
}

/**
 * Hydrate transcript entries into the messages the transcript renders.
 *
 * Pass the previous result back in and a push that only appended entries
 * hydrates the new ones alone. A streaming turn pushes a few times a second,
 * and rebuilding a few hundred messages (a `Date` each) on every push was a
 * measurable slice of each React commit. Anything that is not a pure append
 * (a chat switch, "load earlier", an optimistic prompt reconciled) falls back
 * to a full rebuild.
 *
 * A tool result never mutates a message that an earlier run returned; it
 * replaces that message with a copy. The row memos compare old and new
 * message objects, and a mutation in place would hide the result from them.
 */
export function processTranscriptMessages(
  entries: TranscriptEntry[],
  previousMessages?: HydratedTranscriptMessage[] | null
): HydratedTranscriptMessage[] {
  const previousState = previousMessages ? hydrationStates.get(previousMessages) : undefined
  const resume = previousMessages && previousState && isPrefix(previousState.entries, entries)
    ? { messages: previousMessages, state: previousState }
    : null

  if (resume && resume.state.entries.length === entries.length) {
    return resume.messages
  }

  const pendingToolCalls = new Map<string, PendingToolCall>(resume?.state.pendingToolCalls)
  const agentCallIndexes = new Map<string, number>(resume?.state.agentCallIndexes)
  const messages: HydratedTranscriptMessage[] = resume ? resume.messages.slice() : []
  const startIndex = resume ? resume.state.entries.length : 0

  // Replace `messages[index]` with a copy whose child at `childIndex` is
  // `child` (or, with no `childIndex`, with `child` appended). Copies the
  // parent and its list so no message an earlier run returned is mutated.
  const setChild = (index: number, childIndex: number | undefined, child: HydratedTranscriptMessage) => {
    const parent = { ...(messages[index] as HydratedToolCall) }
    const children = parent.children ? parent.children.slice() : []
    if (childIndex === undefined) children.push(child)
    else children[childIndex] = child
    parent.children = children
    messages[index] = parent
  }

  for (let entryIndex = startIndex; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!

    if (entry.kind === "tool_result") {
      const pendingCall = pendingToolCalls.get(entry.toolId)
      if (!pendingCall) continue
      const call = pendingCall.childIndex === undefined
        ? messages[pendingCall.index] as HydratedToolCall
        : (messages[pendingCall.index] as HydratedToolCall).children![pendingCall.childIndex]! as HydratedToolCall
      const hydrated = applyToolResult(call, pendingCall.normalized, entry)
      if (pendingCall.childIndex === undefined) {
        messages[pendingCall.index] = hydrated
      } else {
        setChild(pendingCall.index, pendingCall.childIndex, hydrated)
      }
      pendingToolCalls.delete(entry.toolId)
      continue
    }

    const message = hydrateEntry(entry)

    // A subagent's entry goes under the Agent call that spawned it. One
    // whose parent is not in the window (an older server did not stamp
    // parents; a nested agent's parent is itself a child) stays inline, as
    // every entry did before parents were stamped.
    const parentIndex = entry.parentToolUseId !== undefined
      ? agentCallIndexes.get(entry.parentToolUseId)
      : undefined
    if (parentIndex !== undefined) {
      if (entry.kind === "tool_call") {
        const childIndex = (messages[parentIndex] as HydratedToolCall).children?.length ?? 0
        pendingToolCalls.set(entry.tool.toolId, { index: parentIndex, childIndex, normalized: entry.tool })
      }
      setChild(parentIndex, undefined, message)
      continue
    }

    if (entry.kind === "tool_call") {
      pendingToolCalls.set(entry.tool.toolId, { index: messages.length, normalized: entry.tool })
      if (entry.tool.toolKind === "subagent_task") {
        agentCallIndexes.set(entry.tool.toolId, messages.length)
      }
    }
    messages.push(message)
  }

  hydrationStates.set(messages, { entries, pendingToolCalls, agentCallIndexes })
  return messages
}
