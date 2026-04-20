# Slash Command Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Claude Code-style `/` command picker to Kanna's chat input for Claude sessions. When the user types `/`, show a popup listing every SDK-reported slash command (built-ins + user + project + plugin + MCP). Arrow/Enter selects, text filters, Enter submits `/name args...` to the existing send path.

**Architecture:** Server queries `@anthropic-ai/claude-agent-sdk` via `query.supportedCommands()` after session start, emits a new `session.commands_loaded` turn event, `ReadModels` attaches the latest list to the chat snapshot. Client caches in a Zustand store (populated from snapshot), reads via hook, renders a new `SlashCommandPicker` component mounted from `ChatInput.tsx`. Execution unchanged — SDK dispatches commands that arrive as prompts.

**Tech Stack:** TypeScript, Bun, React 19, Zustand, Vitest/Bun tests, Tailwind, `@anthropic-ai/claude-agent-sdk`.

**Worktree:** `/Users/cuongtran/Desktop/repo/kanna/.worktrees/slash-command-picker` (branch `feature/slash-command-picker`). Baseline `bun run check` passes (see `7a22349`).

**Design reference:** `docs/plans/2026-04-20-slash-command-picker-design.md`.

---

## Task 1 — Shared `SlashCommand` type

**Files:**
- Modify: `src/shared/types.ts` (append near `ChatSnapshot` definition around line 872)

**Step 1: Add type**

In `src/shared/types.ts`, append:

```ts
export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
}
```

Then extend `ChatSnapshot`:

```ts
export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  history: ChatHistorySnapshot
  availableProviders: ProviderCatalogEntry[]
  slashCommands: SlashCommand[]
}
```

**Step 2: Run typecheck**

Run: `bun run check`
Expected: FAIL — downstream consumers of `ChatSnapshot` missing new field.

**Step 3: Add empty default at every construction site**

The one known construction site is `deriveChatSnapshot` in `src/server/read-models.ts:178-188`. Add `slashCommands: []` to the returned object. Leave any other compile errors for Task 4.

**Step 4: Re-run check**

Run: `bun run check`
Expected: PASS (or pass if only `read-models.ts` was broken — if new errors exist, fix them with `slashCommands: []` stub, no logic).

**Step 5: Commit**

```bash
git add src/shared/types.ts src/server/read-models.ts
git commit -m "feat(types): add SlashCommand type and ChatSnapshot.slashCommands"
```

---

## Task 2 — `session.commands_loaded` event type

**Files:**
- Modify: `src/server/events.ts` (extend `TurnEvent` union near line 136-168)

**Step 1: Extend `TurnEvent`**

Add a new branch to the `TurnEvent` discriminated union in `src/server/events.ts`:

```ts
  | {
      v: 2
      type: "session_commands_loaded"
      timestamp: number
      chatId: string
      commands: Array<{ name: string; description: string; argumentHint: string }>
    }
```

**Step 2: Extend `ChatRecord`**

Add an optional `slashCommands?: SlashCommand[]` field to `ChatRecord` (line 7). Import `SlashCommand` from `../shared/types`.

**Step 3: Run typecheck**

Run: `bun run check`
Expected: PASS (new fields are additive, not referenced anywhere yet).

**Step 4: Commit**

```bash
git add src/server/events.ts
git commit -m "feat(events): add session_commands_loaded turn event"
```

---

## Task 3 — `EventStore.recordSessionCommandsLoaded`

**Files:**
- Modify: `src/server/event-store.ts` (add method next to other `recordTurn*` methods around line 765-820)

**Step 1: Locate reducer**

Use LSP `workspace-symbols` or Grep for `case "turn_started":` in `src/server/event-store.ts` to find where `TurnEvent` is applied to state during replay. Note the file and function.

**Step 2: Write failing test**

Create `src/server/event-store.test.ts` (or add to existing test file if present — check first with `ls src/server/*.test.ts`). Add:

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore } from "./event-store"

describe("EventStore.recordSessionCommandsLoaded", () => {
  let dir: string
  let store: EventStore
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kanna-es-"))
    store = new EventStore({ dataDir: dir })
    await store.load()
    await store.recordProjectOpened({ projectId: "p1", localPath: "/tmp/x", title: "x" })
    await store.recordChatCreated({ chatId: "c1", projectId: "p1", title: "chat" })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("stores latest commands on chat record", async () => {
    await store.recordSessionCommandsLoaded("c1", [
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
    ])
    expect(store.getChat("c1")?.slashCommands).toEqual([
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
    ])
  })

  test("replaces commands on subsequent load", async () => {
    await store.recordSessionCommandsLoaded("c1", [{ name: "a", description: "", argumentHint: "" }])
    await store.recordSessionCommandsLoaded("c1", [{ name: "b", description: "", argumentHint: "" }])
    expect(store.getChat("c1")?.slashCommands).toEqual([
      { name: "b", description: "", argumentHint: "" },
    ])
  })
})
```

(If existing tests use a different helper for store setup, copy that pattern instead. Check `src/server/event-store.test.ts` first.)

**Step 3: Run failing test**

Run: `bun test src/server/event-store.test.ts`
Expected: FAIL — `recordSessionCommandsLoaded is not a function`.

**Step 4: Implement**

In `src/server/event-store.ts`, add a method next to the other `recordTurn*` methods:

```ts
async recordSessionCommandsLoaded(chatId: string, commands: SlashCommand[]) {
  this.requireChat(chatId)
  const event: TurnEvent = {
    v: STORE_VERSION,
    type: "session_commands_loaded",
    timestamp: Date.now(),
    chatId,
    commands: commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
  }
  await this.append(this.turnsLogPath, event)
}
```

Add `import type { SlashCommand } from "../shared/types"` at the top if missing.

Locate the `TurnEvent` reducer (found in Step 1) and add a case:

```ts
case "session_commands_loaded": {
  const chat = state.chatsById.get(event.chatId)
  if (!chat) return
  chat.slashCommands = event.commands.map((c) => ({ ...c }))
  return
}
```

**Step 5: Run test**

Run: `bun test src/server/event-store.test.ts`
Expected: PASS (both cases).

**Step 6: Commit**

```bash
git add src/server/event-store.ts src/server/event-store.test.ts
git commit -m "feat(event-store): record session_commands_loaded events"
```

---

## Task 4 — Expose `supportedCommands` on the Claude harness

**Files:**
- Modify: `src/server/agent.ts` (`ClaudeSessionHandle` interface at line 73-82, `startClaudeSession` return around line 629-661)

**Step 1: Extend the handle interface**

In `src/server/agent.ts`, add a method to `ClaudeSessionHandle`:

```ts
getSupportedCommands: () => Promise<Array<{ name: string; description: string; argumentHint: string }>>
```

Also add it to the type alias in `AgentCoordinatorArgs.startClaudeSession` (line 103-110) so tests can inject a mock.

**Step 2: Implement in `startClaudeSession`**

In the returned object at `src/server/agent.ts:629-661`, add:

```ts
getSupportedCommands: async () => {
  try {
    return await q.supportedCommands()
  } catch (error) {
    console.warn("[kanna/claude] supportedCommands failed", error)
    return []
  }
},
```

**Step 3: Run typecheck**

Run: `bun run check`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/server/agent.ts
git commit -m "feat(agent): expose getSupportedCommands on Claude harness"
```

---

## Task 5 — Coordinator emits `session_commands_loaded` on Claude session start

**Files:**
- Modify: `src/server/agent.ts` (`ensureClaudeSession` block around line 1048-1079)

**Step 1: Write failing test**

Add or extend a coordinator test. If no suitable file exists, create `src/server/agent.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { AgentCoordinator } from "./agent"
// plus whatever the existing agent tests use for setup

test("emits session_commands_loaded after starting a fresh Claude session", async () => {
  // 1. Construct coordinator with an in-memory EventStore and a fake
  //    startClaudeSession that returns getSupportedCommands resolving to
  //    [{ name: "review", description: "Review", argumentHint: "<pr>" }].
  // 2. Trigger a send that starts a Claude session.
  // 3. Assert eventStore.getChat(chatId).slashCommands === the fake list.
})
```

(Look at existing tests in `src/server/` or `src/client/` for the EventStore fixture pattern. Mirror it.)

**Step 2: Run failing test**

Run: `bun test src/server/agent.test.ts`
Expected: FAIL — `slashCommands` empty / undefined.

**Step 3: Wire emission after session start**

In `ensureClaudeSession` at `src/server/agent.ts:1048-1079`, after `this.claudeSessions.set(args.chatId, session)` and `void this.runClaudeSession(session)`, add:

```ts
void (async () => {
  try {
    const commands = await started.getSupportedCommands()
    await this.store.recordSessionCommandsLoaded(args.chatId, commands)
    this.onStateChange?.(args.chatId)
  } catch (error) {
    console.warn("[kanna/agent] failed to load slash commands", error)
  }
})()
```

`this.store` is the `EventStore` handle the coordinator already holds; if the private field is named differently, use that.

**Step 4: Run test**

Run: `bun test src/server/agent.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/agent.ts src/server/agent.test.ts
git commit -m "feat(agent): emit session_commands_loaded on Claude session start"
```

---

## Task 6 — Surface `slashCommands` on `ChatSnapshot`

**Files:**
- Modify: `src/server/read-models.ts` (`deriveChatSnapshot` at lines 152-188)

**Step 1: Write failing test**

Add to `src/server/read-models.test.ts` (or create it):

```ts
import { describe, expect, test } from "bun:test"
import { deriveChatSnapshot } from "./read-models"
import { createEmptyState } from "./events"

test("chat snapshot exposes slashCommands from chat record", () => {
  const state = createEmptyState()
  state.projectsById.set("p1", {
    id: "p1", localPath: "/tmp/x", title: "x",
    createdAt: 0, updatedAt: 0,
  } as any)
  state.chatsById.set("c1", {
    id: "c1", projectId: "p1", title: "Chat",
    createdAt: 0, updatedAt: 0,
    unread: false, provider: "claude", planMode: false,
    sessionToken: null, sourceHash: null,
    lastTurnOutcome: null,
    slashCommands: [{ name: "review", description: "r", argumentHint: "<pr>" }],
  } as any)

  const snapshot = deriveChatSnapshot(
    state,
    new Map(),
    new Set(),
    "c1",
    () => ({
      messages: [],
      history: { hasOlder: false, olderCursor: null, recentLimit: 20 },
    }),
  )
  expect(snapshot?.slashCommands).toEqual([
    { name: "review", description: "r", argumentHint: "<pr>" },
  ])
})
```

**Step 2: Run failing test**

Run: `bun test src/server/read-models.test.ts`
Expected: FAIL — `slashCommands` is `[]` not the record's list.

**Step 3: Implement**

In `src/server/read-models.ts:178-188`, replace the returned `slashCommands: []` (added in Task 1) with:

```ts
slashCommands: (chat.slashCommands ?? []).map((c) => ({ ...c })),
```

**Step 4: Run test**

Run: `bun test src/server/read-models.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/read-models.ts src/server/read-models.test.ts
git commit -m "feat(read-models): expose slashCommands on ChatSnapshot"
```

---

## Task 7 — Snapshot file persistence

**Files:**
- Modify: `src/server/event-store.ts` — search for `writeSnapshot`/`readSnapshot` and the `SnapshotFile` shape in `src/server/events.ts`.

**Step 1: Extend `SnapshotFile`**

In `src/server/events.ts`, extend `SnapshotFile.chats` persistence — not the type if it re-uses `ChatRecord`. If `chats: ChatRecord[]` is already the field, the new `slashCommands?` field (from Task 2) flows through automatically. Verify by reading the `writeSnapshot` path.

**Step 2: Write a round-trip test**

In `src/server/event-store.test.ts`, add:

```ts
test("compaction preserves slashCommands", async () => {
  await store.recordSessionCommandsLoaded("c1", [
    { name: "review", description: "r", argumentHint: "<pr>" },
  ])
  await store.compact() // or whatever the public API is — check file
  const reloaded = new EventStore({ dataDir: dir })
  await reloaded.load()
  expect(reloaded.getChat("c1")?.slashCommands).toEqual([
    { name: "review", description: "r", argumentHint: "<pr>" },
  ])
})
```

**Step 3: Run test**

Run: `bun test src/server/event-store.test.ts`
Expected: PASS if `ChatRecord` passes through unchanged. FAIL means snapshot serialization drops the field — fix by explicitly including `slashCommands` in whatever projection `writeSnapshot` uses.

**Step 4: Commit (if changes were needed)**

```bash
git add src/server/event-store.ts src/server/events.ts src/server/event-store.test.ts
git commit -m "feat(event-store): persist slashCommands across compaction"
```

If no changes were needed, skip the commit and note that in the PR description.

---

## Task 8 — Client slash-commands store

**Files:**
- Create: `src/client/stores/slashCommandsStore.ts`
- Test: `src/client/stores/slashCommandsStore.test.ts`

**Step 1: Write failing test**

```ts
import { describe, test, expect, beforeEach } from "bun:test"
import { useSlashCommandsStore } from "./slashCommandsStore"

describe("slashCommandsStore", () => {
  beforeEach(() => useSlashCommandsStore.setState({ byChatId: {} }))

  test("setForChat stores list", () => {
    useSlashCommandsStore.getState().setForChat("c1", [
      { name: "review", description: "r", argumentHint: "<pr>" },
    ])
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toHaveLength(1)
  })

  test("clear removes list", () => {
    useSlashCommandsStore.getState().setForChat("c1", [
      { name: "review", description: "r", argumentHint: "" },
    ])
    useSlashCommandsStore.getState().clear("c1")
    expect(useSlashCommandsStore.getState().byChatId["c1"]).toBeUndefined()
  })
})
```

**Step 2: Run failing test**

Run: `bun test src/client/stores/slashCommandsStore.test.ts`
Expected: FAIL — store file does not exist.

**Step 3: Implement**

```ts
import { create } from "zustand"
import type { SlashCommand } from "../../shared/types"

interface State {
  byChatId: Record<string, SlashCommand[]>
  setForChat: (chatId: string, commands: SlashCommand[]) => void
  clear: (chatId: string) => void
}

export const useSlashCommandsStore = create<State>((set) => ({
  byChatId: {},
  setForChat: (chatId, commands) =>
    set((state) => ({ byChatId: { ...state.byChatId, [chatId]: commands } })),
  clear: (chatId) =>
    set((state) => {
      const { [chatId]: _removed, ...rest } = state.byChatId
      return { byChatId: rest }
    }),
}))
```

**Step 4: Run test**

Run: `bun test src/client/stores/slashCommandsStore.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/client/stores/slashCommandsStore.ts src/client/stores/slashCommandsStore.test.ts
git commit -m "feat(client): add slash commands store"
```

---

## Task 9 — Populate the store from the chat snapshot

**Files:**
- Modify: `src/client/app/useKannaState.ts` (subscribe handler around line 789-821)

**Step 1: Wire store update**

Inside the `socket.subscribe<ChatSnapshot | null>(...)` callback at line 789, add after `setChatReady(true)`:

```ts
if (snapshot) {
  useSlashCommandsStore.getState().setForChat(
    snapshot.runtime.chatId,
    snapshot.slashCommands ?? [],
  )
}
```

Add the import at the top:

```ts
import { useSlashCommandsStore } from "../stores/slashCommandsStore"
```

**Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/client/app/useKannaState.ts
git commit -m "feat(client): populate slash commands store from snapshot"
```

---

## Task 10 — `useSlashCommands` hook

**Files:**
- Create: `src/client/hooks/useSlashCommands.ts`
- Test: `src/client/hooks/useSlashCommands.test.ts`

**Step 1: Write failing test**

```ts
import { describe, test, expect } from "bun:test"
import { renderHook, act } from "@testing-library/react"
import { useSlashCommands } from "./useSlashCommands"
import { useSlashCommandsStore } from "../stores/slashCommandsStore"

test("returns commands for chat", () => {
  act(() => useSlashCommandsStore.getState().setForChat("c1", [
    { name: "review", description: "r", argumentHint: "" },
  ]))
  const { result } = renderHook(() => useSlashCommands("c1"))
  expect(result.current).toHaveLength(1)
})

test("returns empty array for unknown chat", () => {
  const { result } = renderHook(() => useSlashCommands("unknown"))
  expect(result.current).toEqual([])
})
```

(If `@testing-library/react` is not already a dep, test without the renderer: call `useSlashCommandsStore.getState()` directly through a small selector export and omit this test file — replace with a selector unit test.)

**Step 2: Implement**

```ts
import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import type { SlashCommand } from "../../shared/types"

const EMPTY: SlashCommand[] = []

export function useSlashCommands(chatId: string | null): SlashCommand[] {
  return useSlashCommandsStore((state) =>
    chatId ? state.byChatId[chatId] ?? EMPTY : EMPTY,
  )
}
```

**Step 3: Run test**

Run: `bun test src/client/hooks/useSlashCommands.test.ts`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/client/hooks/useSlashCommands.ts src/client/hooks/useSlashCommands.test.ts
git commit -m "feat(client): add useSlashCommands hook"
```

---

## Task 11 — Pure filter / trigger utils

**Files:**
- Create: `src/client/lib/slash-commands.ts`
- Test: `src/client/lib/slash-commands.test.ts`

**Step 1: Write failing tests**

```ts
import { describe, test, expect } from "bun:test"
import { shouldShowPicker, filterCommands } from "./slash-commands"

describe("shouldShowPicker", () => {
  test("opens when value starts with / and caret inside token", () => {
    expect(shouldShowPicker("/rev", 4)).toEqual({ open: true, query: "rev" })
  })
  test("opens on bare slash", () => {
    expect(shouldShowPicker("/", 1)).toEqual({ open: true, query: "" })
  })
  test("closes after space", () => {
    expect(shouldShowPicker("/review ", 8)).toEqual({ open: false, query: "" })
  })
  test("closes when caret before slash", () => {
    expect(shouldShowPicker("/rev", 0)).toEqual({ open: false, query: "" })
  })
  test("closes when first char not slash", () => {
    expect(shouldShowPicker("hi /rev", 7)).toEqual({ open: false, query: "" })
  })
})

describe("filterCommands", () => {
  const all = [
    { name: "review", description: "r", argumentHint: "" },
    { name: "reset", description: "s", argumentHint: "" },
    { name: "init", description: "i", argumentHint: "" },
  ]
  test("empty query returns all, alphabetical", () => {
    expect(filterCommands(all, "").map((c) => c.name)).toEqual(["init", "reset", "review"])
  })
  test("prefix matches rank before substring", () => {
    const list = [
      { name: "unreview", description: "", argumentHint: "" },
      { name: "review", description: "", argumentHint: "" },
    ]
    expect(filterCommands(list, "rev").map((c) => c.name)).toEqual(["review", "unreview"])
  })
  test("case-insensitive", () => {
    expect(filterCommands(all, "REV").map((c) => c.name)).toEqual(["review"])
  })
})
```

**Step 2: Run failing tests**

Run: `bun test src/client/lib/slash-commands.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import type { SlashCommand } from "../../shared/types"

export function shouldShowPicker(
  value: string,
  caret: number,
): { open: boolean; query: string } {
  if (caret <= 0) return { open: false, query: "" }
  const upToCaret = value.slice(0, caret)
  const match = /^\/(\S*)$/.exec(upToCaret)
  if (!match) return { open: false, query: "" }
  return { open: true, query: match[1] ?? "" }
}

export function filterCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name)
  if (q === "") return [...list].sort(byName)

  const prefix: SlashCommand[] = []
  const substring: SlashCommand[] = []
  for (const cmd of list) {
    const name = cmd.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(cmd)
    else if (name.includes(q)) substring.push(cmd)
  }
  return [...prefix.sort(byName), ...substring.sort(byName)]
}
```

**Step 4: Run tests**

Run: `bun test src/client/lib/slash-commands.test.ts`
Expected: PASS (all cases).

**Step 5: Commit**

```bash
git add src/client/lib/slash-commands.ts src/client/lib/slash-commands.test.ts
git commit -m "feat(client): add slash command filter and picker-open utils"
```

---

## Task 12 — `SlashCommandPicker` component

**Files:**
- Create: `src/client/components/chat-ui/SlashCommandPicker.tsx`
- Test: `src/client/components/chat-ui/SlashCommandPicker.test.tsx` (only if existing chat-ui tests use `.tsx` React testing; otherwise defer to Task 13's integration tests)

**Step 1: Implement the component**

```tsx
import { useEffect, useRef } from "react"
import type { SlashCommand } from "../../../shared/types"
import { cn } from "../../lib/utils"

interface Props {
  items: SlashCommand[]
  activeIndex: number
  onSelect: (command: SlashCommand) => void
  onHoverIndex: (index: number) => void
}

export function SlashCommandPicker({ items, activeIndex, onSelect, onHoverIndex }: Props) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const el = listRef.current?.children.item(activeIndex) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-full max-w-md rounded-md border border-border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        No matching commands
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      className="absolute bottom-full left-0 mb-2 w-full max-w-md max-h-64 overflow-auto rounded-md border border-border bg-popover shadow-md"
    >
      {items.map((cmd, i) => (
        <li
          key={cmd.name}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(cmd)
          }}
          onMouseEnter={() => onHoverIndex(i)}
          className={cn(
            "flex items-baseline gap-2 px-3 py-1.5 cursor-pointer text-sm",
            i === activeIndex && "bg-accent text-accent-foreground",
          )}
        >
          <span className="font-mono">/{cmd.name}</span>
          {cmd.argumentHint && (
            <span className="text-muted-foreground font-mono text-xs">{cmd.argumentHint}</span>
          )}
          {cmd.description && (
            <span className="ml-auto text-muted-foreground text-xs truncate">{cmd.description}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
```

**Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/client/components/chat-ui/SlashCommandPicker.tsx
git commit -m "feat(client): add SlashCommandPicker component"
```

---

## Task 13 — Wire picker into `ChatInput`

**Files:**
- Modify: `src/client/components/chat-ui/ChatInput.tsx` (keyboard handler at 555-586, render area around 725)
- Test: extend `src/client/components/chat-ui/ChatInput.test.ts`

**Step 1: Write failing tests**

Extend `ChatInput.test.ts`:

```ts
// pseudocode — mirror the existing test style in that file
test("typing / opens picker with full list", () => {
  // render ChatInput with chatId="c1" and preload slash-commands store
  // fire change to "/" and assert picker rows rendered
})

test("typing /rev filters", () => {
  // preload list with review, init; type "/rev"; assert only review shown
})

test("Enter accepts highlighted command", () => {
  // preload list, type "/", press Enter → input becomes "/review "
  // (trailing space since argumentHint is non-empty)
})

test("Escape closes picker without clearing input", () => {
  // preload list, type "/rev", press Escape → picker gone, value still "/rev"
})

test("picker does not intercept Enter when closed", () => {
  // type "hi", press Enter → onSubmit called
})
```

Use whatever render helper the existing tests in this file use. If the file is vanilla DOM assertions without React rendering, mirror that approach instead.

**Step 2: Run failing tests**

Run: `bun test src/client/components/chat-ui/ChatInput.test.ts`
Expected: FAIL.

**Step 3: Hook state into `ChatInput`**

At the top of the `ChatInput` component body, add:

```tsx
const slashCommands = useSlashCommands(chatId ?? null)
const [pickerIndex, setPickerIndex] = useState(0)
const textareaRef = useRef<HTMLTextAreaElement>(null) // reuse existing
const caret = textareaRef.current?.selectionStart ?? value.length

const pickerState = useMemo(
  () => shouldShowPicker(value, caret),
  [value, caret],
)
const filteredCommands = useMemo(
  () => (pickerState.open ? filterCommands(slashCommands, pickerState.query) : []),
  [pickerState.open, pickerState.query, slashCommands],
)
const pickerOpen = pickerState.open && slashCommands.length > 0

useEffect(() => {
  if (pickerOpen) setPickerIndex(0)
}, [pickerOpen, pickerState.query])
```

Imports:

```tsx
import { useSlashCommands } from "../../hooks/useSlashCommands"
import { SlashCommandPicker } from "./SlashCommandPicker"
import { filterCommands, shouldShowPicker } from "../../lib/slash-commands"
```

**Step 4: Intercept keyboard in `handleKeyDown`**

Place at the very top of `handleKeyDown` (before the existing `Tab` handling):

```tsx
if (pickerOpen) {
  if (event.key === "Escape") {
    event.preventDefault()
    // close by forcing caret past the token — simpler: clear filtered list via a local `dismissed` flag.
    // Use a ref-based suppress: setPickerDismissed(true) until value changes.
    setPickerDismissed(true)
    return
  }
  if (event.key === "ArrowDown") {
    event.preventDefault()
    setPickerIndex((i) => Math.min(filteredCommands.length - 1, i + 1))
    return
  }
  if (event.key === "ArrowUp") {
    event.preventDefault()
    setPickerIndex((i) => Math.max(0, i - 1))
    return
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault()
    const cmd = filteredCommands[pickerIndex]
    if (cmd) acceptCommand(cmd)
    return
  }
}
```

Add supporting state + effect + accept helper above `handleKeyDown`:

```tsx
const [pickerDismissed, setPickerDismissed] = useState(false)
useEffect(() => { setPickerDismissed(false) }, [value])

function acceptCommand(cmd: SlashCommand) {
  const prefix = `/${cmd.name}`
  const next = cmd.argumentHint ? `${prefix} ` : prefix
  setValue(next)
  if (chatId) setDraft(chatId, next)
  requestAnimationFrame(() => {
    textareaRef.current?.focus()
    textareaRef.current?.setSelectionRange(next.length, next.length)
  })
}
```

Update `pickerOpen` to also respect `pickerDismissed`:

```tsx
const pickerOpen = pickerState.open && slashCommands.length > 0 && !pickerDismissed
```

**Step 5: Render the picker**

Near the textarea container (find the existing wrapper around line 725 where the textarea is rendered; it already has `onKeyDown={handleKeyDown}`), wrap it in a relative-positioned container if not already, and render:

```tsx
{pickerOpen && (
  <SlashCommandPicker
    items={filteredCommands}
    activeIndex={pickerIndex}
    onSelect={acceptCommand}
    onHoverIndex={setPickerIndex}
  />
)}
```

Place it as a sibling of the textarea inside the relative wrapper so it floats above with `absolute bottom-full`.

**Step 6: Run tests**

Run: `bun test src/client/components/chat-ui/ChatInput.test.ts`
Expected: PASS.

**Step 7: Typecheck + build**

Run: `bun run check`
Expected: PASS.

**Step 8: Commit**

```bash
git add src/client/components/chat-ui/ChatInput.tsx src/client/components/chat-ui/ChatInput.test.ts
git commit -m "feat(chat-ui): wire slash command picker into ChatInput"
```

---

## Task 14 — Manual verification

**Step 1: Start dev server**

```bash
bun run dev
```

**Step 2: Verify in browser**

- Open a Claude chat, wait for session start.
- Type `/` in the input — picker appears with the session's commands.
- Type `rev` — filters to `/review` (or whichever commands have `rev`).
- `↓ ↑` navigate, `Enter` inserts `/review ` (with trailing space since `argumentHint` exists).
- Press `Enter` with no picker open on non-slash input — sends normally.
- `Esc` while picker open — picker closes, input preserved.
- Switch to a Codex chat — typing `/` does not open a picker.

**Step 3: Stop dev server**

`Ctrl+C`.

**Step 4: If any step fails**

Open a debugging session with `superpowers:systematic-debugging`. Do not skip.

---

## Task 15 — Refetch on resume

**Files:**
- Modify: `src/server/agent.ts` — wherever a resumed session becomes active after `sessionToken` is set.

**Step 1: Locate the resume flow**

Grep for `sessionToken` usage in `startClaudeSession` and the coordinator. Resume happens when `query({ resume: sessionToken })` is used.

**Step 2: Emit a fresh load**

Wherever the coordinator transitions from "starting" → "ready" for a resumed session (where the old `supportedCommands()` result may be stale), call `getSupportedCommands()` again and `recordSessionCommandsLoaded`.

If the existing eager emission in Task 5 is already *after* session construction for both new and resumed sessions, this task is a no-op — verify by reading the code path and note it in the commit message.

**Step 3: Commit (if changes were needed)**

```bash
git add src/server/agent.ts
git commit -m "feat(agent): refetch supported commands on session resume"
```

---

## Task 16 — Final verification + PR prep

**Step 1: Full check**

```bash
bun run check
bun test
```

Both: PASS.

**Step 2: Commit any incidental formatting**

Only if files changed (e.g. Prettier on save). Otherwise skip.

**Step 3: Report completion**

Announce: worktree at `.worktrees/slash-command-picker`, branch `feature/slash-command-picker`, all tasks complete, tests green. Offer to run `superpowers:finishing-a-development-branch` for merge / PR path.

---

## Skills to consult

- `superpowers:test-driven-development` — always for every task that touches logic.
- `superpowers:systematic-debugging` — if anything misbehaves in manual verification.
- `superpowers:verification-before-completion` — before announcing Task 16 done.
- `superpowers:finishing-a-development-branch` — after Task 16.
