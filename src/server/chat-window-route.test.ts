import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { makeFakeDiffStore } from "./diff-store.fake"
import { makeFakeKeybindings } from "./keybindings.fake"
import { makeFakeAppSettings } from "./app-settings.fake"
import { makeFakeTerminals } from "./terminal-manager.fake"
import { makeFakeWorktreeProbe } from "./worktree-probe.fake"
import { findTranscriptWindowStart } from "../shared/transcript-window"
import { createEmptyState } from "./events"
import { ChatWindowPreparationError, handleChatWindow, type ChatWindowRouteDeps } from "./chat-window-route"
import { createWsRouter } from "./ws-router"
import { testPlatformContext } from "./platform/testing"

/** prompt, text, text: three entries, two assistant messages. */
function turn(n: number) {
  return [
    { _id: `p${n}`, createdAt: n, kind: "user_prompt", content: `question ${n}` },
    { _id: `a${n}`, createdAt: n, kind: "assistant_text", text: "one" },
    { _id: `b${n}`, createdAt: n, kind: "assistant_text", text: "two" },
  ]
}

function createDeps(entries: Array<Record<string, unknown>>) {
  const state = createEmptyState()
  state.projectsById.set("project-1", { id: "project-1", localPath: "/tmp/project", title: "Project", createdAt: 1, updatedAt: 1 })
  state.chatsById.set("chat-1", {
    id: "chat-1", projectId: "project-1", title: "Chat", createdAt: 1, updatedAt: 1, unread: false,
    provider: null, planMode: false, autoPlan: false, sessionToken: null, lastTurnOutcome: null,
  })
  const typed = entries as never[]
  const store = {
    state,
    getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
    getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
    getClientTranscript: () => ({ messages: entries, startIndex: 0, readAnchor: null }),
    getEntryIdAt: (_chatId: string, index: number) => (entries[index] as { _id?: string } | undefined)?._id ?? null,
    getInitialTranscriptWindowStart: (_chatId: string, assistantMessages: number) =>
      findTranscriptWindowStart(typed, { endExclusive: entries.length, assistantMessages }),
    widenTranscriptWindowStart: (_chatId: string, current: number) => current,
    getSidebarProjectOrder: () => [],
    pruneStaleEmptyChats: async () => [],
  }
  const agent = { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set<string>() }
  // Only the transcript window is read by the route or by the router's chat push.
  const appSettings = makeFakeAppSettings({ transcript: { windowAssistantMessages: 2 } })
  return { store, agent, appSettings }
}

/** What a socket with no cache gets as its first chat push. */
async function firstSocketSnapshot(deps: ReturnType<typeof createDeps>) {
  const sent: unknown[] = []
  const ws = { sent, data: { subscriptions: new Map(), protectedDraftChatIds: new Set<string>() }, send: (m: string) => { sent.push(JSON.parse(m)) } }
  const router = createWsRouter({
    platform: testPlatformContext,
    store: deps.store as never,
    diffStore: makeFakeDiffStore(),
    worktreeProbe: makeFakeWorktreeProbe(),
    agent: deps.agent as never,
    terminals: makeFakeTerminals(),
    keybindings: makeFakeKeybindings({} as never),
    appSettings: deps.appSettings,
    llmProvider: { read: async () => ({}), write: async () => ({}), validate: async () => ({ ok: true, error: null }) } as never,
    refreshDiscovery: () => Effect.succeed([]),
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
  })
  router.handleOpen(ws as never)
  await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "sub", topic: { type: "chat", chatId: "chat-1" } }))
  return (sent[0] as { snapshot: { data: unknown } }).snapshot.data
}

const url = new URL("http://localhost/api/chats/chat-1/window")

describe("chat window route", () => {
  test("ignores other paths and methods", async () => {
    const deps = createDeps(turn(1)) as unknown as ChatWindowRouteDeps
    expect(await Effect.runPromise(handleChatWindow(new Request("http://localhost/api/chats/chat-1"), new URL("http://localhost/api/chats/chat-1"), deps))).toBeNull()
    const post = await Effect.runPromise(handleChatWindow(new Request(url, { method: "POST" }), url, deps))
    expect(post?.status).toBe(405)
  })

  test("404s a chat the store does not have", async () => {
    const deps = createDeps(turn(1)) as unknown as ChatWindowRouteDeps
    const missing = new URL("http://localhost/api/chats/nope/window")
    const response = await Effect.runPromise(handleChatWindow(new Request(missing), missing, deps))
    expect(response?.status).toBe(404)
  })

  test("identity body equals the socket's first snapshot", async () => {
    const deps = createDeps([...turn(1), ...turn(2), ...turn(3)])
    const response = await Effect.runPromise(handleChatWindow(new Request(url), url, deps as unknown as ChatWindowRouteDeps))
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-encoding")).toBeNull()
    expect(response?.headers.get("content-type")).toBe("application/json")
    expect(response?.headers.get("vary")).toBe("Accept-Encoding")
    const body = await response!.json()
    expect(body.startIndex).toBe(6)
    expect(body.messages.map((entry: { _id: string }) => entry._id)).toEqual(["p3", "a3", "b3"])
    expect(body).toEqual(await firstSocketSnapshot(deps))
  })

  test("says when the chat is waiting on a subagent, as the socket does", async () => {
    // The app paints from this body before its socket answers, so a status
    // only the socket knew would show the chat at rest for that long.
    const deps = createDeps(turn(1))
    const waiting = { ...deps, agent: { ...deps.agent, getChatStatuses: () => new Map([["chat-1", "waiting_on_subagent" as const]]) } }
    const response = await Effect.runPromise(handleChatWindow(new Request(url), url, waiting as unknown as ChatWindowRouteDeps))
    const body = await response!.json()
    expect(body.runtime.status).toBe("waiting_on_subagent")
    expect(body).toEqual(await firstSocketSnapshot(waiting))
  })

  test("gzips when the client accepts it", async () => {
    const deps = createDeps([...turn(1), ...turn(2), ...turn(3)])
    const request = new Request(url, { headers: { "Accept-Encoding": "br, gzip;q=0.8" } })
    const response = await Effect.runPromise(handleChatWindow(request, url, deps as unknown as ChatWindowRouteDeps))
    expect(response?.headers.get("content-encoding")).toBe("gzip")
    expect(response?.headers.get("content-type")).toBe("application/json")
    const raw = new Uint8Array(await response!.arrayBuffer())
    expect(raw[0]).toBe(0x1f)
    expect(raw[1]).toBe(0x8b)
    const body = JSON.parse(Buffer.from(Bun.gunzipSync(raw)).toString("utf8"))
    expect(body).toEqual(await firstSocketSnapshot(deps))
  })

  test("prepares a stored transcript before reading and tags preparation failures", async () => {
    const deps = createDeps(turn(1))
    const prepared: string[] = []
    const store = {
      ...deps.store,
      retainTranscript: (chatId: string) => Effect.sync(() => { prepared.push(chatId) }),
    }
    const routeDeps = { ...deps, store } as unknown as ChatWindowRouteDeps
    expect((await Effect.runPromise(handleChatWindow(new Request(url), url, routeDeps)))?.status).toBe(200)
    expect(prepared).toEqual(["chat-1"])

    const cause = new Error("transcript unavailable")
    store.retainTranscript = () => Effect.die(cause)
    const result = await Effect.runPromise(Effect.result(handleChatWindow(new Request(url), url, routeDeps)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ChatWindowPreparationError)
      expect(result.failure.cause).toBe(cause)
    }
  })
})
