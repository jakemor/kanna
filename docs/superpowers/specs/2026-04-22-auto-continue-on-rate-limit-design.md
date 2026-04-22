# Auto-Continue on Rate-Limit Reset — Design

**Status:** Draft
**Author:** Kanna
**Date:** 2026-04-22

## Goal

When a chat hits a provider rate limit (e.g. *"You've hit your limit · resets 12am (Asia/Saigon)"*), Kanna should offer — or, with a setting on, silently schedule — an automatic `continue` message at the reset time so the conversation resumes without the user babysitting the clock.

Concretely:

1. Detect rate-limit errors from the **Claude Agent SDK** and the **Codex App Server** in a structured way (no text regex).
2. Render a new `AutoContinueCard` in the affected chat's transcript that:
   - In manual mode: asks the user whether to schedule `"continue"` at the parsed reset time, with an editable `dd/mm/yyyy hh:mm` text field.
   - In auto-resume mode: shows a slim "Auto-continue scheduled at …" card with Cancel / Change time controls.
3. Persist schedules in the event log so they survive pm2 reloads / reboots; catch up past-due ones immediately on startup.
4. When a schedule fires, enqueue the literal string `"continue"` as a user message in the same chat. The resulting transcript entry is rendered with an "auto-sent" badge.
5. Add a global setting `autoResumeOnRateLimit: boolean` (default `false`) in the Settings page; when on, the prompt step is skipped and a schedule is created automatically.

## Non-Goals

- No text pattern matching on assistant output. Detection is only through typed SDK / JSON-RPC error payloads.
- No configurable message text. The fired message is always the literal word `"continue"`.
- No global "rate limit" banner. Per-chat cards only, matching the existing `AskUserQuestion` layout.
- No server-side retry of failed auto-continues. If enqueue throws, surface an error entry and stop.
- No cross-account aggregation. If multiple chats on the same account hit the limit, each gets its own schedule.
- No mobile-specific UI tuning in v1 beyond what the existing transcript renderer already provides.
- No notification / sound / desktop alert on fire. The transcript update is the signal.

## Architecture

```
Browser (React)
  ChatTranscript
    └── AutoContinueCard (new)       — renders proposed/scheduled/fired/cancelled states
  SettingsPage
    └── Auto-resume toggle (new)     — autoResumeOnRateLimit

    ↕ WebSocket (existing WSRouter)

Bun Server
  auto-continue/
    ├── limit-detector.ts            — ClaudeLimitDetector + CodexLimitDetector
    ├── events.ts                    — AutoContinueEvent union
    └── schedule-manager.ts          — in-memory timers, rehydrate, fire
  agent.ts
    └── on SDK error → LimitDetector.detect() → EventStore.append(...)
  event-store.ts
    └── schedules.jsonl + snapshot integration
  read-models.ts
    └── chat.schedules + chat.liveSchedule projections
  ws-router.ts
    └── commands: acceptAutoContinue, rescheduleAutoContinue, cancelAutoContinue

~/.kanna/data/
  └── schedules.jsonl (new)
```

**New files**

- `src/server/auto-continue/limit-detector.ts`
- `src/server/auto-continue/events.ts`
- `src/server/auto-continue/schedule-manager.ts`
- `src/client/components/chat-ui/AutoContinueCard.tsx`

**Modified files**

- `src/shared/types.ts` — transcript entry kind, `PendingAutoContinueSnapshot`, settings type.
- `src/shared/protocol.ts` — WS command + event payloads.
- `src/server/event-store.ts` — register new event kinds, extend snapshot.
- `src/server/read-models.ts` — add `chat.schedules` + `chat.liveSchedule` projections.
- `src/server/agent.ts` — wire `LimitDetector` into the error path; metadata on auto-fired user messages.
- `src/server/ws-router.ts` — route the three new commands.
- `src/client/app/SettingsPage.tsx` — add the toggle.
- `src/client/stores/preferences.ts` — surface the setting.
- `src/client/lib/parseTranscript.ts` — render the new transcript entry kind.

## Components

### 1. `LimitDetector` (per provider)

```ts
type LimitDetection = {
  chatId: string
  resetAt: number    // epoch ms
  tz: string         // IANA timezone from provider; "system" fallback
  raw: unknown       // original error for diagnostics
}

interface LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null
}
```

- `ClaudeLimitDetector` — inspects Claude Agent SDK error objects. Identifies rate-limit errors by status code / typed error class and extracts the reset timestamp and timezone from the structured payload.
- `CodexLimitDetector` — same contract against Codex App Server JSON-RPC error payloads.
- If the payload lacks a timezone, set `tz = "system"` and format using the server's local zone for display.
- Returns `null` for non-limit errors — the caller falls through to the existing error path.

The detectors are pure functions over the error object. No network, no state.

### 2. `ScheduleManager`

```ts
class ScheduleManager {
  constructor(
    private eventStore: EventStore,
    private agent: AgentCoordinator,
    private clock: Clock,                   // injectable
  )

  rehydrate(): void                         // called once after event replay
  onEvent(event: AutoContinueEvent): void   // subscribed to EventStore

  private fire(chatId: string, scheduleId: string): Promise<void>
}
```

Owns `Map<scheduleId, NodeJS.Timeout>`. Single source of wall-clock timers for this feature.

- On `auto_continue_accepted` or `auto_continue_rescheduled`: clear any existing timer for that `scheduleId`, then `setTimeout(fire, scheduledAt - clock.now())`. If the delta is `≤ 0`, fire on next tick.
- On `auto_continue_cancelled` or `auto_continue_fired`: clear the timer and delete the map entry.
- `rehydrate()`: walks each entry in every chat's `schedules` map. Entries whose state is `proposed`, `fired`, or `cancelled` are skipped. Entries in `scheduled` state re-arm a `setTimeout` (or fire immediately if `scheduledAt ≤ now`).
- `fire(chatId, scheduleId)`:
  1. `eventStore.append({ kind: "auto_continue_fired", chatId, scheduleId, firedAt: now })`
  2. `agent.enqueueUserMessage(chatId, "continue", { autoContinue: true, scheduleId })`
  3. If enqueue throws, append a chat error entry and still mark the schedule fired — no retries.

### 3. Event types

```ts
type AutoContinueEvent =
  | { kind: "auto_continue_proposed";    chatId; scheduleId; detectedAt; resetAt; tz; turnId }
  | { kind: "auto_continue_accepted";    chatId; scheduleId; scheduledAt; tz; source: "user" | "auto_setting" }
  | { kind: "auto_continue_rescheduled"; chatId; scheduleId; scheduledAt }
  | { kind: "auto_continue_cancelled";   chatId; scheduleId; reason: "user" | "chat_deleted" }
  | { kind: "auto_continue_fired";       chatId; scheduleId; firedAt }
```

- `scheduleId` is a fresh UUID per schedule.
- Stored in `~/.kanna/data/schedules.jsonl`, replayed on startup, folded into `snapshot.json` alongside other derived state.
- All timestamps are epoch ms. `tz` is for display only.

### 4. Read model (`chat.schedules`)

Each chat may accumulate multiple schedules over time (one per rate-limit encounter). The transcript carries one `auto_continue_prompt` entry per schedule; the renderer looks up the live state by `scheduleId`:

```ts
chat.schedules: Record<scheduleId, {
  state: "proposed" | "scheduled" | "fired" | "cancelled"
  scheduledAt: number | null     // null while state=proposed
  tz: string
  resetAt: number                // parsed from detector, for display
}>
```

Computed from the latest event per `scheduleId`. A schedule entry is permanent once created — terminal states (`fired` / `cancelled`) remain in the map so past cards in the transcript keep rendering correctly.

A helper `chat.liveSchedule: scheduleId | null` points at the most recent schedule whose state is `proposed` or `scheduled` (or `null` if none). This is what the detector path checks to decide whether to drop a duplicate detection.

### 5. Transcript entry + WS protocol

- New transcript entry kind `auto_continue_prompt`, carrying the `scheduleId`. The renderer pulls live state from `chat.schedules[scheduleId]`.
- The user message produced when a schedule fires carries `meta: { autoContinue: true, scheduleId }` so the transcript renderer applies the "auto-sent" badge.
- New WS commands (client → server):
  - `acceptAutoContinue(scheduleId, scheduledAt)`
  - `rescheduleAutoContinue(scheduleId, scheduledAt)`
  - `cancelAutoContinue(scheduleId)`
- Each is validated against current schedule state. Stale or illegal transitions return an error result; no event is appended.

### 6. `AutoContinueCard` (client)

One component, four states off `chat.schedules[scheduleId].state` (the `scheduleId` comes from the transcript entry):

- **`proposed`** — title "Rate limit hit — schedule auto-continue?", default reset time shown as `dd/mm/yyyy hh:mm`, editable text input with inline validation, buttons **Schedule** / **Dismiss**.
- **`scheduled`** — "Auto-continue at `dd/mm/yyyy hh:mm (Asia/Saigon)`" + **Change time** / **Cancel**. Change time swaps the display line for an inline editable text input with Save / Back.
- **`fired`** — collapsed "Auto-continued at `dd/mm/yyyy hh:mm`". No controls.
- **`cancelled`** — collapsed "Auto-continue cancelled". No controls.

Time format helper `formatLocal(epochMs, tz): string` produces `dd/mm/yyyy hh:mm` rendered in `tz` (or the system zone when `tz === "system"`). Parser `parseLocal(input, tz): number | null` accepts the same format; rejects on malformed input or past times.

### 7. Settings

- `autoResumeOnRateLimit: boolean` in the user preferences store (default `false`).
- Rendered on `SettingsPage.tsx` as a single toggle with help text: *"When you hit a rate limit, automatically schedule 'continue' at the reset time instead of asking. You can still cancel each one from the chat."*
- Server reads the setting synchronously inside the error-handling path in `agent.ts`. Toggling it mid-session does not affect existing schedules.

## Data Flow

### Manual mode (autoResume = false)

1. User sends a message in chat `C1`.
2. Claude Agent SDK returns a rate-limit error during the turn.
3. `AgentCoordinator` calls `ClaudeLimitDetector.detect(C1, error)` → `{ resetAt, tz: "Asia/Saigon" }`.
4. `EventStore.append(auto_continue_proposed{ C1, S1, resetAt, tz, turnId })`.
5. Read model recomputes → `chat.schedules[S1] = { state: "proposed", ... }`, `chat.liveSchedule = S1`.
6. WSRouter broadcasts the chat snapshot; `AutoContinueCard` renders in the transcript.
7. User either:
   - Clicks **Schedule** with the default time → client sends `acceptAutoContinue(S1, resetAt)`.
   - Edits the text input to a new `dd/mm/yyyy hh:mm` → client sends `acceptAutoContinue(S1, parsed)`.
   - Clicks **Dismiss** → client sends `cancelAutoContinue(S1, reason: "user")`.
8. Server validates (state still `proposed`, time `> now`) → appends `auto_continue_accepted`.
9. `ScheduleManager` observes the event → arms a `setTimeout`.
10. When the timer fires → appends `auto_continue_fired` → `agent.enqueueUserMessage(C1, "continue", { autoContinue: true, scheduleId: S1 })`.
11. Normal chat turn runs; the transcript's user-message entry carries the `autoContinue` badge.

### Auto-resume mode (autoResume = true)

Step 4 emits `auto_continue_accepted` directly (no `proposed`), with `source: "auto_setting"` and `scheduledAt = resetAt`. Everything else is identical. The card renders in `scheduled` state from the start.

### Reschedule

Client sends `rescheduleAutoContinue(S1, newScheduledAt)` → server validates state is `scheduled` and time `> now` → appends `auto_continue_rescheduled` → `ScheduleManager` clears the old timer and arms a new one.

### Cancel

Client sends `cancelAutoContinue(S1)` → appends `auto_continue_cancelled(reason: "user")` → `ScheduleManager` clears the timer. Card renders in terminal `cancelled` state.

### Startup rehydration

On server boot, after event replay, `ScheduleManager.rehydrate()` walks every entry in every `chat.schedules` map:

- State `scheduled` with `scheduledAt ≤ now` → fire immediately.
- State `scheduled` with `scheduledAt > now` → arm a `setTimeout`.
- State `proposed` → do nothing; the card is still shown, user can accept on reconnect.
- State `fired` / `cancelled` → do nothing.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Limit detected on a chat that already has a `proposed` / `scheduled` schedule (`chat.liveSchedule != null`) | Drop the new detection. No new event, no card. The user already has a pending decision for this chat. |
| Invalid `dd/mm/yyyy hh:mm` input | Client-side inline validation, Schedule / Save button disabled. |
| User enters a time in the past | Rejected client-side with "Time must be in the future"; server also rejects the command. |
| Timer fires while the chat has a running turn or queued messages | `enqueueUserMessage` handles queueing; no feature-specific logic needed. |
| Chat deleted with a live schedule | `deleteChat` appends `auto_continue_cancelled(reason: "chat_deleted")` for each live schedule so `ScheduleManager` clears its timer. |
| Clock skew / DST / timezone changes | `scheduledAt` is epoch ms; firing is pure epoch math. `tz` is only for display. |
| `enqueueUserMessage` throws at fire time (provider not configured, etc.) | Append a chat error entry "Auto-continue failed: <reason>"; still mark the schedule `fired`. No retry. |
| User disables `autoResumeOnRateLimit` while a schedule is live | Live schedules keep firing. The setting only gates new detections. |
| Multiple provider errors in flight for the same chat | First detector to fire wins and emits the schedule. Subsequent detections in the same turn see `chat.liveSchedule != null` and are dropped. |
| `proposed` event whose `resetAt` passed while Kanna was off | Card still shows; helper text reads "Reset time has passed — accept to continue now." |
| Detector cannot find a `tz` in the error payload | `tz = "system"`; display uses server local zone. Firing still uses epoch math. |

## Testing

- **Unit: `LimitDetector`** — captured real SDK / JSON-RPC error shapes for Claude and Codex. Assert parsed `resetAt` + `tz`; `null` for non-limit errors; `tz = "system"` when absent.
- **Unit: `ScheduleManager`** — fake clock. Arm / fire / reschedule / cancel / rehydrate-past / rehydrate-future / rehydrate-after-fired / rehydrate-after-cancelled.
- **Integration: `EventStore`** — append + replay round-trip for each new event kind; snapshot compaction retains latest per-chat per-schedule state.
- **Unit: read model** — state machine transitions from every ordered subset of events.
- **Unit: WS router** — each command validates current state; rejects stale / illegal / past-time transitions; no side effects on rejection.
- **Integration: `AgentCoordinator`** — rate-limit error emits `auto_continue_proposed`; in auto-resume mode emits `auto_continue_accepted`; a fired schedule enqueues `"continue"` with `{ autoContinue: true, scheduleId }`.
- **Component: `AutoContinueCard`** — renders all four states; text-input validation; dispatches correct WS commands.
- **End-to-end (`bun test`)** — fake chat receives synthesized rate-limit error → card appears → client sends accept → fake clock advances → `"continue"` appears with auto-continue badge → chat turn runs.
- **Settings** — toggling `autoResumeOnRateLimit` flips the event emitted by the detector path; existing schedules unaffected.

## Open Questions

None at spec time. Subject to validation during `writing-plans`:

- Exact Claude Agent SDK error shape and Codex App Server JSON-RPC error shape for rate limits — confirm the fields containing reset timestamp and timezone exist, and whether they're always present.
