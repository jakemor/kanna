import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AppSettingsSnapshot, KannaStatus } from "../../shared/types"
import type { ClientCommand } from "../../shared/protocol"
import { createEmptyState, type ChatRecord, type ProjectRecord } from "../events"
import { SERVER_PROVIDERS } from "../provider-catalog"
import { createApiKeyVerifier } from "./keys"
import { handleApiRequest, type ApiRouteDeps } from "./routes"

const KEY = "test-key"

function chatRecord(overrides: Partial<ChatRecord> & Pick<ChatRecord, "id" | "projectId">): ChatRecord {
  return {
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    provider: null,
    planMode: false,
    autoPlan: false,
    sessionToken: null,
    ...overrides,
  } as ChatRecord
}

interface Calls {
  sends: Array<Extract<ClientCommand, { type: "chat.send" }>>
  cancels: string[]
  closes: string[]
  deletes: string[]
  broadcasts: number
  events: string[]
}

function createDeps(options: { activeStatuses?: Map<string, KannaStatus> } = {}) {
  const state = createEmptyState()
  state.projectsById.set("project-1", {
    id: "project-1",
    localPath: "/tmp/project-1",
    title: "Project One",
    createdAt: 1,
    updatedAt: 5,
  } as ProjectRecord)
  state.projectIdsByPath.set("/tmp/project-1", "project-1")
  state.chatsById.set("chat-1", chatRecord({ id: "chat-1", projectId: "project-1", lastMessageAt: 10, hasMessages: true }))
  state.chatsById.set("chat-2", chatRecord({ id: "chat-2", projectId: "project-1", lastMessageAt: 20 }))
  state.chatsById.set("chat-archived", chatRecord({ id: "chat-archived", projectId: "project-1", archivedAt: 3 }))
  state.chatsById.set("chat-deleted", chatRecord({ id: "chat-deleted", projectId: "project-1", deletedAt: 4 }))

  const calls: Calls = { sends: [], cancels: [], closes: [], deletes: [], broadcasts: 0, events: [] }
  let created = 0

  const store = {
    state,
    getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
    getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
    getClientTranscript: () => ({ messages: [], startIndex: 0, readAnchor: null }),
    getInitialTranscriptWindowStart: () => 0,
    openProject: async (localPath: string, title?: string) => {
      const existingId = state.projectIdsByPath.get(localPath)
      if (existingId) return state.projectsById.get(existingId)!
      const project = {
        id: `project-${state.projectsById.size + 1}`,
        localPath,
        title: title ?? path.basename(localPath),
        createdAt: 1,
        updatedAt: 1,
      } as ProjectRecord
      state.projectsById.set(project.id, project)
      state.projectIdsByPath.set(localPath, project.id)
      return project
    },
    createChat: async (projectId: string) => {
      created += 1
      const chat = chatRecord({ id: `new-chat-${created}`, projectId })
      state.chatsById.set(chat.id, chat)
      return chat
    },
    deleteChat: async (chatId: string) => {
      calls.deletes.push(chatId)
      const chat = state.chatsById.get(chatId)
      if (chat) chat.deletedAt = Date.now()
    },
  }

  const agent = {
    getActiveStatuses: () => options.activeStatuses ?? new Map<string, KannaStatus>(),
    getDrainingChatIds: () => new Set<string>(),
    send: async (command: Extract<ClientCommand, { type: "chat.send" }>) => {
      calls.sends.push(command)
      if (command.chatId) return { chatId: command.chatId }
      const chat = await store.createChat(command.projectId!)
      return { chatId: chat.id }
    },
    cancel: async (chatId: string) => {
      calls.cancels.push(chatId)
    },
    closeChat: async (chatId: string) => {
      calls.closes.push(chatId)
    },
  }

  const deps = {
    store,
    agent,
    appSettings: {
      getSnapshot: () => ({ transcript: { windowAssistantMessages: 50 } } as unknown as AppSettingsSnapshot),
    },
    verifier: createApiKeyVerifier([KEY]),
    broadcast: () => {
      calls.broadcasts += 1
    },
    analytics: {
      track: (eventName: string) => {
        calls.events.push(eventName)
      },
    },
    version: "1.2.3",
  } as unknown as ApiRouteDeps

  return { deps, calls, state }
}

function call(
  deps: ApiRouteDeps,
  pathname: string,
  init: { method?: string; body?: unknown; key?: string | null } = {}
) {
  const url = new URL(`http://localhost${pathname}`)
  const headers: Record<string, string> = {}
  const key = init.key === undefined ? KEY : init.key
  if (key) headers.authorization = `Bearer ${key}`
  if (init.body !== undefined) headers["content-type"] = "application/json"
  const req = new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  })
  return handleApiRequest(req, url, deps)
}

/** Test-local: response bodies are asserted field by field, not typed. */
async function json(response: Response | null): Promise<Record<string, any>> {
  expect(response).not.toBeNull()
  return (await response!.json()) as Record<string, any>
}

describe("routing", () => {
  test("ignores requests outside the API prefix", async () => {
    const { deps } = createDeps()
    expect(await call(deps, "/api/chats/chat-1/window")).toBeNull()
    expect(await call(deps, "/")).toBeNull()
  })

  test("claims the prefix even for an unknown path", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/nope")
    expect(response?.status).toBe(404)
  })

  test("reports version and capabilities at the root", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1")
    expect(response?.status).toBe(200)
    expect(await json(response)).toMatchObject({ name: "kanna", version: "1.2.3", api: 1 })
  })

  test("answers 405 with an Allow header on the wrong method", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/messages", { method: "GET" })
    expect(response?.status).toBe(405)
    expect(response?.headers.get("Allow")).toBe("POST")
  })

  test("never caches a response", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats")
    expect(response?.headers.get("Cache-Control")).toBe("no-store")
  })
})

describe("authentication", () => {
  test("rejects a request with no key", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats", { key: null })
    expect(response?.status).toBe(401)
    expect(response?.headers.get("WWW-Authenticate")).toContain("Bearer")
  })

  test("rejects a wrong key", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats", { key: "nope" }))?.status).toBe(401)
  })

  test("accepts X-Api-Key as well as Bearer", async () => {
    const { deps } = createDeps()
    const url = new URL("http://localhost/api/v1/chats")
    const req = new Request(url, { headers: { "x-api-key": KEY } })
    expect((await handleApiRequest(req, url, deps))?.status).toBe(200)
  })

  test("checks the key before doing any work", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: { content: "hi" }, key: null })
    expect(calls.sends).toHaveLength(0)
  })
})

describe("projects", () => {
  test("lists projects with a live chat count", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/projects"))
    expect(body.projects).toHaveLength(1)
    // chat-1 and chat-2 only: archived and deleted chats don't count.
    expect(body.projects[0]).toMatchObject({ id: "project-1", localPath: "/tmp/project-1", chatCount: 2 })
  })

  test("adds an existing directory as a project", async () => {
    const { deps, calls } = createDeps()
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    try {
      await Bun.write(path.join(dir, "README.md"), "# existing\n")
      const response = await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir, title: "Added" } })
      expect(response?.status).toBe(201)
      const body = await json(response)
      expect(body.project).toMatchObject({ localPath: dir, title: "Added" })
      expect(calls.broadcasts).toBe(1)
      // A directory with content is adopted as-is, not turned into a repo.
      expect(await Bun.file(path.join(dir, ".git", "HEAD")).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates and git-inits a directory that does not exist yet", async () => {
    const { deps } = createDeps()
    const parent = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    const target = path.join(parent, "fresh")
    try {
      const response = await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: target } })
      expect(response?.status).toBe(201)
      expect(await Bun.file(path.join(target, ".git", "HEAD")).exists()).toBe(true)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("rejects a path that is a file, not a directory", async () => {
    const { deps } = createDeps()
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    const file = path.join(dir, "not-a-dir.txt")
    try {
      await Bun.write(file, "hello")
      expect((await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: file } }))?.status).toBe(400)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("re-adding the same path returns the project already open there", async () => {
    const { deps } = createDeps()
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    try {
      const first = await json(await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir } }))
      const second = await json(await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir } }))
      expect(second.project.id).toBe(first.project.id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("requires localPath", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/projects", { method: "POST", body: {} })
    expect(response?.status).toBe(400)
    expect((await json(response)).error).toContain("localPath")
  })

  test("rejects a body that is not JSON", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/projects", { method: "POST", body: "{" }))?.status).toBe(400)
  })
})

describe("listing chats", () => {
  test("hides archived and deleted chats by default, newest first", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/chats"))
    expect(body.chats.map((chat: { id: string }) => chat.id)).toEqual(["chat-2", "chat-1"])
    expect(body.total).toBe(2)
  })

  test("includes archived chats on request, still never deleted ones", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/chats?includeArchived=true"))
    const ids = body.chats.map((chat: { id: string }) => chat.id)
    expect(ids).toContain("chat-archived")
    expect(ids).not.toContain("chat-deleted")
  })

  test("filters by project", async () => {
    const { deps, state } = createDeps()
    state.projectsById.set("project-2", { id: "project-2", localPath: "/tmp/p2", title: "Two", createdAt: 1, updatedAt: 1 } as ProjectRecord)
    state.chatsById.set("chat-other", chatRecord({ id: "chat-other", projectId: "project-2" }))
    const body = await json(await call(deps, "/api/v1/chats?projectId=project-2"))
    expect(body.chats.map((chat: { id: string }) => chat.id)).toEqual(["chat-other"])
  })

  test("404s an unknown project rather than returning an empty list", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats?projectId=nope"))?.status).toBe(404)
  })

  test("honours limit and reports the untruncated total", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/chats?limit=1"))
    expect(body.chats).toHaveLength(1)
    expect(body.total).toBe(2)
  })

  test("rejects a nonsense limit", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats?limit=0"))?.status).toBe(400)
    expect((await call(deps, "/api/v1/chats?limit=abc"))?.status).toBe(400)
  })

  test("reports the live turn status", async () => {
    const { deps } = createDeps({ activeStatuses: new Map([["chat-1", "running" as KannaStatus]]) })
    const body = await json(await call(deps, "/api/v1/chats"))
    const chat = body.chats.find((entry: { id: string }) => entry.id === "chat-1")
    expect(chat).toMatchObject({ status: "running" })
  })
})

describe("creating chats", () => {
  test("creates an empty chat", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats", { method: "POST", body: { projectId: "project-1" } })
    expect(response?.status).toBe(201)
    expect((await json(response)).chat).toMatchObject({ projectId: "project-1" })
    expect(calls.sends).toHaveLength(0)
    expect(calls.broadcasts).toBe(1)
  })

  test("creates and prompts in one call when content is given", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats", {
      method: "POST",
      body: { projectId: "project-1", content: "build it", model: "opus", planMode: true },
    })
    expect(response?.status).toBe(202)
    expect(calls.sends).toEqual([
      {
        type: "chat.send",
        projectId: "project-1",
        content: "build it",
        provider: undefined,
        model: "opus",
        effort: undefined,
        modelOptions: undefined,
        planMode: true,
        autoPlan: undefined,
      },
    ])
  })

  test("treats whitespace-only content as no content", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats", { method: "POST", body: { projectId: "project-1", content: "   " } })
    expect(response?.status).toBe(201)
    expect(calls.sends).toHaveLength(0)
  })

  test("404s an unknown project", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats", { method: "POST", body: { projectId: "nope" } }))?.status).toBe(404)
  })
})

describe("reading a chat", () => {
  test("returns the chat with its transcript window", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/chats/chat-1"))
    expect(body.chat).toMatchObject({ id: "chat-1", projectId: "project-1" })
    expect(body.messages).toEqual([])
    expect(body.runtime).toBeDefined()
  })

  test("404s an unknown chat", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats/nope"))?.status).toBe(404)
  })

  test("404s a deleted chat", async () => {
    const { deps } = createDeps()
    expect((await call(deps, "/api/v1/chats/chat-deleted"))?.status).toBe(404)
  })
})

describe("sending a prompt", () => {
  test("accepts the prompt and answers 202 without waiting for the turn", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: { content: "hello" } })
    expect(response?.status).toBe(202)
    expect(await json(response)).toMatchObject({ chatId: "chat-1", queued: false })
    expect(calls.sends[0]).toMatchObject({ type: "chat.send", chatId: "chat-1", content: "hello" })
    expect(calls.broadcasts).toBe(1)
  })

  test("reports a prompt that landed behind a running turn", async () => {
    const { deps } = createDeps()
    deps.agent.send = async () => ({ chatId: "chat-1", queued: true as const, queuedMessageId: "queued-1" })
    const body = await json(await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: { content: "hello" } }))
    expect(body).toMatchObject({ queued: true, queuedMessageId: "queued-1" })
  })

  test("requires content", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: {} })
    expect(response?.status).toBe(400)
    expect((await json(response)).error).toContain("content")
  })

  test("rejects a non-object modelOptions", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/messages", {
      method: "POST",
      body: { content: "hi", modelOptions: "nope" },
    })
    expect(response?.status).toBe(400)
  })

  test("404s an unknown chat before sending", async () => {
    const { deps, calls } = createDeps()
    expect((await call(deps, "/api/v1/chats/nope/messages", { method: "POST", body: { content: "hi" } }))?.status).toBe(404)
    expect(calls.sends).toHaveLength(0)
  })

  test("surfaces an agent failure as 500", async () => {
    const { deps } = createDeps()
    deps.agent.send = async () => {
      throw new Error("provider is not configured")
    }
    const response = await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: { content: "hi" } })
    expect(response?.status).toBe(500)
    expect((await json(response)).error).toBe("provider is not configured")
  })
})

describe("provider validation", () => {
  // An unknown provider is only noticed when the turn is set up. For a prompt
  // that queues behind a running turn that happens after the 202, in
  // dequeueAndStartQueuedMessage, which removes the queued message before the
  // catalog lookup throws — so an accepted prompt would vanish.
  test("rejects an unknown provider instead of accepting the prompt", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/messages", {
      method: "POST",
      body: { content: "hi", provider: "bogus" },
    })
    expect(response?.status).toBe(400)
    expect((await json(response)).error).toContain("bogus")
    expect(calls.sends).toHaveLength(0)
  })

  test("names the providers it will accept", async () => {
    const { deps } = createDeps()
    const body = await json(await call(deps, "/api/v1/chats/chat-1/messages", {
      method: "POST",
      body: { content: "hi", provider: "bogus" },
    }))
    expect(body.error).toContain("claude")
  })

  test("rejects an unknown provider on create-and-prompt too", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats", {
      method: "POST",
      body: { projectId: "project-1", content: "hi", provider: "bogus" },
    })
    expect(response?.status).toBe(400)
    expect(calls.sends).toHaveLength(0)
  })

  test("accepts every provider the server has a catalog entry for", async () => {
    for (const provider of SERVER_PROVIDERS.map((entry) => entry.id)) {
      const { deps, calls } = createDeps()
      const response = await call(deps, "/api/v1/chats/chat-1/messages", {
        method: "POST",
        body: { content: "hi", provider },
      })
      expect(response?.status).toBe(202)
      expect(calls.sends[0]).toMatchObject({ provider })
    }
  })

  test("a missing provider stays undefined so the chat's own is used", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats/chat-1/messages", { method: "POST", body: { content: "hi" } })
    expect(calls.sends[0]?.provider).toBeUndefined()
  })
})

describe("malformed paths", () => {
  test("answers 400, not 500, on bad percent-encoding", async () => {
    const { deps } = createDeps()
    const response = await call(deps, "/api/v1/chats/%ZZ")
    expect(response?.status).toBe(400)
    expect((await json(response)).error).toContain("percent-encoding")
  })

  test("still decodes a legitimately encoded id", async () => {
    const { deps, state } = createDeps()
    state.chatsById.set("chat/with slash", chatRecord({ id: "chat/with slash", projectId: "project-1" }))
    const response = await call(deps, `/api/v1/chats/${encodeURIComponent("chat/with slash")}`)
    expect(response?.status).toBe(200)
  })
})

describe("analytics", () => {
  test("creating a chat reports chat_created", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats", { method: "POST", body: { projectId: "project-1" } })
    expect(calls.events).toEqual(["chat_created"])
  })

  test("create-and-prompt leaves the event to agent.send, so it is not doubled", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats", { method: "POST", body: { projectId: "project-1", content: "hi" } })
    expect(calls.events).toEqual([])
  })

  test("deleting a chat reports chat_deleted", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats/chat-1", { method: "DELETE" })
    expect(calls.events).toEqual(["chat_deleted"])
  })

  test("adding a new project reports project_opened", async () => {
    const { deps, calls } = createDeps()
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    try {
      await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir } })
      expect(calls.events).toEqual(["project_opened"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("re-adding an already-open project reports nothing", async () => {
    const { deps, calls } = createDeps()
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-project-"))
    try {
      await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir } })
      calls.events.length = 0
      await call(deps, "/api/v1/projects", { method: "POST", body: { localPath: dir } })
      expect(calls.events).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reads report nothing", async () => {
    const { deps, calls } = createDeps()
    await call(deps, "/api/v1/chats")
    await call(deps, "/api/v1/projects")
    await call(deps, "/api/v1/chats/chat-1")
    expect(calls.events).toEqual([])
  })
})

describe("cancel and delete", () => {
  test("cancels a running turn", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1/cancel", { method: "POST" })
    expect(response?.status).toBe(200)
    expect(calls.cancels).toEqual(["chat-1"])
    expect(calls.broadcasts).toBe(1)
  })

  test("deletes a chat, stopping its turn first", async () => {
    const { deps, calls } = createDeps()
    const response = await call(deps, "/api/v1/chats/chat-1", { method: "DELETE" })
    expect(response?.status).toBe(200)
    expect(calls.cancels).toEqual(["chat-1"])
    expect(calls.closes).toEqual(["chat-1"])
    expect(calls.deletes).toEqual(["chat-1"])
    expect(calls.broadcasts).toBe(1)
  })

  test("404s deleting an unknown chat", async () => {
    const { deps, calls } = createDeps()
    expect((await call(deps, "/api/v1/chats/nope", { method: "DELETE" }))?.status).toBe(404)
    expect(calls.deletes).toHaveLength(0)
  })
})
