import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../shared/types"
import { hasNewChatDraft, resolveProjectNewChat, type NewChatDrafts } from "./new-chat-resume"
import type { SidebarThread } from "./thread-sections"

const PROJECT = "project-a"

type Row = Partial<SidebarChatRow> & { chatId: string; archived?: boolean; lastActivityAt?: number }

/** The project's chats as `flattenSidebarThreads` hands them over, from just the fields that matter here. */
function threads(rows: Row[]): SidebarThread[] {
  return rows.map(({ archived = false, lastActivityAt = 0, ...row }) => ({
    chatId: row.chatId,
    projectId: PROJECT,
    archived,
    lastActivityAt,
    row: { title: "New Chat", ...row } as SidebarChatRow,
  }) as SidebarThread)
}

function drafts(entries: Record<string, { text?: string; attachments?: number; touchedAt?: number; startedAt?: number }>): NewChatDrafts {
  const result = { text: {} as Record<string, string>, attachments: {} as Record<string, unknown[]>, touchedAt: {} as Record<string, number>, startedAt: {} as Record<string, number> }
  for (const [chatId, entry] of Object.entries(entries)) {
    if (entry.text !== undefined) result.text[chatId] = entry.text
    if (entry.attachments) result.attachments[chatId] = Array.from({ length: entry.attachments }, () => ({}))
    if (entry.touchedAt !== undefined) result.touchedAt[chatId] = entry.touchedAt
    if (entry.startedAt !== undefined) result.startedAt[chatId] = entry.startedAt
  }
  return result
}

function resolve({ projectChats = [], ...overrides }: Partial<Parameters<typeof resolveProjectNewChat>[0]> & { projectChats?: Row[] }) {
  const projectThreads = threads(projectChats)
  return resolveProjectNewChat({
    entry: "project",
    projectId: PROJECT,
    projectThreads,
    isListed: (chatId) => projectThreads.some((thread) => thread.chatId === chatId),
    drafts: drafts({}),
    startedChats: {},
    startingChatIds: new Set(),
    viewedChatIds: [],
    ...overrides,
  })
}

describe("resolveProjectNewChat", () => {
  test("a click on a project opens its new chat that holds a draft", () => {
    expect(resolve({
      projectChats: [{ chatId: "empty" }, { chatId: "busy", lastMessageAt: 5 }],
      drafts: drafts({ empty: { text: "half a thought", touchedAt: 10 } }),
    })).toEqual({ kind: "open", chatId: "empty" })
  })

  test("an explicit New Chat makes a chat whatever is waiting", () => {
    expect(resolve({
      entry: "explicit",
      projectChats: [{ chatId: "empty" }],
      drafts: drafts({ empty: { text: "half a thought", touchedAt: 10 } }),
    })).toEqual({ kind: "create" })
  })

  test("with no draft anywhere, a chat is made", () => {
    // An empty chat with nothing written in it is not come back to.
    expect(resolve({ projectChats: [{ chatId: "empty" }] })).toEqual({ kind: "create" })
    expect(resolve({ projectChats: [{ chatId: "empty" }], drafts: drafts({ empty: { text: "  \n ", touchedAt: 10 } }) })).toEqual({ kind: "create" })
  })

  test("attachments staged without text are a draft", () => {
    const staged = drafts({ empty: { attachments: 1, touchedAt: 10 } })
    expect(hasNewChatDraft(staged, "empty")).toBe(true)
    expect(resolve({ projectChats: [{ chatId: "empty" }], drafts: staged })).toEqual({ kind: "open", chatId: "empty" })
  })

  test("a chat with messages and a sub-chat are not new chats, draft or no", () => {
    expect(resolve({
      projectChats: [
        { chatId: "busy", lastMessageAt: 5 },
        { chatId: "sub", parentChatId: "busy", hidden: true },
      ],
      drafts: drafts({ busy: { text: "a", touchedAt: 3 }, sub: { text: "c", touchedAt: 1 } }),
    })).toEqual({ kind: "create" })
    // With Delegator mode a new chat is a delegator, and comes back like any
    // other. A sub-chat delegator is still an agent's, not a new chat.
    expect(resolve({
      projectChats: [
        { chatId: "delegator", delegator: true },
        { chatId: "sub", parentChatId: "busy", hidden: true, delegator: true },
      ],
      drafts: drafts({ delegator: { text: "b", touchedAt: 2 }, sub: { text: "c", touchedAt: 3 } }),
    })).toEqual({ kind: "open", chatId: "delegator" })
    // One the user started and an agent took on later is still theirs.
    expect(resolve({
      projectChats: [{ chatId: "adopted", parentChatId: "busy", adopted: true }],
      drafts: drafts({ adopted: { text: "mine", touchedAt: 1 } }),
    })).toEqual({ kind: "open", chatId: "adopted" })
  })

  test("another project's draft is not this project's", () => {
    expect(resolve({
      projectChats: [],
      isListed: () => true,
      drafts: drafts({ elsewhere: { text: "over there", touchedAt: 10 } }),
      startedChats: { elsewhere: { projectId: "project-b" } },
    })).toEqual({ kind: "create" })
  })

  test("of several drafts, the one changed most recently", () => {
    expect(resolve({
      projectChats: [{ chatId: "older" }, { chatId: "newer" }],
      drafts: drafts({ older: { text: "first", touchedAt: 10 }, newer: { text: "second", touchedAt: 20 } }),
    })).toEqual({ kind: "open", chatId: "newer" })
    // A draft from before its changes were timed goes by when it was begun.
    expect(resolve({
      projectChats: [{ chatId: "older" }, { chatId: "newer" }],
      drafts: drafts({ older: { text: "first", startedAt: 30 }, newer: { text: "second", touchedAt: 20 } }),
    })).toEqual({ kind: "open", chatId: "older" })
  })

  test("a draft whose chat was cleared away is carried into a new one", () => {
    expect(resolve({
      projectChats: [],
      drafts: drafts({ pruned: { text: "written before lunch", touchedAt: 10 } }),
      startedChats: { pruned: { projectId: PROJECT } },
    })).toEqual({ kind: "carry", fromChatId: "pruned" })
  })

  test("nothing is taken for gone before the sidebar has loaded", () => {
    expect(resolve({
      projectChats: [],
      isListed: null,
      drafts: drafts({ started: { text: "still there, probably", touchedAt: 10 } }),
      startedChats: { started: { projectId: PROJECT } },
    })).toEqual({ kind: "create" })
  })

  test("a started chat the server has not answered for yet is opened, not carried", () => {
    expect(resolve({
      projectChats: [],
      drafts: drafts({ starting: { text: "typed at once", touchedAt: 10 } }),
      startedChats: { starting: { projectId: PROJECT } },
      startingChatIds: new Set(["starting"]),
    })).toEqual({ kind: "open", chatId: "starting" })
  })

  test("a started chat that is listed elsewhere, as archived say, is not carried", () => {
    expect(resolve({
      projectChats: [],
      isListed: () => true,
      drafts: drafts({ archived: { text: "put away", touchedAt: 10 } }),
      startedChats: { archived: { projectId: PROJECT } },
    })).toEqual({ kind: "create" })
  })

  test("a chat that is there wins a tie with one to be made again", () => {
    expect(resolve({
      projectChats: [{ chatId: "live" }],
      drafts: drafts({ live: { text: "here", touchedAt: 10 }, pruned: { text: "gone", touchedAt: 10 } }),
      startedChats: { pruned: { projectId: PROJECT } },
    })).toEqual({ kind: "open", chatId: "live" })
    expect(resolve({
      projectChats: [{ chatId: "live" }],
      drafts: drafts({ live: { text: "here", touchedAt: 10 }, pruned: { text: "gone", touchedAt: 11 } }),
      startedChats: { pruned: { projectId: PROJECT } },
    })).toEqual({ kind: "carry", fromChatId: "pruned" })
  })

  describe("the chat last viewed here", () => {
    test("is where a click on the project goes", () => {
      expect(resolve({
        projectChats: [{ chatId: "older", lastMessageAt: 9 }, { chatId: "viewed", lastMessageAt: 5 }],
        viewedChatIds: ["viewed", "older"],
      })).toEqual({ kind: "open", chatId: "viewed" })
    })

    test("gives way to the one viewed before it once archived, hidden under a parent, or deleted", () => {
      expect(resolve({
        projectChats: [
          { chatId: "put-away", lastMessageAt: 9, archived: true },
          { chatId: "sub", lastMessageAt: 9, parentChatId: "kept", hidden: true },
          { chatId: "kept", lastMessageAt: 5 },
        ],
        viewedChatIds: ["deleted", "put-away", "sub", "kept"],
      })).toEqual({ kind: "open", chatId: "kept" })
    })

    test("and to the new chat page when none of them is listed", () => {
      expect(resolve({ projectChats: [{ chatId: "never-viewed", lastMessageAt: 5 }], viewedChatIds: ["deleted"] })).toEqual({ kind: "create" })
      // An empty chat is not listed, so it is not gone back to for having been viewed.
      expect(resolve({ projectChats: [{ chatId: "empty" }], viewedChatIds: ["empty"] })).toEqual({ kind: "create" })
    })

    test("a new chat holding a draft is gone back to in its place in that order", () => {
      const projectChats = [{ chatId: "drafted" }, { chatId: "busy", lastMessageAt: 5 }]
      const written = drafts({ drafted: { text: "half a thought", touchedAt: 10 } })
      expect(resolve({ projectChats, drafts: written, viewedChatIds: ["drafted", "busy"] })).toEqual({ kind: "open", chatId: "drafted" })
      expect(resolve({ projectChats, drafts: written, viewedChatIds: ["busy", "drafted"] })).toEqual({ kind: "open", chatId: "busy" })
    })

    test("an explicit New Chat still makes one", () => {
      expect(resolve({ entry: "explicit", projectChats: [{ chatId: "viewed", lastMessageAt: 5 }], viewedChatIds: ["viewed"] })).toEqual({ kind: "create" })
    })
  })

  test("a project's delegators are not opened for being ones", () => {
    expect(resolve({ projectChats: [{ chatId: "lead", delegator: true, lastMessageAt: 5 }] })).toEqual({ kind: "create" })
  })
})
