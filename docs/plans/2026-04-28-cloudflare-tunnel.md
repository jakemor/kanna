# Cloudflare Tunnel Auto-Expose Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When Claude Code starts a local dev server inside a Kanna-managed project, detect the listening port from Bash output via a haiku agent, prompt the user with an inline transcript card, and expose it via a Cloudflare quick tunnel.

**Architecture:** New `src/server/cloudflare-tunnel/` module mirrors the `auto-continue/` event-sourced layout. A haiku-backed detector evaluates every Bash tool result; on hits it emits `tunnel_proposed` events. A tunnel manager spawns `cloudflared tunnel --url http://localhost:PORT` and parses `*.trycloudflare.com` URLs. A `CloudflareTunnelCard.tsx` mirrors `AutoContinueCard.tsx` for inline transcript UX. Settings live in `app-settings.ts` (opt-in; `enabled: false` default).

**Tech Stack:** Bun + TypeScript, React, Zustand stores, `@anthropic-ai/claude-agent-sdk` (haiku for detection), `cloudflared` CLI (assumed installed), bun:test (colocated `.test.ts`).

**Design reference:** `docs/plans/2026-04-28-cloudflare-tunnel-design.md`

**Working directory:** `/Users/cuongtran/Desktop/repo/kanna/.worktrees/cloudflare-tunnel` on branch `feature/cloudflare-tunnel`.

**Conventions to respect:**
- Strong typing — no `any`, no `unknown` without narrowing. Discriminated unions for events.
- Colocated tests — `*.test.ts` next to source.
- WS push pattern — read-model snapshot delta over WS, not pull.
- TDD — failing test first, minimal impl, pass, commit each task.
- Frequent commits — one task = one commit (sometimes multi-step within a task).

---

## Task 1: Shared types for tunnel state and settings

**Files:**
- Modify: `src/shared/types.ts`

**Step 1: Add settings + tunnel types**

Append to `src/shared/types.ts`:

```ts
export type CloudflareTunnelMode = "always-ask" | "auto-expose"

export interface CloudflareTunnelSettings {
  enabled: boolean
  cloudflaredPath: string
  mode: CloudflareTunnelMode
}

export const CLOUDFLARE_TUNNEL_DEFAULTS: CloudflareTunnelSettings = {
  enabled: false,
  cloudflaredPath: "cloudflared",
  mode: "always-ask",
}

export type CloudflareTunnelState = "proposed" | "active" | "stopped" | "failed"

export interface CloudflareTunnelRecord {
  tunnelId: string
  chatId: string
  port: number
  state: CloudflareTunnelState
  url: string | null
  error: string | null
  proposedAt: number
  activatedAt: number | null
  stoppedAt: number | null
}
```

Also extend `AppSettingsSnapshot` (find existing block around `interface AppSettingsSnapshot`) by adding:

```ts
cloudflareTunnel: CloudflareTunnelSettings
```

**Step 2: Run typecheck**

Run: `bun run check`
Expected: FAIL — downstream consumers break since `cloudflareTunnel` field missing in existing producers.

**Step 3: Commit (red-light snapshot)**

```bash
git add src/shared/types.ts
git commit -m "feat(tunnel): add shared types for cloudflare tunnel state + settings"
```

---

## Task 2: Server settings normalization + persistence

**Files:**
- Modify: `src/server/app-settings.ts`
- Test: `src/server/app-settings.test.ts`

**Step 1: Write failing tests**

Append to `src/server/app-settings.test.ts`:

```ts
test("normalizes missing cloudflareTunnel block to defaults", async () => {
  const filePath = await writeSettingsFile({ analyticsEnabled: true })
  const snapshot = await readAppSettingsSnapshot(filePath)
  expect(snapshot.cloudflareTunnel).toEqual({
    enabled: false,
    cloudflaredPath: "cloudflared",
    mode: "always-ask",
  })
})

test("preserves valid cloudflareTunnel settings", async () => {
  const filePath = await writeSettingsFile({
    cloudflareTunnel: { enabled: true, cloudflaredPath: "/usr/local/bin/cloudflared", mode: "auto-expose" },
  })
  const snapshot = await readAppSettingsSnapshot(filePath)
  expect(snapshot.cloudflareTunnel).toEqual({
    enabled: true,
    cloudflaredPath: "/usr/local/bin/cloudflared",
    mode: "auto-expose",
  })
})

test("rejects invalid mode and resets to default with warning", async () => {
  const filePath = await writeSettingsFile({
    cloudflareTunnel: { enabled: true, cloudflaredPath: "cloudflared", mode: "garbage" },
  })
  const snapshot = await readAppSettingsSnapshot(filePath)
  expect(snapshot.cloudflareTunnel.mode).toBe("always-ask")
  expect(snapshot.warning).toContain("cloudflareTunnel.mode")
})
```

(If `writeSettingsFile` helper not present, use existing pattern in the test file — read the file first.)

**Step 2: Run tests, verify fail**

Run: `bun test src/server/app-settings.test.ts -t cloudflareTunnel`
Expected: FAIL — `cloudflareTunnel` undefined on snapshot.

**Step 3: Implement normalization**

In `src/server/app-settings.ts`:
- Extend `AppSettingsFile` interface with `cloudflareTunnel?: unknown`.
- Extend `AppSettingsState` with `cloudflareTunnel: CloudflareTunnelSettings`.
- In `normalizeAppSettings`, parse the field, falling back to `CLOUDFLARE_TUNNEL_DEFAULTS`. Push warnings for malformed values.
- In `toSnapshot`, include `cloudflareTunnel`.
- In `AppSettingsManager.update` (or its setter equivalent), accept `Partial<CloudflareTunnelSettings>` patches.

Add a setter method:

```ts
async setCloudflareTunnel(patch: Partial<CloudflareTunnelSettings>) {
  const next: CloudflareTunnelSettings = { ...this.state.cloudflareTunnel, ...patch }
  // validate mode
  if (next.mode !== "always-ask" && next.mode !== "auto-expose") {
    throw new Error("Invalid cloudflareTunnel.mode")
  }
  // ... write file, emit listeners
}
```

**Step 4: Run tests, verify pass**

Run: `bun test src/server/app-settings.test.ts`
Expected: PASS — all existing + new cloudflareTunnel tests green.

**Step 5: Commit**

```bash
git add src/server/app-settings.ts src/server/app-settings.test.ts
git commit -m "feat(tunnel): persist cloudflare tunnel settings with normalization"
```

---

## Task 3: Tunnel events module

**Files:**
- Create: `src/server/cloudflare-tunnel/events.ts`
- Create: `src/server/cloudflare-tunnel/events.test.ts`

**Step 1: Write failing test**

`src/server/cloudflare-tunnel/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION, type CloudflareTunnelEvent } from "./events"

describe("cloudflare tunnel events", () => {
  test("event version is 1", () => {
    expect(CLOUDFLARE_TUNNEL_EVENT_VERSION).toBe(1)
  })

  test("discriminated union allows all five kinds", () => {
    const kinds: CloudflareTunnelEvent["kind"][] = [
      "tunnel_proposed",
      "tunnel_accepted",
      "tunnel_active",
      "tunnel_stopped",
      "tunnel_failed",
    ]
    expect(kinds).toHaveLength(5)
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/events.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Implement events**

`src/server/cloudflare-tunnel/events.ts`:

```ts
export const CLOUDFLARE_TUNNEL_EVENT_VERSION = 1 as const

interface BaseTunnelEvent {
  v: typeof CLOUDFLARE_TUNNEL_EVENT_VERSION
  timestamp: number
  chatId: string
  tunnelId: string
}

export type CloudflareTunnelEvent =
  | (BaseTunnelEvent & {
      kind: "tunnel_proposed"
      port: number
      sourcePid: number | null
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_accepted"
      source: "user" | "auto_setting"
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_active"
      url: string
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_stopped"
      reason: "user" | "source_exited" | "session_closed" | "server_shutdown"
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_failed"
      error: string
    })
```

**Step 4: Run test, verify pass**

Run: `bun test src/server/cloudflare-tunnel/events.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/cloudflare-tunnel/events.ts src/server/cloudflare-tunnel/events.test.ts
git commit -m "feat(tunnel): event types for cloudflare tunnel state machine"
```

---

## Task 4: Tunnel read-model projection

**Files:**
- Create: `src/server/cloudflare-tunnel/read-model.ts`
- Create: `src/server/cloudflare-tunnel/read-model.test.ts`

**Step 1: Write failing tests**

`src/server/cloudflare-tunnel/read-model.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { deriveChatTunnels } from "./read-model"
import type { CloudflareTunnelEvent } from "./events"

const base = { v: 1 as const, chatId: "c1", tunnelId: "t1" }

describe("deriveChatTunnels", () => {
  test("empty events → empty projection", () => {
    expect(deriveChatTunnels([], "c1")).toEqual({ tunnels: {}, liveTunnelId: null })
  })

  test("proposed → active → stopped flow", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: 123 },
      { ...base, kind: "tunnel_accepted", timestamp: 2, source: "user" },
      { ...base, kind: "tunnel_active", timestamp: 3, url: "https://abc.trycloudflare.com" },
      { ...base, kind: "tunnel_stopped", timestamp: 4, reason: "user" },
    ]
    const proj = deriveChatTunnels(events, "c1")
    expect(proj.tunnels.t1.state).toBe("stopped")
    expect(proj.tunnels.t1.url).toBe("https://abc.trycloudflare.com")
    expect(proj.liveTunnelId).toBeNull()
  })

  test("liveTunnelId tracks proposed/active", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
    ]
    expect(deriveChatTunnels(events, "c1").liveTunnelId).toBe("t1")
  })

  test("failed state preserves error", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
      { ...base, kind: "tunnel_failed", timestamp: 2, error: "cloudflared not found" },
    ]
    const proj = deriveChatTunnels(events, "c1")
    expect(proj.tunnels.t1.state).toBe("failed")
    expect(proj.tunnels.t1.error).toBe("cloudflared not found")
  })

  test("filters by chatId", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, chatId: "c2", kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
    ]
    expect(deriveChatTunnels(events, "c1")).toEqual({ tunnels: {}, liveTunnelId: null })
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/read-model.test.ts`
Expected: FAIL — `deriveChatTunnels` not exported.

**Step 3: Implement read-model**

`src/server/cloudflare-tunnel/read-model.ts`:

```ts
import type { CloudflareTunnelRecord } from "../../shared/types"
import type { CloudflareTunnelEvent } from "./events"

export interface ChatTunnelsProjection {
  tunnels: Record<string, CloudflareTunnelRecord>
  liveTunnelId: string | null
}

const EMPTY: ChatTunnelsProjection = { tunnels: {}, liveTunnelId: null }

export function deriveChatTunnels(
  events: readonly CloudflareTunnelEvent[],
  chatId?: string,
): ChatTunnelsProjection {
  const tunnels: Record<string, CloudflareTunnelRecord> = {}
  let liveTunnelId: string | null = null

  for (const event of events) {
    if (chatId && event.chatId !== chatId) continue
    applyOne(tunnels, event)
    const record = tunnels[event.tunnelId]
    if (record && (record.state === "proposed" || record.state === "active")) {
      liveTunnelId = record.tunnelId
    } else if (liveTunnelId === event.tunnelId) {
      liveTunnelId = null
    }
  }

  if (Object.keys(tunnels).length === 0 && liveTunnelId === null) return EMPTY
  return { tunnels, liveTunnelId }
}

function applyOne(tunnels: Record<string, CloudflareTunnelRecord>, event: CloudflareTunnelEvent): void {
  switch (event.kind) {
    case "tunnel_proposed":
      tunnels[event.tunnelId] = {
        tunnelId: event.tunnelId,
        chatId: event.chatId,
        port: event.port,
        state: "proposed",
        url: null,
        error: null,
        proposedAt: event.timestamp,
        activatedAt: null,
        stoppedAt: null,
      }
      return
    case "tunnel_accepted": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      // accepted is a transitional event; keep state proposed until tunnel_active arrives
      tunnels[event.tunnelId] = { ...existing }
      return
    }
    case "tunnel_active": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = {
        ...existing,
        state: "active",
        url: event.url,
        activatedAt: event.timestamp,
      }
      return
    }
    case "tunnel_stopped": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = { ...existing, state: "stopped", stoppedAt: event.timestamp }
      return
    }
    case "tunnel_failed": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = { ...existing, state: "failed", error: event.error }
      return
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return
    }
  }
}
```

**Step 4: Run test, verify pass**

Run: `bun test src/server/cloudflare-tunnel/read-model.test.ts`
Expected: PASS — all 5 tests green.

**Step 5: Commit**

```bash
git add src/server/cloudflare-tunnel/read-model.ts src/server/cloudflare-tunnel/read-model.test.ts
git commit -m "feat(tunnel): event-sourced read-model projection"
```

---

## Task 5: Haiku-backed port detector

**Files:**
- Create: `src/server/cloudflare-tunnel/detector.ts`
- Create: `src/server/cloudflare-tunnel/detector.test.ts`

**Step 1: Write failing tests with stubbed haiku client**

`src/server/cloudflare-tunnel/detector.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { evaluateBashOutput, type HaikuClient } from "./detector"

const stub = (response: string): HaikuClient => ({
  classify: async () => response,
})

describe("evaluateBashOutput", () => {
  test("returns server hit when haiku reports JSON {isServer: true, port: 5173}", async () => {
    const client = stub('{"isServer": true, "port": 5173}')
    const result = await evaluateBashOutput({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173",
      client,
    })
    expect(result).toEqual({ isServer: true, port: 5173 })
  })

  test("returns no-server when haiku reports false", async () => {
    const client = stub('{"isServer": false}')
    const result = await evaluateBashOutput({ command: "ls", stdout: "a b c", client })
    expect(result).toEqual({ isServer: false })
  })

  test("returns no-server on malformed JSON", async () => {
    const client = stub("not json at all")
    const result = await evaluateBashOutput({ command: "bun run dev", stdout: "...", client })
    expect(result).toEqual({ isServer: false })
  })

  test("returns no-server when haiku throws", async () => {
    const client: HaikuClient = { classify: async () => { throw new Error("rate limit") } }
    const result = await evaluateBashOutput({ command: "x", stdout: "y", client })
    expect(result).toEqual({ isServer: false })
  })

  test("rejects ports outside 1-65535", async () => {
    const client = stub('{"isServer": true, "port": 99999}')
    const result = await evaluateBashOutput({ command: "x", stdout: "y", client })
    expect(result).toEqual({ isServer: false })
  })

  test("trims stdout to last 2KB before sending to haiku", async () => {
    let capturedLen = 0
    const client: HaikuClient = {
      classify: async (prompt) => { capturedLen = prompt.length; return '{"isServer": false}' },
    }
    await evaluateBashOutput({ command: "x", stdout: "a".repeat(10_000), client })
    expect(capturedLen).toBeLessThanOrEqual(4096)
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/detector.test.ts`
Expected: FAIL — module missing.

**Step 3: Implement detector**

`src/server/cloudflare-tunnel/detector.ts`:

```ts
export interface HaikuClient {
  classify(prompt: string): Promise<string>
}

export interface DetectorInput {
  command: string
  stdout: string
  client: HaikuClient
}

export type DetectorResult =
  | { isServer: true; port: number }
  | { isServer: false }

const STDOUT_TAIL_LIMIT = 2048
const MAX_PROMPT_LEN = 4096

const SYSTEM = "Given a shell command and its stdout, return ONLY a JSON object: {\"isServer\": boolean, \"port\"?: number}. isServer is true ONLY if the command started a long-running HTTP/TCP service that is now listening. port is the listening port (1-65535)."

export async function evaluateBashOutput(input: DetectorInput): Promise<DetectorResult> {
  const tail = input.stdout.slice(-STDOUT_TAIL_LIMIT)
  const prompt = `${SYSTEM}\n\nCommand: ${input.command}\n\nStdout:\n${tail}`.slice(0, MAX_PROMPT_LEN)

  let raw: string
  try {
    raw = await input.client.classify(prompt)
  } catch {
    return { isServer: false }
  }

  const parsed = parseClassification(raw)
  return parsed
}

function parseClassification(raw: string): DetectorResult {
  try {
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== "object") return { isServer: false }
    const record = obj as Record<string, unknown>
    if (record.isServer !== true) return { isServer: false }
    const port = record.port
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { isServer: false }
    }
    return { isServer: true, port }
  } catch {
    return { isServer: false }
  }
}
```

Also create `src/server/cloudflare-tunnel/haiku-client.ts` (production wrapper around `@anthropic-ai/claude-agent-sdk` — *do not* add tests for this; covered in e2e):

```ts
import Anthropic from "@anthropic-ai/sdk"
import type { HaikuClient } from "./detector"

export function createHaikuClient(apiKey: string): HaikuClient {
  const client = new Anthropic({ apiKey })
  return {
    async classify(prompt: string) {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 64,
        messages: [{ role: "user", content: prompt }],
      })
      const block = response.content.find((b) => b.type === "text")
      return block && block.type === "text" ? block.text : ""
    },
  }
}
```

(Confirm `@anthropic-ai/sdk` is in `package.json`. If `@anthropic-ai/claude-agent-sdk` is the actual dep, adapt the import accordingly — check `package.json` first.)

**Step 4: Run test, verify pass**

Run: `bun test src/server/cloudflare-tunnel/detector.test.ts`
Expected: PASS — 6 tests green.

**Step 5: Commit**

```bash
git add src/server/cloudflare-tunnel/detector.ts src/server/cloudflare-tunnel/detector.test.ts src/server/cloudflare-tunnel/haiku-client.ts
git commit -m "feat(tunnel): haiku-backed bash output classifier"
```

---

## Task 6: Tunnel manager (spawn cloudflared, parse URL, port reuse)

**Files:**
- Create: `src/server/cloudflare-tunnel/tunnel-manager.ts`
- Create: `src/server/cloudflare-tunnel/tunnel-manager.test.ts`

**Step 1: Write failing tests with spawn injection**

`src/server/cloudflare-tunnel/tunnel-manager.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { TunnelManager, type SpawnFn, type ChildHandle } from "./tunnel-manager"

interface FakeChild extends ChildHandle {
  emitStdout: (chunk: string) => void
  emitExit: (code: number) => void
}

function fakeChild(): FakeChild {
  const stdoutListeners: Array<(c: string) => void> = []
  const exitListeners: Array<(c: number) => void> = []
  let killed = false
  return {
    pid: 9999,
    kill: () => { killed = true; for (const l of exitListeners) l(0) },
    onStdout: (l) => stdoutListeners.push(l),
    onStderr: () => {},
    onExit: (l) => exitListeners.push(l),
    isKilled: () => killed,
    emitStdout: (chunk) => { for (const l of stdoutListeners) l(chunk) },
    emitExit: (code) => { for (const l of exitListeners) l(code) },
  }
}

describe("TunnelManager", () => {
  test("spawns cloudflared with --url and parses tunnel URL from stdout", async () => {
    const child = fakeChild()
    const spawn: SpawnFn = mock(() => child)
    const events: any[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e) => events.push(e),
    })

    const tunnelId = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })

    expect(spawn).toHaveBeenCalledWith("cloudflared", ["tunnel", "--url", "http://localhost:5173"])
    child.emitStdout("INF Your quick Tunnel has been created! Visit https://abc-def.trycloudflare.com\n")
    await new Promise((r) => setTimeout(r, 0))

    expect(events.find((e) => e.kind === "tunnel_active")).toMatchObject({
      tunnelId,
      url: "https://abc-def.trycloudflare.com",
    })
  })

  test("reuses existing tunnel when same port requested twice", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const mgr = new TunnelManager({ spawn, cloudflaredPath: "cloudflared", onEvent: () => {} })

    const a = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    const b = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    expect(a).toBe(b)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test("emits tunnel_failed when spawn throws ENOENT", async () => {
    const spawn: SpawnFn = () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e }
    const events: any[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e) => events.push(e),
    })
    await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    const failed = events.find((e) => e.kind === "tunnel_failed")
    expect(failed.error).toContain("cloudflared")
  })

  test("stop() kills child and emits tunnel_stopped reason=user", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const events: any[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e) => events.push(e),
    })

    const id = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    await mgr.stop(id, "user")

    expect(events.find((e) => e.kind === "tunnel_stopped")?.reason).toBe("user")
  })

  test("emits tunnel_failed when child exits non-zero before URL parsed", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const events: any[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e) => events.push(e),
    })
    await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    child.emitExit(1)
    expect(events.some((e) => e.kind === "tunnel_failed")).toBe(true)
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/tunnel-manager.test.ts`
Expected: FAIL — module missing.

**Step 3: Implement tunnel-manager**

`src/server/cloudflare-tunnel/tunnel-manager.ts`:

```ts
import { randomUUID } from "node:crypto"
import { spawn as nodeSpawn } from "node:child_process"
import type { CloudflareTunnelEvent } from "./events"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION } from "./events"

export interface ChildHandle {
  pid: number
  kill: () => void
  onStdout: (listener: (chunk: string) => void) => void
  onStderr: (listener: (chunk: string) => void) => void
  onExit: (listener: (code: number) => void) => void
  isKilled: () => boolean
}

export type SpawnFn = (cmd: string, args: string[]) => ChildHandle

export interface TunnelManagerArgs {
  spawn?: SpawnFn
  cloudflaredPath: string
  onEvent: (event: CloudflareTunnelEvent) => void
  now?: () => number
}

interface TunnelRecord {
  tunnelId: string
  chatId: string
  port: number
  sourcePid: number | null
  child: ChildHandle
  state: "starting" | "active" | "stopped" | "failed"
}

const TRYCF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export class TunnelManager {
  private readonly spawn: SpawnFn
  private readonly cloudflaredPath: string
  private readonly onEvent: (event: CloudflareTunnelEvent) => void
  private readonly now: () => number
  private readonly byPort = new Map<number, string>()
  private readonly byTunnel = new Map<string, TunnelRecord>()

  constructor(args: TunnelManagerArgs) {
    this.spawn = args.spawn ?? defaultSpawn
    this.cloudflaredPath = args.cloudflaredPath
    this.onEvent = args.onEvent
    this.now = args.now ?? (() => Date.now())
  }

  async start(input: { chatId: string; port: number; sourcePid: number | null }): Promise<string> {
    const existing = this.byPort.get(input.port)
    if (existing) return existing

    const tunnelId = randomUUID()
    let child: ChildHandle
    try {
      child = this.spawn(this.cloudflaredPath, ["tunnel", "--url", `http://localhost:${input.port}`])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_failed",
        timestamp: this.now(),
        chatId: input.chatId,
        tunnelId,
        error: `cloudflared failed to start: ${message}`,
      })
      return tunnelId
    }

    const record: TunnelRecord = {
      tunnelId,
      chatId: input.chatId,
      port: input.port,
      sourcePid: input.sourcePid,
      child,
      state: "starting",
    }
    this.byPort.set(input.port, tunnelId)
    this.byTunnel.set(tunnelId, record)

    child.onStdout((chunk) => this.handleStdout(record, chunk))
    child.onStderr((chunk) => this.handleStdout(record, chunk))
    child.onExit((code) => this.handleExit(record, code))

    return tunnelId
  }

  async stop(tunnelId: string, reason: "user" | "source_exited" | "session_closed" | "server_shutdown"): Promise<void> {
    const record = this.byTunnel.get(tunnelId)
    if (!record) return
    if (record.state === "stopped" || record.state === "failed") return
    record.state = "stopped"
    record.child.kill()
    this.byPort.delete(record.port)
    this.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_stopped",
      timestamp: this.now(),
      chatId: record.chatId,
      tunnelId,
      reason,
    })
  }

  shutdown() {
    for (const id of [...this.byTunnel.keys()]) {
      void this.stop(id, "server_shutdown")
    }
  }

  private handleStdout(record: TunnelRecord, chunk: string) {
    if (record.state !== "starting") return
    const match = TRYCF_URL_RE.exec(chunk)
    if (!match) return
    record.state = "active"
    this.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_active",
      timestamp: this.now(),
      chatId: record.chatId,
      tunnelId: record.tunnelId,
      url: match[0],
    })
  }

  private handleExit(record: TunnelRecord, code: number) {
    this.byPort.delete(record.port)
    if (record.state === "starting") {
      record.state = "failed"
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_failed",
        timestamp: this.now(),
        chatId: record.chatId,
        tunnelId: record.tunnelId,
        error: `cloudflared exited (code ${code}) before tunnel URL appeared`,
      })
      return
    }
    if (record.state === "active") {
      record.state = "stopped"
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_stopped",
        timestamp: this.now(),
        chatId: record.chatId,
        tunnelId: record.tunnelId,
        reason: "source_exited",
      })
    }
  }
}

function defaultSpawn(cmd: string, args: string[]): ChildHandle {
  const proc = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
  return {
    pid: proc.pid ?? -1,
    kill: () => { proc.kill("SIGTERM") },
    onStdout: (l) => proc.stdout.on("data", (b) => l(b.toString("utf8"))),
    onStderr: (l) => proc.stderr.on("data", (b) => l(b.toString("utf8"))),
    onExit: (l) => proc.on("exit", (code) => l(code ?? 0)),
    isKilled: () => proc.killed,
  }
}
```

Public re-export `start` event by also emitting `tunnel_proposed` from caller — manager itself emits `_active`/`_stopped`/`_failed`. The `_proposed` and `_accepted` events come from the agent integration (Task 8).

**Step 4: Run test, verify pass**

Run: `bun test src/server/cloudflare-tunnel/tunnel-manager.test.ts`
Expected: PASS — 5 tests green.

**Step 5: Commit**

```bash
git add src/server/cloudflare-tunnel/tunnel-manager.ts src/server/cloudflare-tunnel/tunnel-manager.test.ts
git commit -m "feat(tunnel): tunnel-manager spawns cloudflared and parses trycloudflare URL"
```

---

## Task 7: Lifecycle watcher (source PID + session close)

**Files:**
- Create: `src/server/cloudflare-tunnel/lifecycle.ts`
- Create: `src/server/cloudflare-tunnel/lifecycle.test.ts`

**Step 1: Write failing tests**

`src/server/cloudflare-tunnel/lifecycle.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { TunnelLifecycle } from "./lifecycle"

describe("TunnelLifecycle", () => {
  test("polls source PID; calls onSourceExit when process gone", async () => {
    const exited: string[] = []
    let alive = true
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => alive,
      onSourceExit: (id) => exited.push(id),
    })
    lc.watch("t1", 1234)
    alive = false
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toContain("t1")
    lc.shutdown()
  })

  test("unwatch stops polling for a tunnel", async () => {
    const exited: string[] = []
    let alive = true
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => alive,
      onSourceExit: (id) => exited.push(id),
    })
    lc.watch("t1", 1234)
    lc.unwatch("t1")
    alive = false
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toEqual([])
    lc.shutdown()
  })

  test("does not fire onSourceExit when sourcePid is null", async () => {
    const exited: string[] = []
    const lc = new TunnelLifecycle({
      pollIntervalMs: 5,
      isPidAlive: () => false,
      onSourceExit: (id) => exited.push(id),
    })
    lc.watch("t1", null)
    await new Promise((r) => setTimeout(r, 30))
    expect(exited).toEqual([])
    lc.shutdown()
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/lifecycle.test.ts`
Expected: FAIL — module missing.

**Step 3: Implement lifecycle**

`src/server/cloudflare-tunnel/lifecycle.ts`:

```ts
export interface TunnelLifecycleArgs {
  pollIntervalMs?: number
  isPidAlive?: (pid: number) => boolean
  onSourceExit: (tunnelId: string) => void
}

export class TunnelLifecycle {
  private readonly pollIntervalMs: number
  private readonly isPidAlive: (pid: number) => boolean
  private readonly onSourceExit: (tunnelId: string) => void
  private readonly watched = new Map<string, number | null>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(args: TunnelLifecycleArgs) {
    this.pollIntervalMs = args.pollIntervalMs ?? 1500
    this.isPidAlive = args.isPidAlive ?? defaultIsPidAlive
    this.onSourceExit = args.onSourceExit
  }

  watch(tunnelId: string, sourcePid: number | null) {
    this.watched.set(tunnelId, sourcePid)
    this.ensureTimer()
  }

  unwatch(tunnelId: string) {
    this.watched.delete(tunnelId)
    if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watched.clear()
  }

  private ensureTimer() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs)
  }

  private tick() {
    for (const [tunnelId, pid] of [...this.watched.entries()]) {
      if (pid === null) continue
      if (!this.isPidAlive(pid)) {
        this.unwatch(tunnelId)
        this.onSourceExit(tunnelId)
      }
    }
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
```

**Step 4: Run test, verify pass**

Run: `bun test src/server/cloudflare-tunnel/lifecycle.test.ts`
Expected: PASS — 3 tests green.

**Step 5: Commit**

```bash
git add src/server/cloudflare-tunnel/lifecycle.ts src/server/cloudflare-tunnel/lifecycle.test.ts
git commit -m "feat(tunnel): lifecycle watcher polls source PID for exit detection"
```

---

## Task 8: Agent integration — Bash result hook + WS commands

**Files:**
- Modify: `src/server/agent.ts`
- Modify: `src/server/server.ts` (compose manager, lifecycle, store)
- Modify: `src/server/ws-router.ts` (handle accept/stop/retry commands)
- Modify: `src/server/event-store.ts` (persist tunnel events) — read it first to confirm pattern
- Test: `src/server/cloudflare-tunnel/agent-integration.test.ts` (new)

**Step 0: Read existing patterns first**

Run before coding:
```bash
grep -n "appendAutoContinueEvent\|getAutoContinueEvents" src/server/event-store.ts
```
Mirror these for `appendTunnelEvent` / `getTunnelEvents`.

Also read `src/server/ws-router.ts` to see how `acceptAutoContinue` etc. are wired — copy that shape.

**Step 1: Write failing integration test**

`src/server/cloudflare-tunnel/agent-integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { handleBashToolResult } from "./agent-integration"
import type { HaikuClient } from "./detector"

describe("handleBashToolResult", () => {
  test("emits tunnel_proposed when detector hits and feature enabled", async () => {
    const events: any[] = []
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173",
      chatId: "c1",
      sourcePid: 100,
      settings: { enabled: true, cloudflaredPath: "cloudflared", mode: "always-ask" },
      haiku: { classify: async () => '{"isServer": true, "port": 5173}' } as HaikuClient,
      onEvent: (e) => events.push(e),
      autoStart: () => Promise.resolve(),
    })
    expect(events.find((e) => e.kind === "tunnel_proposed")).toMatchObject({ port: 5173 })
  })

  test("skips detector when disabled", async () => {
    let called = false
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173",
      chatId: "c1",
      sourcePid: 100,
      settings: { enabled: false, cloudflaredPath: "cloudflared", mode: "always-ask" },
      haiku: { classify: async () => { called = true; return "{}" } } as HaikuClient,
      onEvent: () => {},
      autoStart: () => Promise.resolve(),
    })
    expect(called).toBe(false)
  })

  test("auto-expose mode triggers autoStart", async () => {
    const startCalls: any[] = []
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "...",
      chatId: "c1",
      sourcePid: 100,
      settings: { enabled: true, cloudflaredPath: "cloudflared", mode: "auto-expose" },
      haiku: { classify: async () => '{"isServer": true, "port": 5173}' } as HaikuClient,
      onEvent: () => {},
      autoStart: async (args) => { startCalls.push(args) },
    })
    expect(startCalls).toHaveLength(1)
  })
})
```

**Step 2: Run test, verify fail**

Run: `bun test src/server/cloudflare-tunnel/agent-integration.test.ts`
Expected: FAIL — module missing.

**Step 3: Implement agent-integration**

Create `src/server/cloudflare-tunnel/agent-integration.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { CloudflareTunnelSettings } from "../../shared/types"
import { evaluateBashOutput, type HaikuClient } from "./detector"
import type { CloudflareTunnelEvent } from "./events"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION } from "./events"

export interface HandleBashArgs {
  command: string
  stdout: string
  chatId: string
  sourcePid: number | null
  settings: CloudflareTunnelSettings
  haiku: HaikuClient
  onEvent: (event: CloudflareTunnelEvent) => void
  autoStart: (args: { chatId: string; tunnelId: string; port: number; sourcePid: number | null }) => Promise<void>
  now?: () => number
}

export async function handleBashToolResult(args: HandleBashArgs): Promise<void> {
  if (!args.settings.enabled) return
  const result = await evaluateBashOutput({
    command: args.command,
    stdout: args.stdout,
    client: args.haiku,
  })
  if (!result.isServer) return

  const tunnelId = randomUUID()
  const now = (args.now ?? Date.now)()
  args.onEvent({
    v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
    kind: "tunnel_proposed",
    timestamp: now,
    chatId: args.chatId,
    tunnelId,
    port: result.port,
    sourcePid: args.sourcePid,
  })

  if (args.settings.mode === "auto-expose") {
    args.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_accepted",
      timestamp: now,
      chatId: args.chatId,
      tunnelId,
      source: "auto_setting",
    })
    await args.autoStart({ chatId: args.chatId, tunnelId, port: result.port, sourcePid: args.sourcePid })
  }
}
```

**Step 4: Wire into agent.ts at tool_result hook (line ~385)**

In `src/server/agent.ts`, locate the `tool_result` branch (around line 385–393). Inject a call to `handleBashToolResult` when `tool_use_id` matches a previously-recorded `Bash` tool call. Maintain a small `Map<toolUseId, {command, pid?}>` populated in the `tool_use` branch (line 366) when `content.name === "Bash"`.

Add to `Agent` constructor / state:

```ts
private readonly pendingBashCalls = new Map<string, { command: string; chatId: string }>()
```

In `tool_use` branch (when name is "Bash"):
```ts
const command = typeof content.input?.command === "string" ? content.input.command : ""
this.pendingBashCalls.set(content.id, { command, chatId })
```

In `tool_result` branch:
```ts
const pending = this.pendingBashCalls.get(content.tool_use_id)
if (pending) {
  this.pendingBashCalls.delete(content.tool_use_id)
  const stdout = stringifyToolResultContent(content.content)
  void this.tunnelGateway?.handleBashResult({
    command: pending.command,
    stdout,
    chatId: pending.chatId,
    sourcePid: null, // Bash tool runs inside Claude SDK; PID not exposed — keep null for v1
  })
}
```

Add a `tunnelGateway?: TunnelGateway` to `Agent` constructor args. Define `TunnelGateway` in `src/server/cloudflare-tunnel/gateway.ts` as a thin façade exposing `handleBashResult`, `accept(tunnelId)`, `stop(tunnelId)`, `retry(tunnelId)` — composing `handleBashToolResult` + `TunnelManager` + event store + WS broadcast.

**Step 5: Wire WS commands in `ws-router.ts`**

Add three new WS message kinds (mirror `acceptAutoContinue` shape):
- `tunnel.accept { tunnelId }`
- `tunnel.stop { tunnelId }`
- `tunnel.retry { tunnelId }`

Each routes to corresponding `tunnelGateway` method. Server constructs `tunnelGateway` in `server.ts` and passes to `Agent` + `wsRouter`.

**Step 6: Run targeted tests**

Run: `bun test src/server/cloudflare-tunnel/`
Expected: PASS — all module tests green.

Run: `bun test src/server/agent.test.ts src/server/ws-router.test.ts`
Expected: PASS — existing tests still green (no regressions).

**Step 7: Commit**

```bash
git add src/server/cloudflare-tunnel/agent-integration.ts \
        src/server/cloudflare-tunnel/agent-integration.test.ts \
        src/server/cloudflare-tunnel/gateway.ts \
        src/server/agent.ts src/server/server.ts src/server/ws-router.ts \
        src/server/event-store.ts
git commit -m "feat(tunnel): wire detector + manager into agent Bash tool path"
```

---

## Task 9: Client read-model + WS handler

**Files:**
- Modify: `src/client/app/socket.ts` (handle new tunnel WS messages)
- Modify: `src/client/app/useKannaState.ts` (extend snapshot with `tunnels`)
- Test: colocated `*.test.ts`

**Step 1: Read existing pattern**

Run:
```bash
grep -n "autoContinue\|schedules" src/client/app/socket.ts src/client/app/useKannaState.ts | head -30
```

Mirror this pattern for `cloudflareTunnel`.

**Step 2: Write failing test (snapshot reducer)**

In `src/client/app/useKannaState.test.ts` add cases for:
- `tunnel_proposed` event adds proposed record to `state.tunnelsByChat[chatId][tunnelId]`
- `tunnel_active` flips state to active with URL
- `tunnel_stopped` flips to stopped

**Step 3: Run, verify fail. Implement. Run, verify pass.**

**Step 4: Commit**

```bash
git add src/client/app/socket.ts src/client/app/useKannaState.ts src/client/app/useKannaState.test.ts
git commit -m "feat(tunnel): client read-model wiring for tunnel events"
```

---

## Task 10: CloudflareTunnelCard component

**Files:**
- Create: `src/client/components/chat-ui/CloudflareTunnelCard.tsx`
- Create: `src/client/components/chat-ui/CloudflareTunnelCard.test.tsx`

**Step 1: Write failing tests**

```tsx
import { describe, expect, test } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { CloudflareTunnelCard } from "./CloudflareTunnelCard"

const baseRecord = {
  tunnelId: "t1",
  chatId: "c1",
  port: 5173,
  url: null,
  error: null,
  proposedAt: 1,
  activatedAt: null,
  stoppedAt: null,
}

describe("CloudflareTunnelCard", () => {
  test("proposed → renders Expose + Dismiss", () => {
    const onAccept = mock(() => {})
    const onDismiss = mock(() => {})
    render(<CloudflareTunnelCard
      record={{ ...baseRecord, state: "proposed" }}
      onAccept={onAccept}
      onStop={() => {}}
      onRetry={() => {}}
      onDismiss={onDismiss}
    />)
    expect(screen.getByText(/Port 5173 detected/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Expose/ }))
    expect(onAccept).toHaveBeenCalledWith("t1")
  })

  test("active → renders URL + Copy + Stop", () => { /* ... */ })
  test("stopped → renders 'Tunnel stopped'", () => { /* ... */ })
  test("failed → renders error + Retry", () => { /* ... */ })
})
```

(Check existing `AutoContinueCard.test.tsx` for `mock` import + render setup — mirror precisely.)

**Step 2: Run, verify fail. Implement. Run, verify pass.**

Implementation mirrors `AutoContinueCard.tsx` structure (rounded border, action buttons, state switch).

**Step 3: Commit**

```bash
git add src/client/components/chat-ui/CloudflareTunnelCard.tsx src/client/components/chat-ui/CloudflareTunnelCard.test.tsx
git commit -m "feat(tunnel): CloudflareTunnelCard mirrors AutoContinueCard state machine"
```

---

## Task 11: Render card in transcript

**Files:**
- Modify: `src/client/app/KannaTranscript.tsx` (find AutoContinueCard render site; add tunnel render below it)
- Test: extend existing `KannaTranscript.test.tsx` (only if it tests rendering integration)

**Step 1: Locate render point**

Run:
```bash
grep -n "AutoContinueCard" src/client/app/KannaTranscript.tsx
```

**Step 2: Add tunnel rendering at same level**

Pull live tunnels for current chat from `useKannaState`, render one `CloudflareTunnelCard` per record. WS dispatch handlers call `socket.send({ kind: "tunnel.accept", tunnelId })` etc.

**Step 3: Build + manual smoke**

Run: `bun run check`
Expected: PASS — typecheck + build.

**Step 4: Commit**

```bash
git add src/client/app/KannaTranscript.tsx
git commit -m "feat(tunnel): render CloudflareTunnelCard inline in transcript"
```

---

## Task 12: Settings page UI

**Files:**
- Modify: `src/client/app/SettingsPage.tsx`
- Modify: `src/client/app/SettingsPage.test.tsx`

**Step 1: Write failing tests**

Cases:
- Renders "Cloudflare Tunnel" section
- Toggle flips `enabled` and posts settings update
- Mode radio updates `mode` setting
- `cloudflaredPath` input debounce-saves
- Disabled state greys out mode/path when toggle off

**Step 2: Run, verify fail. Implement section. Run, verify pass.**

**Step 3: Build + commit**

```bash
bun run check
git add src/client/app/SettingsPage.tsx src/client/app/SettingsPage.test.tsx
git commit -m "feat(tunnel): settings page section for cloudflare tunnel toggle/mode/path"
```

---

## Task 13: End-to-end test

**Files:**
- Create: `src/server/cloudflare-tunnel/e2e.test.ts`

**Step 1: Write E2E test**

Mirror `src/server/auto-continue/e2e.test.ts` shape. Spin up the gateway with stubbed haiku (returns `{isServer: true, port: 5173}`), stubbed spawn (fake child emitting URL on demand), assert event sequence: `tunnel_proposed → tunnel_accepted → tunnel_active → tunnel_stopped` after `gateway.accept` then `gateway.stop`.

**Step 2: Run, verify fail. Implement gateway hooks if missing. Run, verify pass.**

**Step 3: Commit**

```bash
git add src/server/cloudflare-tunnel/e2e.test.ts
git commit -m "test(tunnel): e2e covers propose → accept → active → stop flow"
```

---

## Task 14: Run full suite + typecheck

**Step 1: Run full suite**

Run: `bun test`
Expected: PASS — all 724+ existing + new tunnel tests green.

**Step 2: Typecheck + build**

Run: `bun run check`
Expected: PASS.

**Step 3: If any regression, return to that task and fix. Do not bundle fixes.**

---

## Task 15: Update C3 docs

**Files:**
- Create: `.c3/c3-2-server/c3-2xx-cloudflare-tunnel.md` (new component)
- Modify: `.c3/_index/_index.md` (regenerate — let `c3x` rebuild it)
- Modify: `.c3/c3-1-client/c3-116-settings-page.md` (note new section)
- Modify: `.c3/c3-2-server/<agent component>.md` (note new hook)

**Step 1: Read c3 conventions**

```bash
ls .c3/c3-2-server/
cat .c3/c3-2-server/<one existing component>.md
```

Mirror the structure: Goal, Responsibilities, Components, Container Connection, Dependencies, Related Refs.

**Step 2: Write the component doc**

Component fields: `c3-2xx`, container `c3-2`, files glob `src/server/cloudflare-tunnel/**/*.ts`, refs `ref-strong-typing`, `ref-ws-subscription`, `ref-colocated-bun-test`.

**Step 3: Run the C3 sweep**

Run: `c3x lookup src/server/cloudflare-tunnel/tunnel-manager.ts`
Expected: maps to new component.

**Step 4: Commit**

```bash
git add .c3/
git commit -m "docs(c3): add cloudflare-tunnel server component"
```

---

## Final Checklist

- [ ] All tasks committed with passing tests
- [ ] `bun test` green (full suite)
- [ ] `bun run check` green (typecheck + build)
- [ ] Settings default `enabled: false` (opt-in)
- [ ] Card mirrors `AutoContinueCard` UX
- [ ] Tunnel state ephemeral (no DB persistence)
- [ ] C3 docs updated
- [ ] Manual smoke: enable feature in settings, run `bun run dev` in a project, see proposed card, click Expose, see active URL, kill `bun run dev` → card flips to stopped.

## Out of Scope (do NOT implement)

- Named tunnels / Cloudflare auth.
- Auto-install `cloudflared`.
- Port allow/deny lists.
- Tunnel persistence across server restarts.
- Custom regex / non-haiku detection backends.
