import type { ChatSnapshot, KannaStatus, SubagentActivity, WaitingOn } from "../shared/types"
import type { AppSettingsManager } from "./app-settings"
import type { EventStore } from "./event-store"
import { deriveChatSnapshot } from "./read-models"
import { sliceTurnFolds } from "./turn-folds"

/**
 * `GET /api/chats/:chatId/window`: the first chat snapshot a cold
 * `subscribe {type:"chat"}` would push, as plain JSON over HTTP.
 *
 * The socket sends that first window as one frame of several megabytes on
 * a long chat, and a WebSocket frame cannot be compressed or streamed by
 * the client the way an HTTP body can. The iOS app fetches this route
 * first, then subscribes with `cachedSpan` set to the window it holds, so
 * the socket only sends the tail.
 *
 * The window arithmetic mirrors `getChatWindowStart` and `sliceChatWindow`
 * in ws-router.ts: the start comes from the store (the transcript-window
 * setting, widened to reach the read anchor), and the full snapshot is
 * cut down to what begins there. Keep the two in step.
 */
export interface ChatWindowRouteDeps {
  store: Pick<EventStore, "state" | "getChat" | "getClientTranscript" | "getInitialTranscriptWindowStart"> & Partial<Pick<EventStore, "prepareTranscript">>
  agent: {
    getActiveStatuses: () => Map<string, KannaStatus>
    /** Optional for the same reason as `getSubagents`. Preferred: it also has the chats waiting on a subagent. */
    getChatStatuses?: () => Map<string, KannaStatus>
    getDrainingChatIds: () => Set<string>
    /** Optional: older callers and test fakes predate delegated-work tracking. */
    getSubagents?: (chatId: string) => SubagentActivity[]
    /** Optional for the same reason. */
    getWaitingOn?: (chatId: string) => WaitingOn
  }
  appSettings: Pick<AppSettingsManager, "getSnapshot">
}

export const CHAT_WINDOW_ROUTE_PATTERN = /^\/api\/chats\/([^/]+)\/window$/

/** The window a socket with no cache gets, or null for a chat that is gone. */
export function readChatWindow(chatId: string, deps: ChatWindowRouteDeps): ChatSnapshot | null {
  const { store, agent, appSettings } = deps
  const windowStart = store.getChat(chatId)
    ? store.getInitialTranscriptWindowStart(chatId, appSettings.getSnapshot().transcript.windowAssistantMessages)
    : 0
  const full = deriveChatSnapshot(
    store.state,
    agent.getChatStatuses?.() ?? agent.getActiveStatuses(),
    agent.getDrainingChatIds(),
    chatId,
    (id, options) => store.getClientTranscript(id, windowStart, options),
    agent.getSubagents?.(chatId),
    agent.getWaitingOn?.(chatId)
  )
  if (!full) return null
  const offset = Math.max(0, Math.min(windowStart - full.startIndex, full.messages.length))
  if (offset === 0) return full
  return {
    ...full,
    messages: full.messages.slice(offset),
    startIndex: full.startIndex + offset,
    ...(full.turnFolds ? { turnFolds: sliceTurnFolds(full.turnFolds, full.messages.slice(0, offset)) } : {}),
  }
}

function acceptsGzip(req: Request) {
  return (req.headers.get("accept-encoding") ?? "")
    .split(",")
    .some((token) => token.trim().split(";")[0]?.trim().toLowerCase() === "gzip")
}

export async function handleChatWindow(req: Request, url: URL, deps: ChatWindowRouteDeps): Promise<Response | null> {
  const match = url.pathname.match(CHAT_WINDOW_ROUTE_PATTERN)
  if (!match) return null
  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  }
  const chatId = decodeURIComponent(match[1])
  if (deps.store.getChat(chatId)) await deps.store.prepareTranscript?.(chatId)
  const data = readChatWindow(chatId, deps)
  if (!data) {
    return Response.json({ error: "Chat not found" }, { status: 404 })
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  })
  const json = JSON.stringify(data)
  if (!acceptsGzip(req)) {
    return new Response(json, { headers })
  }
  headers.set("Content-Encoding", "gzip")
  return new Response(Bun.gzipSync(Buffer.from(json)), { headers })
}
