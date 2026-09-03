import { describe, expect, test } from "bun:test"
import { resumeInterruptedTurns } from "./resume-turns"
import type { ChatRecord, StoreState } from "./events"

function createChat(id: string, overrides?: Partial<ChatRecord>): ChatRecord {
  return {
    id,
    projectId: "project-1",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    provider: "claude",
    planMode: false,
    autoPlan: false,
    sessionToken: "session-1",
    lastTurnOutcome: null,
    ...overrides,
  }
}

function createDeps(chats: ChatRecord[], options?: { resume?: (chatId: string) => Promise<boolean> }) {
  const state = {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(chats.map((chat) => [chat.id, chat])),
    queuedMessagesByChatId: new Map(),
  } as StoreState
  const cleared: string[] = []
  const attempted: string[] = []
  const errors: Array<{ chatId: string; error: unknown }> = []
  return {
    cleared,
    attempted,
    errors,
    deps: {
      store: {
        state,
        setTurnResumePending: async (chatId: string, pending: boolean) => {
          if (!pending) cleared.push(chatId)
          delete state.chatsById.get(chatId)!.resumePending
        },
      },
      agent: {
        resumeInterruptedTurn: async (chatId: string) => {
          attempted.push(chatId)
          return await (options?.resume?.(chatId) ?? Promise.resolve(true))
        },
      },
      onError: (chatId: string, error: unknown) => {
        errors.push({ chatId, error })
      },
    },
  }
}

describe("resumeInterruptedTurns", () => {
  test("resumes only the chats the last shutdown marked", async () => {
    const { deps, attempted } = createDeps([
      createChat("marked", { resumePending: true }),
      createChat("idle"),
      // A turn that never ended but was never marked either — a hard crash, or
      // a log from before resume existed. Left alone on purpose.
      createChat("crashed", { lastTurnStartedAt: 10 }),
    ])

    expect(await resumeInterruptedTurns(deps)).toEqual(["marked"])
    expect(attempted).toEqual(["marked"])
  })

  test("skips chats the user deleted or archived while the turn was running", async () => {
    const { deps, attempted } = createDeps([
      createChat("deleted", { resumePending: true, deletedAt: 5 }),
      createChat("archived", { resumePending: true, archivedAt: 5 }),
    ])

    expect(await resumeInterruptedTurns(deps)).toEqual([])
    expect(attempted).toEqual([])
  })

  test("resumes in the order the interrupted turns started", async () => {
    const { deps, attempted } = createDeps([
      createChat("second", { resumePending: true, lastTurnStartedAt: 200 }),
      createChat("first", { resumePending: true, lastTurnStartedAt: 100 }),
      createChat("third", { resumePending: true, lastTurnStartedAt: 300 }),
    ])

    await resumeInterruptedTurns(deps)
    expect(attempted).toEqual(["first", "second", "third"])
  })

  test("clears the marker even when the resume fails, so it is not retried every boot", async () => {
    const { deps, cleared, errors } = createDeps(
      [
        createChat("broken", { resumePending: true, lastTurnStartedAt: 100 }),
        createChat("fine", { resumePending: true, lastTurnStartedAt: 200 }),
      ],
      { resume: async (chatId) => {
        if (chatId === "broken") throw new Error("harness is gone")
        return true
      } }
    )

    expect(await resumeInterruptedTurns(deps)).toEqual(["fine"])
    expect(cleared).toEqual(["broken", "fine"])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.chatId).toBe("broken")
    // A failure on one chat must not strand the ones behind it.
    expect(deps.store.state.chatsById.get("fine")?.resumePending).toBeUndefined()
  })

  test("reports a chat that could not be resumed without counting it as resumed", async () => {
    const { deps } = createDeps([createChat("no-session", { resumePending: true })], {
      resume: async () => false,
    })

    expect(await resumeInterruptedTurns(deps)).toEqual([])
  })
})
