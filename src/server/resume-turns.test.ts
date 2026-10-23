import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { resumeInterruptedTurns } from "./resume-turns"
import type { ChatRecord, StoreState } from "./events"
import { EventStoreFileError } from "./event-store"

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

function createDeps(chats: ChatRecord[], options?: {
  clear?: (chatId: string) => Promise<void>
  resume?: (chatId: string) => Promise<boolean>
  crash?: string
}) {
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
        setTurnResumePending: (chatId: string, pending: boolean) => Effect.tryPromise({
          try: async () => {
            await options?.clear?.(chatId)
            if (!pending) cleared.push(chatId)
            if (pending) state.chatsById.get(chatId)!.resumePending = true
            else delete state.chatsById.get(chatId)!.resumePending
          },
          catch: (cause) => new EventStoreFileError({ operation: "write", filePath: "test", chatId, cause }),
        }),
      },
      agent: {
        resumeInterruptedTurnEffect: (chatId: string) => chatId === options?.crash
          ? Effect.sync(() => { attempted.push(chatId) }).pipe(Effect.andThen(Effect.die(new Error("bug in resume"))))
          : Effect.tryPromise(() => {
            attempted.push(chatId)
            return options?.resume?.(chatId) ?? Promise.resolve(true)
          }),
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

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual(["marked"])
    expect(attempted).toEqual(["marked"])
  })

  test("skips chats the user deleted or archived while the turn was running", async () => {
    const { deps, attempted } = createDeps([
      createChat("deleted", { resumePending: true, deletedAt: 5 }),
      createChat("archived", { resumePending: true, archivedAt: 5 }),
    ])

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual([])
    expect(attempted).toEqual([])
  })

  test("resumes in the order the interrupted turns started", async () => {
    const { deps, attempted } = createDeps([
      createChat("second", { resumePending: true, lastTurnStartedAt: 200 }),
      createChat("first", { resumePending: true, lastTurnStartedAt: 100 }),
      createChat("third", { resumePending: true, lastTurnStartedAt: 300 }),
    ])

    await Effect.runPromise(resumeInterruptedTurns(deps))
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

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual(["fine"])
    expect(cleared).toEqual(["broken", "fine"])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.chatId).toBe("broken")
    // A failure on one chat must not strand the ones behind it.
    expect(deps.store.state.chatsById.get("fine")?.resumePending).toBeUndefined()
  })

  test("reports a chat whose resume crashes and still resumes the next", async () => {
    const { deps, attempted, errors } = createDeps([
      createChat("crashes", { resumePending: true, lastTurnStartedAt: 100 }),
      createChat("fine", { resumePending: true, lastTurnStartedAt: 200 }),
    ], { crash: "crashes" })

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual(["fine"])
    expect(attempted).toEqual(["crashes", "fine"])
    expect(errors.map((error) => error.chatId)).toEqual(["crashes"])
    expect((errors[0]?.error as Error).message).toBe("bug in resume")
  })

  test("reports a chat that could not be resumed without counting it as resumed", async () => {
    const { deps } = createDeps([createChat("no-session", { resumePending: true })], {
      resume: async () => false,
    })

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual([])
  })

  test("does not resume a chat whose marker could not be cleared, but continues to the next", async () => {
    const failure = new Error("store unavailable")
    const { deps, cleared, attempted, errors } = createDeps([
      createChat("broken", { resumePending: true, lastTurnStartedAt: 100 }),
      createChat("fine", { resumePending: true, lastTurnStartedAt: 200 }),
    ], {
      clear: async (chatId) => {
        if (chatId === "broken") throw failure
      },
    })

    expect(await Effect.runPromise(resumeInterruptedTurns(deps))).toEqual(["fine"])
    expect(cleared).toEqual(["fine"])
    expect(attempted).toEqual(["fine"])
    expect(errors).toEqual([{ chatId: "broken", error: failure }])
    expect(deps.store.state.chatsById.get("broken")?.resumePending).toBe(true)
  })

  test("restores the marker if shutdown interrupts an in-flight resume", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const { deps } = createDeps([createChat("interrupted", { resumePending: true })])
    deps.agent.resumeInterruptedTurnEffect = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))

    await Effect.runPromise(Effect.gen(function* () {
      const recovery = yield* Effect.forkChild(resumeInterruptedTurns(deps))
      yield* Deferred.await(started)
      expect(deps.store.state.chatsById.get("interrupted")?.resumePending).toBeUndefined()
      yield* Fiber.interrupt(recovery)
    }))

    expect(deps.store.state.chatsById.get("interrupted")?.resumePending).toBe(true)
  })
})
