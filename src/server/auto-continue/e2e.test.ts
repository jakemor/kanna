import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "../agent"
import { EventStore } from "../event-store"
import { AsyncEventQueue } from "../test-helpers/async-event-queue"
import { waitFor } from "../test-helpers/wait-for"
import type { AutoContinueEvent } from "./events"
import { ClaudeLimitDetector, CodexLimitDetector } from "./limit-detector"
import { ScheduleManager, type Clock } from "./schedule-manager"

// ---------------------------------------------------------------------------
// FakeClock — controllable wall-clock for ScheduleManager
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  private currentTime: number
  private readonly timers = new Map<number, { fn: () => void; fireAt: number }>()
  private nextId = 1

  constructor(startAt: number) {
    this.currentTime = startAt
  }

  now(): number {
    return this.currentTime
  }

  setTimeout(fn: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, { fn, fireAt: this.currentTime + delayMs })
    return id
  }

  clearTimeout(id: number): void {
    this.timers.delete(id)
  }

  advance(ms: number): void {
    this.currentTime += ms
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.fireAt <= this.currentTime) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a rate-limit error that ClaudeLimitDetector recognises.
 *
 *  The `anthropic-ratelimit-unified-reset` header is set to
 *  `new Date(resetAt).toISOString()` so the detector returns exactly
 *  `resetAt` as the reset timestamp.
 */
function makeRateLimitError(resetAt: number): Error & { status: number; headers: Record<string, string> } {
  const err = new Error(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error" } })
  ) as Error & { status: number; headers: Record<string, string> }
  err.status = 429
  err.headers = {
    "anthropic-ratelimit-unified-reset": new Date(resetAt).toISOString(),
    "x-anthropic-timezone": "Asia/Saigon",
  }
  return err
}

// ---------------------------------------------------------------------------
// End-to-end test
// ---------------------------------------------------------------------------

describe("auto-continue end-to-end", () => {
  test("rate limit → proposed → accept → timer fires → auto_continue_fired + 'continue' user_prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-ac-e2e-"))
    let scheduleManager: ScheduleManager | undefined
    try {
      // --- Set up real EventStore ---
      const store = new EventStore(dir)
      await store.initialize()
      const project = await store.openProject("/tmp/e2e-proj")
      const chat = await store.createChat(project.id)
      const chatId = chat.id

      // --- FakeClock anchored to real wall-clock so scheduledAt guard passes ---
      // acceptAutoContinue checks `scheduledAt > Date.now()` using real Date.now().
      // ScheduleManager.arm computes `delay = scheduledAt - clock.now()`.
      // By starting the fake clock at Date.now(), both quantities agree and
      // a 10s delta is large enough to survive slow CI runners.
      const clockStart = Date.now()
      const clock = new FakeClock(clockStart)
      const resetAtMs = clockStart + 10_000 // rate-limit resets 10s "from now"

      // --- ScheduleManager + coordinator (forward-reference pattern) ---
      let coordinator!: AgentCoordinator
      scheduleManager = new ScheduleManager({
        clock,
        fire: async (cid, sid) => {
          await coordinator.fireAutoContinue(cid, sid)
        },
      })

      // Async event queue so we can throw a rate-limit error on demand.
      const events = new AsyncEventQueue<never>()

      coordinator = new AgentCoordinator({
        store,
        onStateChange: () => {},
        claudeLimitDetector: new ClaudeLimitDetector(),
        codexLimitDetector: new CodexLimitDetector(),
        scheduleManager,
        // manual mode: do NOT auto-resume so we exercise the proposed → accept path
        getAutoResumePreference: () => false,
        startClaudeSession: async () => ({
          provider: "claude" as const,
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
          sendPrompt: async () => {
            // Throw a rate-limit error; this is caught by runClaudeSession
            // which routes it through handleLimitError → ClaudeLimitDetector.
            events.throw(makeRateLimitError(resetAtMs))
          },
        }),
      })

      // ----------------------------------------------------------------
      // Step 1: Send a message; session throws a rate-limit error.
      // ----------------------------------------------------------------
      await coordinator.send({
        type: "chat.send",
        chatId,
        content: "hello",
        model: "claude-opus-4-5",
        provider: "claude",
        autoResumeOnRateLimit: false,
      })

      // Wait for the proposed event to be persisted.
      await waitFor(() => store.getAutoContinueEvents(chatId).length >= 1)

      const acEventsAfterPropose = store.getAutoContinueEvents(chatId)
      expect(acEventsAfterPropose).toHaveLength(1)
      expect(acEventsAfterPropose[0].kind).toBe("auto_continue_proposed")
      const proposed = acEventsAfterPropose[0] as Extract<AutoContinueEvent, { kind: "auto_continue_proposed" }>
      expect(proposed.tz).toBe("Asia/Saigon")
      const { scheduleId } = proposed

      // ----------------------------------------------------------------
      // Step 2: Client accepts — scheduleManager arms the timer.
      // ----------------------------------------------------------------
      const scheduledAt = clock.now() + 10_000 // in the future per both real and fake clock
      await coordinator.acceptAutoContinue(chatId, scheduleId, scheduledAt)

      const acEventsAfterAccept = store.getAutoContinueEvents(chatId)
      expect(acEventsAfterAccept).toHaveLength(2)
      const accepted = acEventsAfterAccept[1] as Extract<AutoContinueEvent, { kind: "auto_continue_accepted" }>
      expect(accepted.kind).toBe("auto_continue_accepted")
      expect(accepted.scheduleId).toBe(scheduleId)
      expect(accepted.source).toBe("user")
      expect(accepted.scheduledAt).toBe(scheduledAt)

      // ----------------------------------------------------------------
      // Step 3: Advance the fake clock past scheduledAt — timer fires.
      // The ScheduleManager callback calls coordinator.fireAutoContinue
      // which is async; we need to drain the microtask queue after advance.
      // ----------------------------------------------------------------
      clock.advance(10_100)

      // ----------------------------------------------------------------
      // Step 4: Assert auto_continue_fired event.
      // ----------------------------------------------------------------
      await waitFor(() =>
        store.getAutoContinueEvents(chatId).some((e) => e.kind === "auto_continue_fired")
      )

      const acEventsAfterFire = store.getAutoContinueEvents(chatId)
      const firedEvent = acEventsAfterFire.find(
        (e) => e.kind === "auto_continue_fired"
      ) as Extract<AutoContinueEvent, { kind: "auto_continue_fired" }> | undefined
      expect(firedEvent).toBeDefined()
      expect(firedEvent!.scheduleId).toBe(scheduleId)

      // ----------------------------------------------------------------
      // Step 5: Assert "continue" user_prompt with autoContinue metadata.
      // ----------------------------------------------------------------
      await waitFor(() =>
        store.getMessages(chatId).some((m) => m.kind === "user_prompt" && m.content === "continue")
      )

      const messages = store.getMessages(chatId)
      const continuePrompts = messages.filter(
        (m) => m.kind === "user_prompt" && m.content === "continue"
      )
      expect(continuePrompts).toHaveLength(1)
      const continuePrompt = continuePrompts[0]
      if (continuePrompt?.kind === "user_prompt") {
        expect(continuePrompt.autoContinue?.scheduleId).toBe(scheduleId)
      } else {
        throw new Error("Expected user_prompt entry")
      }
    } finally {
      scheduleManager?.shutdown()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
