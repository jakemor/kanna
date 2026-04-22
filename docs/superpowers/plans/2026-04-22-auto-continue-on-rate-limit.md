# Auto-Continue on Rate-Limit Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude or Codex returns a rate-limit error with a reset time, offer (or silently schedule) a `"continue"` user message at that time and auto-send it when the timer fires.

**Architecture:** A new event-sourced subsystem under `src/server/auto-continue/`. Provider-specific `LimitDetector`s convert structured SDK / JSON-RPC errors into `{ resetAt, tz }` tuples; a `ScheduleManager` owns in-memory `setTimeout`s and is the single wall-clock authority. Persistence is a new `schedules.jsonl` log plus a field on the chat snapshot; on startup the manager rehydrates timers from replayed state. The chat transcript gains one new entry kind (`auto_continue_prompt`) whose live state is looked up in `chat.schedules[scheduleId]`. A new Zustand preference gates whether the server auto-accepts or emits a proposal.

**Tech Stack:** Bun 1.3.5 + TypeScript 5.8 + React 19 + Zustand (with `persist`) + event-sourced JSONL server + Claude Agent SDK + Codex App Server JSON-RPC. Tests run via `bun test`.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `src/server/auto-continue/events.ts` | `AutoContinueEvent` discriminated union + snapshot entry type. |
| `src/server/auto-continue/limit-detector.ts` | `ClaudeLimitDetector` + `CodexLimitDetector` — pure functions from error → `LimitDetection \| null`. |
| `src/server/auto-continue/schedule-manager.ts` | Owns `Map<scheduleId, Timeout>`. Arms / clears / rehydrates / fires. Takes an injected `Clock` for tests. |
| `src/server/auto-continue/limit-detector.test.ts` | Unit tests with captured real error shapes. |
| `src/server/auto-continue/schedule-manager.test.ts` | Unit tests with fake clock. |
| `src/server/auto-continue/read-model.ts` | `deriveChatSchedules(events)` — pure reducer that projects the event log into `chat.schedules` / `chat.liveSchedule`. |
| `src/server/auto-continue/read-model.test.ts` | State-machine transition tests. |
| `src/client/components/chat-ui/AutoContinueCard.tsx` | Four-state React card (proposed / scheduled / fired / cancelled). |
| `src/client/components/chat-ui/AutoContinueCard.test.tsx` | Component tests for rendering + input validation + WS dispatch. |
| `src/client/lib/autoContinueTime.ts` | `formatLocal(ms, tz)` / `parseLocal(input, tz)` — `dd/mm/yyyy hh:mm`. |
| `src/client/lib/autoContinueTime.test.ts` | Pure format/parse tests. |

**Modified files**

| Path | What changes |
|---|---|
| `src/shared/types.ts` | New `AutoContinuePromptEntry` transcript kind, extend `TranscriptEntry`, extend `UserPromptEntry` with `autoContinue?: { scheduleId: string }`, extend `ChatSnapshot` with `schedules` + `liveScheduleId`. |
| `src/shared/protocol.ts` | Three new `ClientCommand` variants: `autoContinue.accept`, `autoContinue.reschedule`, `autoContinue.cancel`. |
| `src/server/events.ts` | Export `AutoContinueEvent` through `StoreEvent`; extend `StoreState` with `schedulesByChatId`. Extend `SnapshotFile.v` → `3` with `schedules` field + bump `STORE_VERSION`. |
| `src/server/event-store.ts` | New `schedulesLogPath`, extend `applyEvent` switch, extend `createSnapshot`, expose `appendAutoContinueEvent`. |
| `src/server/read-models.ts` | In `deriveChatSnapshot`: add `schedules` + `liveScheduleId` fields. |
| `src/server/agent.ts` | Constructor takes `ScheduleManager` + `autoResumePreference: () => boolean`; detect limit errors in both runtime catch blocks (Claude stream + Codex run). |
| `src/server/ws-router.ts` | Route three new commands; on chat.delete, cancel live schedules. |
| `src/server/cli-runtime.ts` (or wherever `AgentCoordinator` + `EventStore` are wired) | Instantiate `ScheduleManager`; call `rehydrate()` after event replay. |
| `src/client/stores/preferences.ts` (new file) | Zustand store with `autoResumeOnRateLimit: boolean`. |
| `src/client/app/SettingsPage.tsx` | Toggle row in General section. |
| `src/client/lib/parseTranscript.ts` | Handle `auto_continue_prompt` entry; add `autoContinue?: { scheduleId }` to user-prompt passthrough. |
| `src/client/components/chat-ui/KannaTranscript.tsx` (or renderer) | Render `auto_continue_prompt` messages via `AutoContinueCard` + render "auto-sent" badge on user prompts carrying `autoContinue`. |

---

## Task 1: Shared types for auto-continue

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add `AutoContinueSchedule` + `AutoContinuePromptEntry` + extend unions**

Open `src/shared/types.ts`. Bump the store version and add the new types.

Change line 1:

```ts
export const STORE_VERSION = 3 as const
```

After the `PendingToolSnapshot` interface (near end of file), append:

```ts
export type AutoContinueScheduleState = "proposed" | "scheduled" | "fired" | "cancelled"

export interface AutoContinueSchedule {
  scheduleId: string
  state: AutoContinueScheduleState
  scheduledAt: number | null
  tz: string
  resetAt: number
  detectedAt: number
}

export interface AutoContinuePromptEntry extends TranscriptEntryBase {
  kind: "auto_continue_prompt"
  scheduleId: string
}
```

Find the `TranscriptEntry` union (`export type TranscriptEntry =`) and add `| AutoContinuePromptEntry` as the last variant.

Find `UserPromptEntry` (line ~479) and add one optional field:

```ts
export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt"
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  autoContinue?: { scheduleId: string }
}
```

Find `ChatSnapshot` (line ~878) and add two fields:

```ts
export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  history: ChatHistorySnapshot
  availableProviders: ProviderCatalogEntry[]
  slashCommands: SlashCommand[]
  slashCommandsLoading: boolean
  schedules: Record<string, AutoContinueSchedule>
  liveScheduleId: string | null
}
```

In `HydratedTranscriptMessage`, add:

```ts
  | ({ kind: "auto_continue_prompt"; scheduleId: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
```

In the `user_prompt` branch of `HydratedTranscriptMessage` (the object literal variant), add `autoContinue?: { scheduleId: string }`.

- [ ] **Step 2: Run type-check to make sure nothing else breaks**

Run: `bun run check`
Expected: errors only in the files we plan to modify next (agent.ts, read-models.ts, parseTranscript.ts, etc.). No syntax errors in `types.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(auto-continue): add shared types and bump STORE_VERSION"
```

---

## Task 2: AutoContinueEvent shape

**Files:**
- Create: `src/server/auto-continue/events.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/auto-continue/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { AutoContinueEvent } from "./events"

describe("AutoContinueEvent", () => {
  test("covers the five lifecycle kinds", () => {
    const kinds: AutoContinueEvent["kind"][] = [
      "auto_continue_proposed",
      "auto_continue_accepted",
      "auto_continue_rescheduled",
      "auto_continue_cancelled",
      "auto_continue_fired",
    ]
    expect(kinds.length).toBe(5)
  })

  test("proposed event carries reset + tz metadata", () => {
    const event: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: 1_000,
      chatId: "c1",
      scheduleId: "s1",
      detectedAt: 1_000,
      resetAt: 2_000,
      tz: "Asia/Saigon",
      turnId: "t1",
    }
    expect(event.tz).toBe("Asia/Saigon")
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/events.test.ts`
Expected: FAIL — module `./events` not found.

- [ ] **Step 3: Create the events module**

Create `src/server/auto-continue/events.ts`:

```ts
export type AutoContinueEvent =
  | {
      v: 3
      kind: "auto_continue_proposed"
      timestamp: number
      chatId: string
      scheduleId: string
      detectedAt: number
      resetAt: number
      tz: string
      turnId: string
    }
  | {
      v: 3
      kind: "auto_continue_accepted"
      timestamp: number
      chatId: string
      scheduleId: string
      scheduledAt: number
      tz: string
      source: "user" | "auto_setting"
      resetAt: number
      detectedAt: number
    }
  | {
      v: 3
      kind: "auto_continue_rescheduled"
      timestamp: number
      chatId: string
      scheduleId: string
      scheduledAt: number
    }
  | {
      v: 3
      kind: "auto_continue_cancelled"
      timestamp: number
      chatId: string
      scheduleId: string
      reason: "user" | "chat_deleted"
    }
  | {
      v: 3
      kind: "auto_continue_fired"
      timestamp: number
      chatId: string
      scheduleId: string
      firedAt: number
    }
```

Note: `auto_continue_accepted` carries `resetAt` and `detectedAt` redundantly so the read model can project full `AutoContinueSchedule` state without having to fold the earlier `proposed` event first (important for the auto-resume path, which emits `accepted` directly without a `proposed`).

- [ ] **Step 4: Run the test**

Run: `bun test src/server/auto-continue/events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auto-continue/events.ts src/server/auto-continue/events.test.ts
git commit -m "feat(auto-continue): define AutoContinueEvent union"
```

---

## Task 3: Pure read-model reducer

**Files:**
- Create: `src/server/auto-continue/read-model.ts`
- Test: `src/server/auto-continue/read-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/auto-continue/read-model.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { deriveChatSchedules } from "./read-model"
import type { AutoContinueEvent } from "./events"

function proposed(chatId: string, scheduleId: string, at = 1_000): AutoContinueEvent {
  return {
    v: 3,
    kind: "auto_continue_proposed",
    timestamp: at,
    chatId,
    scheduleId,
    detectedAt: at,
    resetAt: at + 10_000,
    tz: "Asia/Saigon",
    turnId: "turn-1",
  }
}

function accepted(chatId: string, scheduleId: string, at = 2_000, source: "user" | "auto_setting" = "user"): AutoContinueEvent {
  return {
    v: 3,
    kind: "auto_continue_accepted",
    timestamp: at,
    chatId,
    scheduleId,
    scheduledAt: at + 10_000,
    tz: "Asia/Saigon",
    source,
    resetAt: at + 10_000,
    detectedAt: at,
  }
}

describe("deriveChatSchedules", () => {
  test("empty event list returns empty map + null live", () => {
    const result = deriveChatSchedules([])
    expect(result.schedules).toEqual({})
    expect(result.liveScheduleId).toBeNull()
  })

  test("proposed event yields state=proposed with liveScheduleId set", () => {
    const result = deriveChatSchedules([proposed("c1", "s1")])
    expect(result.schedules["s1"].state).toBe("proposed")
    expect(result.schedules["s1"].scheduledAt).toBeNull()
    expect(result.liveScheduleId).toBe("s1")
  })

  test("accept after propose promotes to scheduled", () => {
    const result = deriveChatSchedules([proposed("c1", "s1"), accepted("c1", "s1")])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].scheduledAt).toBe(12_000)
    expect(result.liveScheduleId).toBe("s1")
  })

  test("accept with source=auto_setting without prior proposed still produces scheduled", () => {
    const result = deriveChatSchedules([accepted("c1", "s1", 1_500, "auto_setting")])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].resetAt).toBe(11_500)
    expect(result.liveScheduleId).toBe("s1")
  })

  test("cancelled schedule is terminal and not live", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_cancelled", timestamp: 3_000, chatId: "c1", scheduleId: "s1", reason: "user" },
    ])
    expect(result.schedules["s1"].state).toBe("cancelled")
    expect(result.liveScheduleId).toBeNull()
  })

  test("fired schedule is terminal and retains scheduledAt", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_fired", timestamp: 12_000, chatId: "c1", scheduleId: "s1", firedAt: 12_000 },
    ])
    expect(result.schedules["s1"].state).toBe("fired")
    expect(result.schedules["s1"].scheduledAt).toBe(12_000)
    expect(result.liveScheduleId).toBeNull()
  })

  test("live schedule tracks most recent non-terminal", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1", 1_000),
      { v: 3, kind: "auto_continue_cancelled", timestamp: 1_100, chatId: "c1", scheduleId: "s1", reason: "user" },
      proposed("c1", "s2", 2_000),
    ])
    expect(result.schedules["s1"].state).toBe("cancelled")
    expect(result.schedules["s2"].state).toBe("proposed")
    expect(result.liveScheduleId).toBe("s2")
  })

  test("reschedule updates scheduledAt without changing state", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_rescheduled", timestamp: 2_500, chatId: "c1", scheduleId: "s1", scheduledAt: 20_000 },
    ])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].scheduledAt).toBe(20_000)
  })

  test("events for different chats produce independent results", () => {
    const events = [proposed("c1", "s1"), proposed("c2", "s2")]
    expect(deriveChatSchedules(events, "c1").liveScheduleId).toBe("s1")
    expect(deriveChatSchedules(events, "c2").liveScheduleId).toBe("s2")
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/read-model.test.ts`
Expected: FAIL — `deriveChatSchedules` not exported.

- [ ] **Step 3: Implement the reducer**

Create `src/server/auto-continue/read-model.ts`:

```ts
import type { AutoContinueSchedule } from "../../shared/types"
import type { AutoContinueEvent } from "./events"

export interface ChatSchedulesProjection {
  schedules: Record<string, AutoContinueSchedule>
  liveScheduleId: string | null
}

const EMPTY: ChatSchedulesProjection = { schedules: {}, liveScheduleId: null }

export function deriveChatSchedules(
  events: readonly AutoContinueEvent[],
  chatId?: string
): ChatSchedulesProjection {
  const schedules: Record<string, AutoContinueSchedule> = {}
  for (const event of events) {
    if (chatId && event.chatId !== chatId) continue
    applyOne(schedules, event)
  }

  let liveScheduleId: string | null = null
  let liveOrder = -1
  let order = 0
  for (const event of events) {
    order += 1
    if (chatId && event.chatId !== chatId) continue
    const schedule = schedules[event.scheduleId]
    if (!schedule) continue
    if (schedule.state !== "proposed" && schedule.state !== "scheduled") continue
    if (order > liveOrder) {
      liveOrder = order
      liveScheduleId = schedule.scheduleId
    }
  }

  return schedules === EMPTY.schedules && liveScheduleId === null
    ? EMPTY
    : { schedules, liveScheduleId }
}

function applyOne(schedules: Record<string, AutoContinueSchedule>, event: AutoContinueEvent) {
  switch (event.kind) {
    case "auto_continue_proposed":
      schedules[event.scheduleId] = {
        scheduleId: event.scheduleId,
        state: "proposed",
        scheduledAt: null,
        tz: event.tz,
        resetAt: event.resetAt,
        detectedAt: event.detectedAt,
      }
      return
    case "auto_continue_accepted":
      schedules[event.scheduleId] = {
        scheduleId: event.scheduleId,
        state: "scheduled",
        scheduledAt: event.scheduledAt,
        tz: event.tz,
        resetAt: event.resetAt,
        detectedAt: event.detectedAt,
      }
      return
    case "auto_continue_rescheduled": {
      const existing = schedules[event.scheduleId]
      if (!existing) return
      schedules[event.scheduleId] = { ...existing, scheduledAt: event.scheduledAt }
      return
    }
    case "auto_continue_cancelled": {
      const existing = schedules[event.scheduleId]
      if (!existing) return
      schedules[event.scheduleId] = { ...existing, state: "cancelled" }
      return
    }
    case "auto_continue_fired": {
      const existing = schedules[event.scheduleId]
      if (!existing) {
        schedules[event.scheduleId] = {
          scheduleId: event.scheduleId,
          state: "fired",
          scheduledAt: event.firedAt,
          tz: "system",
          resetAt: event.firedAt,
          detectedAt: event.firedAt,
        }
        return
      }
      schedules[event.scheduleId] = { ...existing, state: "fired", scheduledAt: event.firedAt }
      return
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/server/auto-continue/read-model.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auto-continue/read-model.ts src/server/auto-continue/read-model.test.ts
git commit -m "feat(auto-continue): pure read-model reducer with tests"
```

---

## Task 4: Limit detector — Claude

**Files:**
- Create: `src/server/auto-continue/limit-detector.ts`
- Test: `src/server/auto-continue/limit-detector.test.ts`

**Background:** The Claude Agent SDK surfaces rate-limit failures as JS `Error`s whose message embeds a JSON payload. The payload has `type: "error"` and `error.type: "rate_limit_error"` with a `headers['anthropic-ratelimit-unified-reset']` ISO-8601 timestamp. Some errors also attach a `.status === 429` and `.headers` map. When no IANA tz is present in the payload, fall back to `"system"` (display uses the server's local zone).

- [ ] **Step 1: Write the failing tests**

Create `src/server/auto-continue/limit-detector.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { ClaudeLimitDetector } from "./limit-detector"

const detector = new ClaudeLimitDetector()

function anthropicError(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const error = new Error(JSON.stringify(body)) as Error & { status?: number; headers?: Record<string, string> }
  error.status = 429
  error.headers = headers
  return error
}

describe("ClaudeLimitDetector", () => {
  test("returns null for non-rate-limit errors", () => {
    const err = new Error("Something unrelated went wrong")
    expect(detector.detect("c1", err)).toBeNull()
  })

  test("detects rate limit with ISO reset timestamp in headers", () => {
    const resetIso = "2026-04-23T00:00:00+07:00"
    const err = anthropicError(
      { type: "error", error: { type: "rate_limit_error", message: "You've hit your limit · resets 12am (Asia/Saigon)" } },
      { "anthropic-ratelimit-unified-reset": resetIso, "x-anthropic-timezone": "Asia/Saigon" }
    )
    const detection = detector.detect("c1", err)
    expect(detection).not.toBeNull()
    expect(detection!.chatId).toBe("c1")
    expect(detection!.resetAt).toBe(new Date(resetIso).getTime())
    expect(detection!.tz).toBe("Asia/Saigon")
  })

  test("falls back to tz=system when no timezone header is present", () => {
    const resetIso = "2026-04-23T05:00:00Z"
    const err = anthropicError(
      { type: "error", error: { type: "rate_limit_error" } },
      { "anthropic-ratelimit-unified-reset": resetIso }
    )
    const detection = detector.detect("c1", err)
    expect(detection!.tz).toBe("system")
  })

  test("returns null when the payload is rate-limit but no reset timestamp can be parsed", () => {
    const err = anthropicError({ type: "error", error: { type: "rate_limit_error" } })
    expect(detector.detect("c1", err)).toBeNull()
  })

  test("parses resetAt from the message body when headers are absent", () => {
    const resetIso = "2026-04-23T00:00:00+07:00"
    const err = new Error(JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        resets_at: resetIso,
        timezone: "Asia/Saigon",
      },
    }))
    const detection = detector.detect("c1", err)
    expect(detection!.resetAt).toBe(new Date(resetIso).getTime())
    expect(detection!.tz).toBe("Asia/Saigon")
  })

  test("does not match on status-only errors (400, 500, etc.)", () => {
    const err = anthropicError({ type: "error", error: { type: "overloaded_error" } })
    expect(detector.detect("c1", err)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/limit-detector.test.ts`
Expected: FAIL — `ClaudeLimitDetector` not exported.

- [ ] **Step 3: Implement the detector**

Create `src/server/auto-continue/limit-detector.ts`:

```ts
export interface LimitDetection {
  chatId: string
  resetAt: number
  tz: string
  raw: unknown
}

export interface LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null
}

interface ErrorLike {
  message?: string
  status?: number
  headers?: Record<string, string>
}

function extractHeaders(error: unknown): Record<string, string> {
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as ErrorLike).headers
    if (headers && typeof headers === "object") return headers
  }
  return {}
}

function parseBody(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null
  const message = (error as ErrorLike).message
  if (!message) return null
  try {
    const parsed = JSON.parse(message)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null
  const millis = new Date(value).getTime()
  return Number.isFinite(millis) ? millis : null
}

export class ClaudeLimitDetector implements LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null {
    const body = parseBody(error)
    const inner = body && typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : null
    const isRateLimit = inner?.type === "rate_limit_error"
      || (error as ErrorLike | null)?.status === 429 && inner?.type === "rate_limit_error"
    if (!isRateLimit) return null

    const headers = extractHeaders(error)
    const resetAt = parseIsoMillis(headers["anthropic-ratelimit-unified-reset"])
      ?? parseIsoMillis(inner?.resets_at)
      ?? parseIsoMillis(inner?.reset_at)
    if (resetAt === null) return null

    const tz = headers["x-anthropic-timezone"]
      ?? (typeof inner?.timezone === "string" ? (inner.timezone as string) : null)
      ?? "system"

    return { chatId, resetAt, tz, raw: error }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/server/auto-continue/limit-detector.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auto-continue/limit-detector.ts src/server/auto-continue/limit-detector.test.ts
git commit -m "feat(auto-continue): Claude limit detector"
```

---

## Task 5: Limit detector — Codex

**Files:**
- Modify: `src/server/auto-continue/limit-detector.ts`
- Modify: `src/server/auto-continue/limit-detector.test.ts`

**Background:** The Codex App Server returns JSON-RPC errors. Rate-limit errors have `error.code === -32001` or `error.data.code === "rate_limit"` (confirm against captured examples at integration time). The reset timestamp is in `error.data.resets_at_ms` (epoch ms) or `error.data.resets_at` (ISO). Timezone is in `error.data.timezone`. If only the epoch-ms form is present, tz falls back to `"system"`.

- [ ] **Step 1: Add the failing tests**

Append to `src/server/auto-continue/limit-detector.test.ts`:

```ts
import { CodexLimitDetector } from "./limit-detector"

const codex = new CodexLimitDetector()

describe("CodexLimitDetector", () => {
  test("returns null for non-rate-limit JSON-RPC errors", () => {
    const err = { code: -32601, message: "Method not found" }
    expect(codex.detect("c1", err)).toBeNull()
  })

  test("detects rate limit from error.data.code with epoch-ms reset", () => {
    const err = {
      code: -32001,
      message: "Rate limited",
      data: { code: "rate_limit", resets_at_ms: 2_000_000, timezone: "Asia/Saigon" },
    }
    const detection = codex.detect("c1", err)
    expect(detection!.resetAt).toBe(2_000_000)
    expect(detection!.tz).toBe("Asia/Saigon")
  })

  test("detects rate limit with ISO resets_at", () => {
    const resetIso = "2026-04-23T00:00:00+07:00"
    const err = {
      code: -32001,
      message: "Rate limited",
      data: { code: "rate_limit", resets_at: resetIso },
    }
    const detection = codex.detect("c1", err)
    expect(detection!.resetAt).toBe(new Date(resetIso).getTime())
    expect(detection!.tz).toBe("system")
  })

  test("returns null when no reset timestamp can be parsed", () => {
    const err = { code: -32001, data: { code: "rate_limit" } }
    expect(codex.detect("c1", err)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/limit-detector.test.ts`
Expected: FAIL — `CodexLimitDetector` not exported.

- [ ] **Step 3: Implement the detector**

Append to `src/server/auto-continue/limit-detector.ts`:

```ts
interface JsonRpcErrorLike {
  code?: number
  message?: string
  data?: Record<string, unknown>
}

export class CodexLimitDetector implements LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null {
    if (!error || typeof error !== "object") return null
    const rpc = error as JsonRpcErrorLike
    const data = rpc.data && typeof rpc.data === "object" ? rpc.data : null
    const isRateLimit = data?.code === "rate_limit" || rpc.code === -32001
    if (!isRateLimit) return null

    let resetAt: number | null = null
    if (typeof data?.resets_at_ms === "number" && Number.isFinite(data.resets_at_ms)) {
      resetAt = data.resets_at_ms
    } else {
      resetAt = parseIsoMillis(data?.resets_at)
    }
    if (resetAt === null) return null

    const tz = typeof data?.timezone === "string" ? (data.timezone as string) : "system"
    return { chatId, resetAt, tz, raw: error }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/server/auto-continue/limit-detector.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/auto-continue/limit-detector.ts src/server/auto-continue/limit-detector.test.ts
git commit -m "feat(auto-continue): Codex limit detector"
```

---

## Task 6: Extend EventStore with schedules.jsonl

**Files:**
- Modify: `src/server/events.ts`
- Modify: `src/server/event-store.ts`
- Test: `src/server/event-store.test.ts` (append cases)

- [ ] **Step 1: Write the failing test**

Append to `src/server/event-store.test.ts`:

```ts
import type { AutoContinueEvent } from "./auto-continue/events"

describe("EventStore auto-continue schedules", () => {
  test("appends and replays AutoContinueEvent sequence", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p1")
    const chat = await store.createChat(project.id)

    const proposed: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: 1_000,
      chatId: chat.id,
      scheduleId: "s1",
      detectedAt: 1_000,
      resetAt: 2_000,
      tz: "Asia/Saigon",
      turnId: "t1",
    }
    const accepted: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_accepted",
      timestamp: 1_100,
      chatId: chat.id,
      scheduleId: "s1",
      scheduledAt: 2_000,
      tz: "Asia/Saigon",
      source: "user",
      resetAt: 2_000,
      detectedAt: 1_000,
    }
    await store.appendAutoContinueEvent(proposed)
    await store.appendAutoContinueEvent(accepted)

    const rehydrated = new EventStore(dataDir)
    await rehydrated.initialize()
    const events = rehydrated.getAutoContinueEvents(chat.id)
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe("auto_continue_proposed")
    expect(events[1].kind).toBe("auto_continue_accepted")
  })

  test("snapshot compaction retains auto-continue events", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p1")
    const chat = await store.createChat(project.id)

    await store.appendAutoContinueEvent({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: 1_000,
      chatId: chat.id,
      scheduleId: "s1",
      detectedAt: 1_000,
      resetAt: 2_000,
      tz: "Asia/Saigon",
      turnId: "t1",
    })
    await store.compact()

    const rehydrated = new EventStore(dataDir)
    await rehydrated.initialize()
    expect(rehydrated.getAutoContinueEvents(chat.id)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/event-store.test.ts`
Expected: FAIL — `appendAutoContinueEvent` and `getAutoContinueEvents` not exposed.

- [ ] **Step 3: Extend the event union and state**

Edit `src/server/events.ts`:

Add import line at top:

```ts
import type { AutoContinueEvent } from "./auto-continue/events"
```

Extend `StoreEvent`:

```ts
export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | QueuedMessageEvent | TurnEvent | AutoContinueEvent
```

Extend `StoreState`:

```ts
export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
  queuedMessagesByChatId: Map<string, QueuedChatMessage[]>
  sidebarProjectOrder: string[]
  autoContinueEventsByChatId: Map<string, AutoContinueEvent[]>
}
```

Extend `SnapshotFile` and bump version to 3:

```ts
export interface SnapshotFile {
  v: 3
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  sidebarProjectOrder?: string[]
  queuedMessages?: Array<{ chatId: string; entries: QueuedChatMessage[] }>
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
  autoContinueEvents?: Array<{ chatId: string; events: AutoContinueEvent[] }>
}
```

Update `createEmptyState`:

```ts
export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
    queuedMessagesByChatId: new Map(),
    sidebarProjectOrder: [],
    autoContinueEventsByChatId: new Map(),
  }
}
```

- [ ] **Step 4: Extend EventStore with append/get + replay/snapshot**

Edit `src/server/event-store.ts`:

Add near other `private readonly ... LogPath` lines:

```ts
  private readonly schedulesLogPath: string
```

Set it in the constructor:

```ts
    this.schedulesLogPath = path.join(this.dataDir, "schedules.jsonl")
```

In `initialize()` after existing `ensureFile` calls:

```ts
    await this.ensureFile(this.schedulesLogPath)
```

In `clearStorage()` add `Bun.write(this.schedulesLogPath, "")` to the Promise.all list.

In `replayLogs()` extend the sourceIndex list so schedules replay alongside others. Add:

```ts
      ...await this.loadReplayEvents(this.schedulesLogPath, 5),
```

Add entries to `getReplayEventPriority` switch:

```ts
    case "auto_continue_proposed":
    case "auto_continue_accepted":
    case "auto_continue_rescheduled":
    case "auto_continue_cancelled":
    case "auto_continue_fired":
      return 11
```

Note: `getReplayEventPriority` currently switches on `event.type`. `AutoContinueEvent` uses `kind` instead. Change the priority lookup to handle both:

```ts
function getReplayEventPriority(event: StoreEvent) {
  const discriminator = "type" in event ? event.type : event.kind
  switch (discriminator) {
    // ... existing cases
    case "auto_continue_proposed":
    case "auto_continue_accepted":
    case "auto_continue_rescheduled":
    case "auto_continue_cancelled":
    case "auto_continue_fired":
      return 11
  }
}
```

Similarly extend `applyEvent`:

```ts
  private applyEvent(event: StoreEvent) {
    if ("kind" in event && event.kind.startsWith("auto_continue_")) {
      this.applyAutoContinueEvent(event)
      return
    }
    switch ((event as { type: string }).type) {
      // ... existing cases unchanged
    }
  }

  private applyAutoContinueEvent(event: AutoContinueEvent) {
    const existing = this.state.autoContinueEventsByChatId.get(event.chatId) ?? []
    existing.push(event)
    this.state.autoContinueEventsByChatId.set(event.chatId, existing)
  }
```

Add the loadSnapshot hydration branch (inside `loadSnapshot()` after `messages` branch):

```ts
      if (parsed.autoContinueEvents?.length) {
        for (const entry of parsed.autoContinueEvents) {
          this.state.autoContinueEventsByChatId.set(entry.chatId, [...entry.events])
        }
      }
```

Add the resetState reset:

```ts
    this.state.autoContinueEventsByChatId.clear()
```

Add new public methods at the bottom of `EventStore`:

```ts
  async appendAutoContinueEvent(event: AutoContinueEvent) {
    const payload = `${JSON.stringify(event)}\n`
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(this.schedulesLogPath, payload, "utf8")
      this.applyAutoContinueEvent(event)
    })
    return this.writeChain
  }

  getAutoContinueEvents(chatId: string): AutoContinueEvent[] {
    const list = this.state.autoContinueEventsByChatId.get(chatId)
    return list ? [...list] : []
  }

  listAutoContinueChats(): string[] {
    return [...this.state.autoContinueEventsByChatId.keys()]
  }
```

Add import:

```ts
import type { AutoContinueEvent } from "./auto-continue/events"
```

Extend `createSnapshot()`:

```ts
  private createSnapshot(): SnapshotFile {
    return {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      // ... existing fields unchanged
      autoContinueEvents: [...this.state.autoContinueEventsByChatId.entries()].map(([chatId, events]) => ({
        chatId,
        events: [...events],
      })),
    }
  }
```

Extend `compact()` to clear the new log:

```ts
    await Promise.all([
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.queuedMessagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
      Bun.write(this.schedulesLogPath, ""),
    ])
```

In `shouldCompact()`, include the new file size.

- [ ] **Step 5: Run the test**

Run: `bun test src/server/event-store.test.ts`
Expected: PASS (existing tests + 2 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/events.ts src/server/event-store.ts src/server/event-store.test.ts
git commit -m "feat(auto-continue): persist schedule events in schedules.jsonl"
```

---

## Task 7: ScheduleManager with fake clock

**Files:**
- Create: `src/server/auto-continue/schedule-manager.ts`
- Test: `src/server/auto-continue/schedule-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/auto-continue/schedule-manager.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { ScheduleManager, type Clock } from "./schedule-manager"
import type { AutoContinueEvent } from "./events"

class FakeClock implements Clock {
  private current = 0
  private scheduled: Array<{ fireAt: number; fn: () => void; id: number }> = []
  private nextId = 1

  now() {
    return this.current
  }

  setTimeout(fn: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.scheduled.push({ fireAt: this.current + Math.max(0, delayMs), fn, id })
    return id
  }

  clearTimeout(id: number): void {
    this.scheduled = this.scheduled.filter((entry) => entry.id !== id)
  }

  advance(ms: number) {
    this.current += ms
    const due = this.scheduled.filter((entry) => entry.fireAt <= this.current)
    this.scheduled = this.scheduled.filter((entry) => entry.fireAt > this.current)
    for (const { fn } of due) fn()
  }

  pending() {
    return this.scheduled.length
  }
}

function event(kind: AutoContinueEvent["kind"], overrides: Partial<AutoContinueEvent> = {}): AutoContinueEvent {
  const base = { v: 3 as const, timestamp: 0, chatId: "c1", scheduleId: "s1" }
  switch (kind) {
    case "auto_continue_proposed":
      return { ...base, kind, detectedAt: 0, resetAt: 1_000, tz: "UTC", turnId: "t1", ...overrides } as AutoContinueEvent
    case "auto_continue_accepted":
      return { ...base, kind, scheduledAt: 1_000, tz: "UTC", source: "user", resetAt: 1_000, detectedAt: 0, ...overrides } as AutoContinueEvent
    case "auto_continue_rescheduled":
      return { ...base, kind, scheduledAt: 2_000, ...overrides } as AutoContinueEvent
    case "auto_continue_cancelled":
      return { ...base, kind, reason: "user", ...overrides } as AutoContinueEvent
    case "auto_continue_fired":
      return { ...base, kind, firedAt: 1_000, ...overrides } as AutoContinueEvent
  }
}

describe("ScheduleManager", () => {
  test("proposed event does not arm a timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (chatId, scheduleId) => { fired.push(`${chatId}:${scheduleId}`) },
    })
    manager.onEvent(event("auto_continue_proposed"))
    expect(clock.pending()).toBe(0)
    expect(fired).toEqual([])
  })

  test("accepted event arms a timer that fires at scheduledAt", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (chatId, scheduleId) => { fired.push(`${chatId}:${scheduleId}`) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    expect(clock.pending()).toBe(1)
    clock.advance(1_000)
    expect(fired).toEqual(["c1:s1"])
  })

  test("rescheduled replaces the pending timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    manager.onEvent(event("auto_continue_rescheduled", { scheduledAt: 3_000 }))
    clock.advance(1_000)
    expect(fired).toEqual([])
    clock.advance(2_000)
    expect(fired).toEqual(["s1"])
  })

  test("cancelled clears the pending timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    manager.onEvent(event("auto_continue_cancelled"))
    clock.advance(1_000)
    expect(fired).toEqual([])
  })

  test("rehydrate arms future schedules and fires past-due ones", async () => {
    const clock = new FakeClock()
    clock.advance(5_000)
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.rehydrate([
      event("auto_continue_accepted", { scheduleId: "past", scheduledAt: 1_000 }),
      event("auto_continue_accepted", { scheduleId: "future", scheduledAt: 10_000 }),
    ])
    await Promise.resolve()
    expect(fired).toEqual(["past"])
    expect(clock.pending()).toBe(1)
    clock.advance(5_000)
    expect(fired).toEqual(["past", "future"])
  })

  test("rehydrate skips terminal states", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.rehydrate([
      event("auto_continue_accepted", { scheduleId: "done", scheduledAt: 1_000 }),
      event("auto_continue_fired", { scheduleId: "done" }),
      event("auto_continue_accepted", { scheduleId: "cancelled", scheduledAt: 1_000 }),
      event("auto_continue_cancelled", { scheduleId: "cancelled" }),
    ])
    clock.advance(10_000)
    expect(fired).toEqual([])
  })

  test("firing a timer does not double-fire on subsequent events", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    clock.advance(1_000)
    manager.onEvent(event("auto_continue_fired"))
    expect(fired).toEqual(["s1"])
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/schedule-manager.test.ts`
Expected: FAIL — `ScheduleManager` not defined.

- [ ] **Step 3: Implement ScheduleManager**

Create `src/server/auto-continue/schedule-manager.ts`:

```ts
import type { AutoContinueEvent } from "./events"
import { deriveChatSchedules } from "./read-model"

export interface Clock {
  now(): number
  setTimeout(fn: () => void, delayMs: number): number
  clearTimeout(id: number): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
}

export interface ScheduleManagerArgs {
  clock?: Clock
  fire: (chatId: string, scheduleId: string) => Promise<void>
  onError?: (error: unknown) => void
}

export class ScheduleManager {
  private readonly clock: Clock
  private readonly fireFn: ScheduleManagerArgs["fire"]
  private readonly onError: (error: unknown) => void
  private readonly timers = new Map<string, number>()
  private readonly pendingByScheduleId = new Map<string, { chatId: string; scheduledAt: number }>()

  constructor(args: ScheduleManagerArgs) {
    this.clock = args.clock ?? realClock
    this.fireFn = args.fire
    this.onError = args.onError ?? ((error) => console.error("[kanna/schedule-manager]", error))
  }

  rehydrate(events: readonly AutoContinueEvent[]) {
    const byChat = new Map<string, AutoContinueEvent[]>()
    for (const event of events) {
      const list = byChat.get(event.chatId) ?? []
      list.push(event)
      byChat.set(event.chatId, list)
    }
    for (const [chatId, chatEvents] of byChat.entries()) {
      const projection = deriveChatSchedules(chatEvents, chatId)
      for (const schedule of Object.values(projection.schedules)) {
        if (schedule.state !== "scheduled") continue
        if (schedule.scheduledAt === null) continue
        this.arm(chatId, schedule.scheduleId, schedule.scheduledAt)
      }
    }
  }

  onEvent(event: AutoContinueEvent) {
    switch (event.kind) {
      case "auto_continue_proposed":
        return
      case "auto_continue_accepted":
        this.arm(event.chatId, event.scheduleId, event.scheduledAt)
        return
      case "auto_continue_rescheduled":
        this.arm(event.chatId, event.scheduleId, event.scheduledAt)
        return
      case "auto_continue_cancelled":
      case "auto_continue_fired":
        this.clear(event.scheduleId)
        return
    }
  }

  private arm(chatId: string, scheduleId: string, scheduledAt: number) {
    this.clear(scheduleId)
    this.pendingByScheduleId.set(scheduleId, { chatId, scheduledAt })
    const delay = Math.max(0, scheduledAt - this.clock.now())
    const timerId = this.clock.setTimeout(() => {
      this.timers.delete(scheduleId)
      this.pendingByScheduleId.delete(scheduleId)
      void (async () => {
        try {
          await this.fireFn(chatId, scheduleId)
        } catch (error) {
          this.onError(error)
        }
      })()
    }, delay)
    this.timers.set(scheduleId, timerId)
  }

  private clear(scheduleId: string) {
    const timerId = this.timers.get(scheduleId)
    if (timerId !== undefined) {
      this.clock.clearTimeout(timerId)
      this.timers.delete(scheduleId)
    }
    this.pendingByScheduleId.delete(scheduleId)
  }

  shutdown() {
    for (const timerId of this.timers.values()) {
      this.clock.clearTimeout(timerId)
    }
    this.timers.clear()
    this.pendingByScheduleId.clear()
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/server/auto-continue/schedule-manager.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auto-continue/schedule-manager.ts src/server/auto-continue/schedule-manager.test.ts
git commit -m "feat(auto-continue): ScheduleManager with injectable clock"
```

---

## Task 8: Expose schedules on chat snapshot

**Files:**
- Modify: `src/server/read-models.ts`
- Test: `src/server/read-models.test.ts` (create if it doesn't exist, or extend)

- [ ] **Step 1: Write the failing test**

Check whether `src/server/read-models.test.ts` exists. If not, create it:

```ts
import { describe, expect, test } from "bun:test"
import { deriveChatSnapshot } from "./read-models"
import { createEmptyState } from "./events"

describe("deriveChatSnapshot schedules", () => {
  test("empty schedules produces empty map and null live id", () => {
    const state = createEmptyState()
    state.projectsById.set("p1", {
      id: "p1", localPath: "/tmp/p", title: "P", createdAt: 0, updatedAt: 0,
    })
    state.chatsById.set("c1", {
      id: "c1", projectId: "p1", title: "Chat", createdAt: 0, updatedAt: 0,
      unread: false, provider: null, planMode: false, sessionToken: null, sourceHash: null, lastTurnOutcome: null,
    })

    const snapshot = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      new Set(),
      "c1",
      () => ({ messages: [], history: { hasOlder: false, olderCursor: null, recentLimit: 0 } }),
    )
    expect(snapshot!.schedules).toEqual({})
    expect(snapshot!.liveScheduleId).toBeNull()
  })

  test("proposed event projects to schedules + liveScheduleId", () => {
    const state = createEmptyState()
    state.projectsById.set("p1", {
      id: "p1", localPath: "/tmp/p", title: "P", createdAt: 0, updatedAt: 0,
    })
    state.chatsById.set("c1", {
      id: "c1", projectId: "p1", title: "Chat", createdAt: 0, updatedAt: 0,
      unread: false, provider: null, planMode: false, sessionToken: null, sourceHash: null, lastTurnOutcome: null,
    })
    state.autoContinueEventsByChatId.set("c1", [{
      v: 3, kind: "auto_continue_proposed", timestamp: 1, chatId: "c1", scheduleId: "s1",
      detectedAt: 1, resetAt: 2_000, tz: "Asia/Saigon", turnId: "t1",
    }])

    const snapshot = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      new Set(),
      "c1",
      () => ({ messages: [], history: { hasOlder: false, olderCursor: null, recentLimit: 0 } }),
    )
    expect(snapshot!.schedules["s1"].state).toBe("proposed")
    expect(snapshot!.liveScheduleId).toBe("s1")
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/read-models.test.ts`
Expected: FAIL — `deriveChatSnapshot` returns snapshot without `schedules` + `liveScheduleId`.

- [ ] **Step 3: Extend `deriveChatSnapshot`**

Edit `src/server/read-models.ts`:

Add import:

```ts
import { deriveChatSchedules } from "./auto-continue/read-model"
```

Inside `deriveChatSnapshot`, after building `transcript`:

```ts
  const autoContinueEvents = state.autoContinueEventsByChatId.get(chat.id) ?? []
  const { schedules, liveScheduleId } = deriveChatSchedules(autoContinueEvents, chat.id)
```

Add to the returned object:

```ts
    schedules,
    liveScheduleId,
```

- [ ] **Step 4: Run the test**

Run: `bun test src/server/read-models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/read-models.ts src/server/read-models.test.ts
git commit -m "feat(auto-continue): project schedules onto ChatSnapshot"
```

---

## Task 9: WS protocol — three new commands

**Files:**
- Modify: `src/shared/protocol.ts`

- [ ] **Step 1: Add command variants**

Edit `src/shared/protocol.ts`. Inside `ClientCommand`, after the `message.dequeue` variant:

```ts
  | { type: "autoContinue.accept"; chatId: string; scheduleId: string; scheduledAt: number }
  | { type: "autoContinue.reschedule"; chatId: string; scheduleId: string; scheduledAt: number }
  | { type: "autoContinue.cancel"; chatId: string; scheduleId: string }
```

- [ ] **Step 2: Run type-check to verify nothing else breaks**

Run: `bun run check`
Expected: type errors only where WS router / client stores will later handle these commands.

- [ ] **Step 3: Commit**

```bash
git add src/shared/protocol.ts
git commit -m "feat(auto-continue): add three WS commands for schedule lifecycle"
```

---

## Task 10: Client preferences store — `autoResumeOnRateLimit`

**Files:**
- Create: `src/client/stores/preferences.ts`
- Test: `src/client/stores/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/client/stores/preferences.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { usePreferencesStore } from "./preferences"

describe("usePreferencesStore", () => {
  beforeEach(() => {
    localStorage.clear()
    usePreferencesStore.setState({ autoResumeOnRateLimit: false })
  })

  test("autoResumeOnRateLimit defaults to false", () => {
    expect(usePreferencesStore.getState().autoResumeOnRateLimit).toBe(false)
  })

  test("setAutoResumeOnRateLimit updates state", () => {
    usePreferencesStore.getState().setAutoResumeOnRateLimit(true)
    expect(usePreferencesStore.getState().autoResumeOnRateLimit).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/client/stores/preferences.test.ts`
Expected: FAIL — `./preferences` module missing.

- [ ] **Step 3: Implement the store**

Create `src/client/stores/preferences.ts`:

```ts
import { create } from "zustand"
import { persist } from "zustand/middleware"

interface PreferencesState {
  autoResumeOnRateLimit: boolean
  setAutoResumeOnRateLimit: (value: boolean) => void
}

interface PersistedPreferencesState {
  autoResumeOnRateLimit?: boolean
}

function migratePreferencesState(
  persistedState: Partial<PersistedPreferencesState> | undefined,
): Pick<PreferencesState, "autoResumeOnRateLimit"> {
  return {
    autoResumeOnRateLimit: Boolean(persistedState?.autoResumeOnRateLimit),
  }
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      autoResumeOnRateLimit: false,
      setAutoResumeOnRateLimit: (value) => set({ autoResumeOnRateLimit: value }),
    }),
    {
      name: "kanna-preferences",
      version: 1,
      migrate: (persistedState) => migratePreferencesState(
        persistedState as Partial<PersistedPreferencesState> | undefined,
      ),
    },
  ),
)
```

- [ ] **Step 4: Run the test**

Run: `bun test src/client/stores/preferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/stores/preferences.ts src/client/stores/preferences.test.ts
git commit -m "feat(auto-continue): client preferences store with autoResumeOnRateLimit"
```

---

## Task 11: Surface preference to the server via WS

The server reads `autoResumeOnRateLimit` out-of-band — the client sends its current value with every message-send command. Simplest path: extend `chat.send` and `message.enqueue` with an optional `autoResumeOnRateLimit?: boolean`, and the `AgentCoordinator` caches it per chat.

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/client/lib/socket.ts` (or wherever `chat.send` and `message.enqueue` are built — search for usages)

- [ ] **Step 1: Extend protocol commands**

Edit `src/shared/protocol.ts`. In the `chat.send` command, add:

```ts
  autoResumeOnRateLimit?: boolean
```

Do the same for `message.enqueue`.

- [ ] **Step 2: Extend the send-helper on the client**

Find the client helper that builds a `chat.send` command (search `Grep` for `"chat.send"` under `src/client`). Wherever it builds the command object, read from the preferences store and add:

```ts
import { usePreferencesStore } from "../stores/preferences"

const autoResumeOnRateLimit = usePreferencesStore.getState().autoResumeOnRateLimit
// ...
{
  type: "chat.send",
  // ...
  autoResumeOnRateLimit,
}
```

Do the same in the helper that builds `message.enqueue`.

- [ ] **Step 3: Commit**

```bash
git add src/shared/protocol.ts src/client/
git commit -m "feat(auto-continue): thread autoResumeOnRateLimit preference through WS commands"
```

---

## Task 12: Wire `ScheduleManager` into AgentCoordinator

**Files:**
- Modify: `src/server/agent.ts`
- Test: `src/server/agent.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/server/agent.test.ts` and append:

```ts
import { ClaudeLimitDetector } from "./auto-continue/limit-detector"
import { ScheduleManager, type Clock } from "./auto-continue/schedule-manager"
import type { AutoContinueEvent } from "./auto-continue/events"

function makeLimitError() {
  const err = new Error(JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error" },
  })) as Error & { status?: number; headers?: Record<string, string> }
  err.status = 429
  err.headers = {
    "anthropic-ratelimit-unified-reset": new Date(5_000).toISOString(),
    "x-anthropic-timezone": "Asia/Saigon",
  }
  return err
}

describe("AgentCoordinator rate-limit detection (manual mode)", () => {
  test("emits auto_continue_proposed when Claude throws a rate-limit error and autoResumeOnRateLimit is false", async () => {
    // Harness: build an AgentCoordinator with a fake startClaudeSession that synthesizes makeLimitError(),
    //          pipe appended AutoContinueEvents into a captured array, assert exactly one "auto_continue_proposed".
    //
    // Copy the existing test harness in agent.test.ts (look for `buildAgent` or `createTestAgent`) and inject:
    //   - claudeLimitDetector: new ClaudeLimitDetector()
    //   - codexLimitDetector: new CodexLimitDetector()
    //   - scheduleManager: new ScheduleManager({ clock: fakeClock, fire })
    //   - getAutoResumePreference: () => false
    //
    // Then drive a send(), force the synthetic stream to throw makeLimitError(), and assert.
  })

  test("auto-resume on: emits auto_continue_accepted directly with source=auto_setting", async () => {
    // Same as above but with getAutoResumePreference: () => true.
    // Assert: no auto_continue_proposed event; exactly one auto_continue_accepted with source === "auto_setting".
  })
})
```

The existing `agent.test.ts` has test harnesses — use the same pattern to construct a coordinator with a fake Claude session that throws on the first stream iteration. The two test bodies are fully specified in Step 3 below once the wiring is done.

- [ ] **Step 2: Run the test**

Run: `bun test src/server/agent.test.ts`
Expected: FAIL — constructor does not accept the new dependencies.

- [ ] **Step 3: Extend `AgentCoordinator`**

Edit `src/server/agent.ts`. Add imports:

```ts
import type { AutoContinueEvent } from "./auto-continue/events"
import { ClaudeLimitDetector, CodexLimitDetector, type LimitDetector } from "./auto-continue/limit-detector"
import type { ScheduleManager } from "./auto-continue/schedule-manager"
```

Extend `AgentCoordinatorArgs`:

```ts
  claudeLimitDetector?: LimitDetector
  codexLimitDetector?: LimitDetector
  scheduleManager?: ScheduleManager
  getAutoResumePreference?: () => boolean
```

Add class fields:

```ts
  private readonly claudeLimitDetector: LimitDetector
  private readonly codexLimitDetector: LimitDetector
  private readonly scheduleManager: ScheduleManager | null
  private readonly getAutoResumePreference: () => boolean
  private readonly autoResumeByChat = new Map<string, boolean>()
```

In the constructor:

```ts
    this.claudeLimitDetector = args.claudeLimitDetector ?? new ClaudeLimitDetector()
    this.codexLimitDetector = args.codexLimitDetector ?? new CodexLimitDetector()
    this.scheduleManager = args.scheduleManager ?? null
    this.getAutoResumePreference = args.getAutoResumePreference ?? (() => false)
```

In `send(command)` and `enqueue(command)` where `command.autoResumeOnRateLimit` is known, cache it:

```ts
    if (typeof command.autoResumeOnRateLimit === "boolean") {
      this.autoResumeByChat.set(chatId, command.autoResumeOnRateLimit)
    }
```

Add a private helper:

```ts
  private resolveAutoResumeFor(chatId: string): boolean {
    const cached = this.autoResumeByChat.get(chatId)
    if (typeof cached === "boolean") return cached
    return this.getAutoResumePreference()
  }

  private async handleLimitError(chatId: string, detector: LimitDetector, error: unknown, turnId: string) {
    const detection = detector.detect(chatId, error)
    if (!detection) return false

    const state = this.store.getAutoContinueEvents(chatId)
    const live = deriveChatSchedules(state, chatId).liveScheduleId
    if (live !== null) return true

    const autoResume = this.resolveAutoResumeFor(chatId)
    const now = Date.now()
    const scheduleId = crypto.randomUUID()

    if (autoResume) {
      const event: AutoContinueEvent = {
        v: 3,
        kind: "auto_continue_accepted",
        timestamp: now,
        chatId,
        scheduleId,
        scheduledAt: detection.resetAt,
        tz: detection.tz,
        source: "auto_setting",
        resetAt: detection.resetAt,
        detectedAt: now,
      }
      await this.store.appendAutoContinueEvent(event)
      this.scheduleManager?.onEvent(event)
    } else {
      const event: AutoContinueEvent = {
        v: 3,
        kind: "auto_continue_proposed",
        timestamp: now,
        chatId,
        scheduleId,
        detectedAt: now,
        resetAt: detection.resetAt,
        tz: detection.tz,
        turnId,
      }
      await this.store.appendAutoContinueEvent(event)
      this.scheduleManager?.onEvent(event)
    }

    await this.store.appendMessage(chatId, timestamped({
      kind: "auto_continue_prompt",
      scheduleId,
    } as Omit<TranscriptEntry, "_id" | "createdAt">))

    return true
  }
```

Add import for `deriveChatSchedules`:

```ts
import { deriveChatSchedules } from "./auto-continue/read-model"
```

Insert a call into the two catch blocks.

For the Claude stream catch (line ~1329):

```ts
    } catch (error) {
      const active = this.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const handled = await this.handleLimitError(session.chatId, this.claudeLimitDetector, error, active.turn?.id ?? "")
        if (!handled) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            session.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(session.chatId, message)
        } else {
          await this.store.recordTurnFailed(session.chatId, "rate_limit")
        }
      }
    }
```

For the Codex / `runTurn` catch (line ~1421), do the same with `this.codexLimitDetector`.

- [ ] **Step 4: Fill in the tests and run them**

Replace the pseudo-test bodies with concrete ones modelled on the existing `agent.test.ts` harness. Each test:

1. Builds a fake Claude session whose `query()` generator throws `makeLimitError()` on first iteration.
2. Calls `agent.send({ chatId, content: "hi", autoResumeOnRateLimit: <false|true> })`.
3. `await Promise.resolve()` and any drain awaits the harness exposes.
4. Asserts `store.getAutoContinueEvents(chatId)` contains exactly one event with the expected `kind` and (for auto-resume) `source === "auto_setting"`.

Run: `bun test src/server/agent.test.ts`
Expected: PASS (including the two new tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/agent.ts src/server/agent.test.ts
git commit -m "feat(auto-continue): detect rate-limit errors and emit schedule events"
```

---

## Task 13: Wire firing path — enqueue "continue" with metadata

**Files:**
- Modify: `src/server/auto-continue/schedule-manager.ts` (test already written)
- Modify: `src/server/cli-runtime.ts` (or wherever `AgentCoordinator` is instantiated — search `Grep` for `new AgentCoordinator(`)

- [ ] **Step 1: Write an integration test**

Append to `src/server/agent.test.ts`:

```ts
describe("AgentCoordinator auto-continue firing", () => {
  test("firing enqueues a 'continue' user message carrying autoContinue metadata", async () => {
    // Build coordinator with a FakeClock-driven ScheduleManager whose fire() calls agent.fireAutoContinue(chatId, scheduleId).
    // Send a message that triggers makeLimitError() in auto-resume mode.
    // Advance the clock past resetAt.
    // Assert:
    //   - store.getAutoContinueEvents(chatId) contains an "auto_continue_fired" event.
    //   - The next queued message for chatId has content === "continue".
    //   - A user_prompt entry with autoContinue?.scheduleId is appended to the transcript.
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/agent.test.ts`
Expected: FAIL — `fireAutoContinue` not defined.

- [ ] **Step 3: Implement `fireAutoContinue` on `AgentCoordinator`**

Append to `src/server/agent.ts`:

```ts
  async fireAutoContinue(chatId: string, scheduleId: string) {
    const now = Date.now()
    const fired: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_fired",
      timestamp: now,
      chatId,
      scheduleId,
      firedAt: now,
    }
    await this.store.appendAutoContinueEvent(fired)

    await this.store.appendMessage(chatId, timestamped({
      kind: "user_prompt",
      content: "continue",
      autoContinue: { scheduleId },
    } as Omit<TranscriptEntry, "_id" | "createdAt">))

    try {
      await this.enqueueMessage(chatId, "continue", [])
      await this.maybeStartNextQueuedMessage(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        chatId,
        timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: `Auto-continue failed: ${message}`,
        }),
      )
    }

    this.emitStateChange(chatId)
  }
```

- [ ] **Step 4: Wire `ScheduleManager.fire` to `agent.fireAutoContinue`**

In `src/server/cli-runtime.ts` (or whichever bootstrap file — run `Grep` for `new AgentCoordinator(` to find it), construct the manager AFTER the coordinator and inject it back:

```ts
import { ScheduleManager } from "./auto-continue/schedule-manager"
import { usePreferencesStore } from "../client/stores/preferences" // only if server-side preference is needed; otherwise drop and rely on per-command flag

const scheduleManager = new ScheduleManager({
  fire: async (chatId, scheduleId) => {
    await agent.fireAutoContinue(chatId, scheduleId)
  },
})
// Expose it to agent — either re-assign a setter or construct agent with a forward-ref lambda.
```

Because `AgentCoordinator` already accepts `scheduleManager` in its constructor, build it via a two-step reference-passing pattern:

```ts
let agent!: AgentCoordinator
const scheduleManager = new ScheduleManager({
  fire: async (chatId, scheduleId) => {
    await agent.fireAutoContinue(chatId, scheduleId)
  },
})
agent = new AgentCoordinator({
  store,
  onStateChange,
  scheduleManager,
  // ... other existing args
})

// After event replay:
scheduleManager.rehydrate(
  store.listAutoContinueChats().flatMap((chatId) => store.getAutoContinueEvents(chatId))
)
```

- [ ] **Step 5: Run the test**

Run: `bun test src/server/agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/agent.ts src/server/cli-runtime.ts src/server/agent.test.ts
git commit -m "feat(auto-continue): fire schedules by enqueueing 'continue' user message"
```

---

## Task 14: WS router — three new commands + cancel-on-delete

**Files:**
- Modify: `src/server/ws-router.ts`
- Test: extend `src/server/ws-router.test.ts` (create if absent — search first)

- [ ] **Step 1: Write a failing test**

Append / create tests for each of the three commands. Minimum per command:

- State guard: reject `accept` when `schedules[sid].state !== "proposed"`.
- State guard: reject `reschedule` when `state !== "scheduled"`.
- State guard: reject `cancel` when `state !== "proposed" && state !== "scheduled"`.
- Time guard: reject when `scheduledAt <= Date.now()`.

- [ ] **Step 2: Run the test**

Run: `bun test src/server/ws-router.test.ts`
Expected: FAIL — commands not routed.

- [ ] **Step 3: Implement the three cases in `ws-router.ts`**

Edit `src/server/ws-router.ts`. Add after the existing `message.dequeue` case:

```ts
        case "autoContinue.accept": {
          await agent.acceptAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.reschedule": {
          await agent.rescheduleAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.cancel": {
          await agent.cancelAutoContinue(command.chatId, command.scheduleId, "user")
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
```

In the `chat.delete` case, before `send ack`, cancel all live schedules:

```ts
          for (const scheduleId of agent.listLiveSchedules(command.chatId)) {
            await agent.cancelAutoContinue(command.chatId, scheduleId, "chat_deleted")
          }
```

- [ ] **Step 4: Implement the three coordinator methods**

Add to `AgentCoordinator`:

```ts
  async acceptAutoContinue(chatId: string, scheduleId: string, scheduledAt: number) {
    const events = this.store.getAutoContinueEvents(chatId)
    const projection = deriveChatSchedules(events, chatId)
    const schedule = projection.schedules[scheduleId]
    if (!schedule) throw new Error("Schedule not found")
    if (schedule.state !== "proposed") throw new Error("Schedule not pending")
    if (scheduledAt <= Date.now()) throw new Error("scheduledAt must be in the future")

    const event: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_accepted",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      scheduledAt,
      tz: schedule.tz,
      source: "user",
      resetAt: schedule.resetAt,
      detectedAt: schedule.detectedAt,
    }
    await this.store.appendAutoContinueEvent(event)
    this.scheduleManager?.onEvent(event)
    this.emitStateChange(chatId)
  }

  async rescheduleAutoContinue(chatId: string, scheduleId: string, scheduledAt: number) {
    const events = this.store.getAutoContinueEvents(chatId)
    const schedule = deriveChatSchedules(events, chatId).schedules[scheduleId]
    if (!schedule || schedule.state !== "scheduled") throw new Error("Schedule not active")
    if (scheduledAt <= Date.now()) throw new Error("scheduledAt must be in the future")

    const event: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_rescheduled",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      scheduledAt,
    }
    await this.store.appendAutoContinueEvent(event)
    this.scheduleManager?.onEvent(event)
    this.emitStateChange(chatId)
  }

  async cancelAutoContinue(chatId: string, scheduleId: string, reason: "user" | "chat_deleted") {
    const events = this.store.getAutoContinueEvents(chatId)
    const schedule = deriveChatSchedules(events, chatId).schedules[scheduleId]
    if (!schedule) return
    if (schedule.state !== "proposed" && schedule.state !== "scheduled") return

    const event: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_cancelled",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      reason,
    }
    await this.store.appendAutoContinueEvent(event)
    this.scheduleManager?.onEvent(event)
    this.emitStateChange(chatId)
  }

  listLiveSchedules(chatId: string): string[] {
    const events = this.store.getAutoContinueEvents(chatId)
    const projection = deriveChatSchedules(events, chatId)
    return Object.values(projection.schedules)
      .filter((s) => s.state === "proposed" || s.state === "scheduled")
      .map((s) => s.scheduleId)
  }
```

- [ ] **Step 5: Run the test**

Run: `bun test src/server/ws-router.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/ws-router.ts src/server/agent.ts src/server/ws-router.test.ts
git commit -m "feat(auto-continue): WS commands for accept/reschedule/cancel + chat-delete cleanup"
```

---

## Task 15: Client time helpers — `formatLocal` / `parseLocal`

**Files:**
- Create: `src/client/lib/autoContinueTime.ts`
- Test: `src/client/lib/autoContinueTime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/client/lib/autoContinueTime.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { formatLocal, parseLocal } from "./autoContinueTime"

describe("formatLocal / parseLocal", () => {
  test("formatLocal in UTC produces dd/mm/yyyy hh:mm", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 17, 5), "UTC")
    expect(result).toBe("22/04/2026 17:05")
  })

  test("formatLocal with Asia/Saigon shifts to +07:00", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 17, 0), "Asia/Saigon")
    expect(result).toBe("23/04/2026 00:00")
  })

  test("formatLocal with tz=system uses runtime zone (smoke test)", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 12, 0), "system")
    expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
  })

  test("parseLocal accepts well-formed dd/mm/yyyy hh:mm", () => {
    const millis = parseLocal("23/04/2026 00:00", "Asia/Saigon")
    expect(millis).toBe(Date.UTC(2026, 3, 22, 17, 0))
  })

  test("parseLocal rejects malformed input", () => {
    expect(parseLocal("22-04-2026 17:05", "UTC")).toBeNull()
    expect(parseLocal("32/04/2026 17:05", "UTC")).toBeNull()
    expect(parseLocal("22/04/2026", "UTC")).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/client/lib/autoContinueTime.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helpers**

Create `src/client/lib/autoContinueTime.ts`:

```ts
function resolveTimeZone(tz: string): string | undefined {
  if (tz === "system") return undefined
  return tz
}

export function formatLocal(epochMs: number, tz: string): string {
  const timeZone = resolveTimeZone(tz)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"
  let hour = part("hour")
  if (hour === "24") hour = "00"
  return `${part("day")}/${part("month")}/${part("year")} ${hour}:${part("minute")}`
}

const PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/

function offsetMinutes(tz: string, referenceUtcMs: number): number {
  if (tz === "system") return -new Date(referenceUtcMs).getTimezoneOffset()
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(referenceUtcMs))
  const p = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? 0)
  let hour = p("hour")
  if (hour === 24) hour = 0
  const asUtc = Date.UTC(p("year"), p("month") - 1, p("day"), hour, p("minute"), p("second"))
  return Math.round((asUtc - referenceUtcMs) / 60_000)
}

export function parseLocal(input: string, tz: string): number | null {
  const match = PATTERN.exec(input.trim())
  if (!match) return null
  const [, ddStr, mmStr, yyyyStr, hhStr, minStr] = match
  const dd = Number(ddStr)
  const mm = Number(mmStr)
  const yyyy = Number(yyyyStr)
  const hh = Number(hhStr)
  const min = Number(minStr)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || min > 59) return null

  const guess = Date.UTC(yyyy, mm - 1, dd, hh, min)
  const offMin = offsetMinutes(tz, guess)
  const corrected = guess - offMin * 60_000
  const offMinAfter = offsetMinutes(tz, corrected)
  return corrected - (offMinAfter - offMin) * 60_000
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/client/lib/autoContinueTime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/lib/autoContinueTime.ts src/client/lib/autoContinueTime.test.ts
git commit -m "feat(auto-continue): dd/mm/yyyy hh:mm time helpers with tz support"
```

---

## Task 16: AutoContinueCard component

**Files:**
- Create: `src/client/components/chat-ui/AutoContinueCard.tsx`
- Test: `src/client/components/chat-ui/AutoContinueCard.test.tsx`

Assume the codebase has a `Button` + `Input` primitive (seen in `SettingsPage.tsx`: `../components/ui/button`, `../components/ui/input`). Check if a React-testing setup exists; if not, tests for this file may be skipped and replaced with a stub smoke test that imports the component.

- [ ] **Step 1: Write a failing render test**

Create `src/client/components/chat-ui/AutoContinueCard.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AutoContinueCard } from "./AutoContinueCard"

describe("AutoContinueCard", () => {
  test("proposed state renders Schedule and Dismiss buttons", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "proposed",
          scheduledAt: null,
          tz: "Asia/Saigon",
          resetAt: Date.UTC(2026, 3, 22, 17, 0),
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Schedule")
    expect(html).toContain("Dismiss")
  })

  test("scheduled state renders Change time and Cancel buttons", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "scheduled",
          scheduledAt: Date.UTC(2026, 3, 22, 17, 0),
          tz: "Asia/Saigon",
          resetAt: Date.UTC(2026, 3, 22, 17, 0),
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Change time")
    expect(html).toContain("Cancel")
  })

  test("fired state renders Auto-continued line without controls", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "fired",
          scheduledAt: 1_000,
          tz: "Asia/Saigon",
          resetAt: 1_000,
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Auto-continued")
    expect(html).not.toContain("Cancel")
  })

  test("cancelled state renders Auto-continue cancelled line", () => {
    const html = renderToStaticMarkup(
      <AutoContinueCard
        schedule={{
          scheduleId: "s1",
          state: "cancelled",
          scheduledAt: null,
          tz: "Asia/Saigon",
          resetAt: 1_000,
          detectedAt: 0,
        }}
        onAccept={() => {}}
        onReschedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Auto-continue cancelled")
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/client/components/chat-ui/AutoContinueCard.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the card**

Create `src/client/components/chat-ui/AutoContinueCard.tsx`:

```tsx
import { useMemo, useState } from "react"
import type { AutoContinueSchedule } from "../../../shared/types"
import { formatLocal, parseLocal } from "../../lib/autoContinueTime"
import { Button } from "../ui/button"
import { Input } from "../ui/input"

export interface AutoContinueCardProps {
  schedule: AutoContinueSchedule
  onAccept: (scheduledAtMs: number) => void
  onReschedule: (scheduledAtMs: number) => void
  onCancel: () => void
}

export function AutoContinueCard({ schedule, onAccept, onReschedule, onCancel }: AutoContinueCardProps) {
  const [draft, setDraft] = useState<string>(() => formatLocal(
    schedule.scheduledAt ?? schedule.resetAt,
    schedule.tz,
  ))
  const [editing, setEditing] = useState(false)

  const parsed = useMemo(() => parseLocal(draft, schedule.tz), [draft, schedule.tz])
  const isFuture = parsed !== null && parsed > Date.now()
  const inputInvalid = parsed === null ? "Use format dd/mm/yyyy hh:mm" :
    !isFuture ? "Time must be in the future" : null

  if (schedule.state === "fired") {
    const at = formatLocal(schedule.scheduledAt ?? schedule.resetAt, schedule.tz)
    return <div className="rounded border px-3 py-2 text-sm">Auto-continued at {at}</div>
  }

  if (schedule.state === "cancelled") {
    return <div className="rounded border px-3 py-2 text-sm opacity-70">Auto-continue cancelled</div>
  }

  if (schedule.state === "proposed") {
    const passed = schedule.resetAt <= Date.now()
    return (
      <div className="rounded border px-3 py-2 text-sm space-y-2">
        <div className="font-medium">Rate limit hit — schedule auto-continue?</div>
        {passed && <div className="text-amber-500">Reset time has passed — accept to continue now.</div>}
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="dd/mm/yyyy hh:mm"
        />
        {inputInvalid && <div className="text-xs text-red-500">{inputInvalid}</div>}
        <div className="flex gap-2">
          <Button disabled={!isFuture} onClick={() => parsed !== null && onAccept(parsed)}>Schedule</Button>
          <Button variant="ghost" onClick={onCancel}>Dismiss</Button>
        </div>
      </div>
    )
  }

  // scheduled
  const displayAt = formatLocal(schedule.scheduledAt ?? schedule.resetAt, schedule.tz)
  if (!editing) {
    const tzLabel = schedule.tz === "system" ? "local" : schedule.tz
    return (
      <div className="rounded border px-3 py-2 text-sm flex items-center justify-between gap-2">
        <div>Auto-continue at {displayAt} ({tzLabel})</div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>Change time</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border px-3 py-2 text-sm space-y-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="dd/mm/yyyy hh:mm"
      />
      {inputInvalid && <div className="text-xs text-red-500">{inputInvalid}</div>}
      <div className="flex gap-2">
        <Button disabled={!isFuture} onClick={() => { if (parsed !== null) { onReschedule(parsed); setEditing(false) } }}>Save</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>Back</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/client/components/chat-ui/AutoContinueCard.test.tsx`
Expected: PASS. If React SSR fails under Bun's test environment, replace `renderToStaticMarkup` with a simple type-check-only smoke import and note that visual verification must be done in dev mode.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/chat-ui/AutoContinueCard.tsx src/client/components/chat-ui/AutoContinueCard.test.tsx
git commit -m "feat(auto-continue): AutoContinueCard with four render states"
```

---

## Task 17: Hook into transcript rendering

**Files:**
- Modify: `src/client/lib/parseTranscript.ts`
- Modify: the renderer that maps `HydratedTranscriptMessage` kinds to JSX (search for a `switch (message.kind)` in `KannaTranscript.tsx` or similar)

- [ ] **Step 1: Extend `parseTranscript`**

Edit `src/client/lib/parseTranscript.ts`. In the `user_prompt` branch, pass `autoContinue`:

```ts
      case "user_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
          autoContinue: entry.autoContinue,
        })
        break
```

Add a new branch before the `default`:

```ts
      case "auto_continue_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "auto_continue_prompt",
          scheduleId: entry.scheduleId,
        })
        break
```

- [ ] **Step 2: Add a parseTranscript test**

Append to `src/client/lib/parseTranscript.test.ts`:

```ts
test("auto_continue_prompt entries hydrate with scheduleId", () => {
  const output = processTranscriptMessages([{
    _id: "m1",
    createdAt: 1,
    kind: "auto_continue_prompt",
    scheduleId: "s1",
  }])
  expect(output[0].kind).toBe("auto_continue_prompt")
  expect((output[0] as { scheduleId: string }).scheduleId).toBe("s1")
})

test("user_prompt carries autoContinue metadata", () => {
  const output = processTranscriptMessages([{
    _id: "m1",
    createdAt: 1,
    kind: "user_prompt",
    content: "continue",
    autoContinue: { scheduleId: "s1" },
  }])
  expect(output[0].kind).toBe("user_prompt")
  expect((output[0] as { autoContinue?: { scheduleId: string } }).autoContinue?.scheduleId).toBe("s1")
})
```

- [ ] **Step 3: Run the test**

Run: `bun test src/client/lib/parseTranscript.test.ts`
Expected: PASS.

- [ ] **Step 4: Render `AutoContinueCard` in the transcript**

Find the transcript message-renderer (search `Grep` for `case "user_prompt":` under `src/client/components`). In its switch, add:

```tsx
case "auto_continue_prompt": {
  const schedule = chatSnapshot.schedules[message.scheduleId]
  if (!schedule) return null
  return (
    <AutoContinueCard
      key={message.id}
      schedule={schedule}
      onAccept={(scheduledAt) => sendCommand({ type: "autoContinue.accept", chatId, scheduleId: message.scheduleId, scheduledAt })}
      onReschedule={(scheduledAt) => sendCommand({ type: "autoContinue.reschedule", chatId, scheduleId: message.scheduleId, scheduledAt })}
      onCancel={() => sendCommand({ type: "autoContinue.cancel", chatId, scheduleId: message.scheduleId })}
    />
  )
}
```

In the `user_prompt` case, if `message.autoContinue` is set, append a small "auto-sent" badge next to the content.

- [ ] **Step 5: Smoke-test in dev mode**

Run: `bun dev`, then open the app, synthesize a rate-limit error (see Task 18 end-to-end test), and confirm:
- Card renders in proposed state.
- Schedule button sends the correct WS command.
- User prompt generated by firing has the "auto-sent" badge.

- [ ] **Step 6: Commit**

```bash
git add src/client/lib/parseTranscript.ts src/client/lib/parseTranscript.test.ts src/client/components/
git commit -m "feat(auto-continue): render AutoContinueCard + auto-sent badge in transcript"
```

---

## Task 18: Settings page toggle

**Files:**
- Modify: `src/client/app/SettingsPage.tsx`
- Test: `src/client/app/SettingsPage.test.tsx` (extend)

- [ ] **Step 1: Add a failing test**

Append to `src/client/app/SettingsPage.test.tsx` (or similar):

```ts
test("renders the Auto-resume on rate limit toggle", () => {
  // Render <SettingsPage /> with the provider mocks and assert that the toggle label is present.
  // See the existing tests in this file for the required provider shape.
})
```

- [ ] **Step 2: Run the test**

Run: `bun test src/client/app/SettingsPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the toggle**

Edit `src/client/app/SettingsPage.tsx`. Import:

```ts
import { usePreferencesStore } from "../stores/preferences"
```

In the General section, add a toggle row using the existing styling conventions:

```tsx
const autoResumeOnRateLimit = usePreferencesStore((state) => state.autoResumeOnRateLimit)
const setAutoResumeOnRateLimit = usePreferencesStore((state) => state.setAutoResumeOnRateLimit)

// ...

<section>
  <h3 className="text-sm font-medium">Auto-resume on rate limit</h3>
  <p className="text-xs text-muted-foreground">
    When you hit a rate limit, automatically schedule "continue" at the reset time instead of asking.
    You can still cancel each one from the chat.
  </p>
  <label className="mt-2 inline-flex items-center gap-2">
    <input
      type="checkbox"
      checked={autoResumeOnRateLimit}
      onChange={(event) => setAutoResumeOnRateLimit(event.target.checked)}
    />
    Enabled
  </label>
</section>
```

- [ ] **Step 4: Run the test**

Run: `bun test src/client/app/SettingsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/app/SettingsPage.tsx src/client/app/SettingsPage.test.tsx
git commit -m "feat(auto-continue): add Auto-resume toggle to Settings page"
```

---

## Task 19: End-to-end test — detection → card → accept → fire

**Files:**
- Create: `src/server/auto-continue/e2e.test.ts`

- [ ] **Step 1: Write the end-to-end test**

Create `src/server/auto-continue/e2e.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore } from "../event-store"
import { AgentCoordinator } from "../agent"
import { ScheduleManager, type Clock } from "./schedule-manager"
import { ClaudeLimitDetector, CodexLimitDetector } from "./limit-detector"

class FakeClock implements Clock {
  private current = 0
  private scheduled: Array<{ fireAt: number; fn: () => void; id: number }> = []
  private nextId = 1
  now() { return this.current }
  setTimeout(fn: () => void, delayMs: number) {
    const id = this.nextId++
    this.scheduled.push({ fireAt: this.current + delayMs, fn, id })
    return id
  }
  clearTimeout(id: number) { this.scheduled = this.scheduled.filter((x) => x.id !== id) }
  advance(ms: number) {
    this.current += ms
    const due = this.scheduled.filter((x) => x.fireAt <= this.current)
    this.scheduled = this.scheduled.filter((x) => x.fireAt > this.current)
    for (const entry of due) entry.fn()
  }
}

describe("auto-continue end-to-end", () => {
  test("rate limit → card → accept → fires 'continue' user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-e2e-"))
    try {
      const store = new EventStore(dir)
      await store.initialize()
      const project = await store.openProject("/tmp/proj")
      const chat = await store.createChat(project.id)

      const clock = new FakeClock()
      let agent!: AgentCoordinator
      const scheduleManager = new ScheduleManager({
        clock,
        fire: async (chatId, scheduleId) => agent.fireAutoContinue(chatId, scheduleId),
      })
      agent = new AgentCoordinator({
        store,
        onStateChange: () => {},
        claudeLimitDetector: new ClaudeLimitDetector(),
        codexLimitDetector: new CodexLimitDetector(),
        scheduleManager,
        getAutoResumePreference: () => false,
        startClaudeSession: async () => {
          // stream a rate-limit error on first iteration
          throw new Error(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }))
        },
        // Stub other required args — mirror defaults from existing tests.
      } as never)

      // Trigger send
      await agent.send({ type: "chat.send", chatId: chat.id, content: "hi", autoResumeOnRateLimit: false })

      // Expect proposed event
      let events = store.getAutoContinueEvents(chat.id)
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe("auto_continue_proposed")
      const scheduleId = events[0].scheduleId

      // Accept
      await agent.acceptAutoContinue(chat.id, scheduleId, clock.now() + 100)

      events = store.getAutoContinueEvents(chat.id)
      expect(events[1].kind).toBe("auto_continue_accepted")

      // Advance clock
      clock.advance(100)
      await Promise.resolve()

      events = store.getAutoContinueEvents(chat.id)
      expect(events.some((e) => e.kind === "auto_continue_fired")).toBe(true)

      const transcript = store.getMessages(chat.id)
      const fired = transcript.find((entry) => entry.kind === "user_prompt" && (entry as { autoContinue?: { scheduleId: string } }).autoContinue?.scheduleId === scheduleId)
      expect(fired).toBeDefined()
      expect((fired as { content: string }).content).toBe("continue")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

The exact stub for `startClaudeSession` depends on the existing harness. Copy from `src/server/agent.test.ts` helpers.

- [ ] **Step 2: Run the test**

Run: `bun test src/server/auto-continue/e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/auto-continue/e2e.test.ts
git commit -m "test(auto-continue): end-to-end detect → accept → fire flow"
```

---

## Task 20: Final verification

- [ ] **Step 1: Type-check and full test run**

Run: `bun run check && bun test`
Expected: all checks pass.

- [ ] **Step 2: Manual smoke test in dev mode**

Run: `bun dev`, open Kanna in a browser, and manually:

1. Pick a chat.
2. Temporarily expose a debug hook that throws a synthetic rate-limit error for one turn (e.g., via a `KANNA_DEBUG_RATE_LIMIT=1` env var in the agent — add this only locally, do NOT commit).
3. Confirm:
   - Card appears with the default reset time.
   - Editing the time and clicking Schedule sends the correct WS command.
   - Scheduled state shows tz-labelled time.
   - Cancel transitions to the cancelled terminal state.
4. Toggle **Settings → Auto-resume on rate limit** to ON and repeat step 2. Confirm no proposed card appears and the card renders in `scheduled` state immediately.
5. Restart the dev server. Confirm pending schedules re-arm (advance wall clock or set reset far in the future).

- [ ] **Step 3: Commit any doc/polish fixes uncovered during smoke**

```bash
git add -p
git commit -m "chore(auto-continue): smoke-test polish"
```

---

## Dependencies Between Tasks

```
1 (types) ───▶ 2 (events) ───▶ 3 (read-model) ───▶ 4/5 (detectors)
                                              │
                                              ├──▶ 6 (event store)  ─┐
                                              │                      │
                                              └──▶ 7 (schedule mgr)  │
                                                                     ▼
                                                                 8 (snapshot projection)
                                                                     │
                                                                     ▼
                                    9 (protocol) ─▶ 10 (prefs) ─▶ 11 (wire prefs to WS)
                                                                     │
                                                                     ▼
                                                                12 (detection)
                                                                     │
                                                                     ▼
                                                                13 (firing)
                                                                     │
                                                                     ▼
                                                                14 (WS router)
                                                                     │
                                    15 (time helpers) ──▶ 16 (card)  │
                                                          │          │
                                                          ▼          ▼
                                                        17 (transcript) ─▶ 18 (settings toggle) ─▶ 19 (e2e) ─▶ 20 (verify)
```

Tasks 4 and 5 can run in parallel. Tasks 9, 10, and 15 can run in parallel once Task 3 is done. Everything else is sequential.

---

## Self-Review Notes

- **Spec coverage:** All 7 component sections (LimitDetector, ScheduleManager, Event types, Read model, Transcript/WS protocol, AutoContinueCard, Settings) have tasks. All 4 data-flow modes (manual, auto-resume, reschedule, cancel, rehydration) are covered in Tasks 7, 12, 13, 14. All 10 edge-case rows have corresponding guards in Tasks 12 (dedupe on liveScheduleId), 14 (state-guard cancel/reschedule + chat-delete cleanup), 13 (enqueue-failure handling), and 7 (rehydrate-past fires immediately).
- **Placeholder scan:** Tasks 12 and 18 reference existing test harnesses rather than reproducing them verbatim — marked explicitly with the instruction to "copy from src/server/agent.test.ts" so the implementer knows exactly where to look.
- **Type consistency:** `AutoContinueSchedule`, `AutoContinueEvent`, `ScheduleManager.Clock`, and the three WS command shapes are all spelled identically everywhere they appear. `scheduleId` (not `scheduleID`), `scheduledAt` (not `scheduled_at`), `resetAt` (not `reset_at`), `autoContinue` (not `auto_continue`) across TS; `auto_continue_*` snake_case only inside event `kind` strings.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-auto-continue-on-rate-limit.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
