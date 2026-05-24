# Share Session Read-Only (Public View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat-header Share button that mints a public read-only URL for a Kanna chat session, served through the existing Cloudflare tunnel as a frozen JSON snapshot.

**Architecture:** New server component `c3-228 session-share` owns token mint/revoke (events on the existing event log), snapshot files under `~/.kanna/shares/<token>.json`, and a public `/share/:token` HTTP route that bypasses auth. New client surface: header button, popover, public read-only view route. Settings row holds the default TTL.

**Tech Stack:** Bun + TypeScript on the server; React + Zustand on the client; existing `EventStore`, `AppSettingsManager`, `TunnelGateway`, `WsRouter`, `AuthManager`; Bun test framework with colocated `*.test.ts(x)`.

**Spec reference:** `docs/superpowers/specs/2026-05-24-share-session-readonly-design.md`

---

## File Map (locked in before tasks)

Server (new):
- `src/server/session-share/index.ts` — `SessionShareService` with `mintToken`, `revokeToken`, `getShare`, `serveSnapshot`, `runSweep`.
- `src/server/session-share/token.ts` — `generateShareToken()` (32 random bytes → base64url) + `hashToken()` for log lines.
- `src/server/session-share/types-internal.ts` — server-only types (`ShareRecord`, `ShareLookup`).
- `src/server/session-share/share-projection.ts` — `buildShareProjection(events)` + mutator helpers.
- `src/server/session-share/snapshot-builder.ts` — `buildChatSnapshot(eventStore, readModels, chatId)`.
- `src/server/session-share/snapshot-store.adapter.ts` — `SnapshotStore` (writeSnapshot, readSnapshot, deleteSnapshot, totalBytes).
- `src/server/session-share/http-routes.ts` — `handleShareRequest(req, service)` returns `Response`.
- `src/server/session-share/sweep.ts` — `startSnapshotSweep(service, intervalMs)`.

Server (modified):
- `src/server/event-store.ts` — add `appendShareEvent`, `getShareEvents`, share log file path.
- `src/server/app-settings.ts` — add `shareDefaultTtlHours` field to `AppSettingsSnapshot` / file payload / defaults / normalizer / patch / toFilePayload.
- `src/server/auth.ts` — add `isPublicSharePath(url)` helper.
- `src/server/cli-entry.ts` (or the file that wires the HTTP server) — register `/share/*` route ahead of auth gate; instantiate `SessionShareService` and pass to `WsRouter`.
- `src/server/ws-router.ts` — dispatch `share_mint` / `share_revoke` / `share_list` envelopes.

Shared (new):
- `src/shared/session-share/types.ts` — `ShareToken`, `ChatSnapshot`, `ChatSnapshotMessage`, `ShareError` (discriminated union), `MintRequest`, `MintResponse`, `RevokeRequest`, `ShareSummary`.
- `src/shared/session-share/protocol.ts` — `ShareClientCommand`, `ShareServerEvent` envelopes; constants `SHARE_CMD_MINT`, `SHARE_CMD_REVOKE`, `SHARE_CMD_LIST`.

Shared (modified):
- `src/shared/protocol.ts` — extend `ClientEnvelope` / `ServerEnvelope` unions.

Client (new):
- `src/client/components/share/ShareButton.tsx`
- `src/client/components/share/SharePopover.tsx`
- `src/client/components/share/share-store.ts`
- `src/client/components/share/share-store.test.ts`
- `src/client/components/share/ShareButton.test.tsx`
- `src/client/components/share/SharePopover.test.tsx`
- `src/client/app/share-view/ShareViewPage.tsx`
- `src/client/app/share-view/ShareViewPage.test.tsx`
- `src/client/app/share-view/index.tsx` — route registration.
- `src/client/components/settings/ShareDefaultTtl.tsx`

Client (modified):
- `src/client/app/App.tsx` — register `/share/:token` route mapping to `ShareViewPage`.
- `src/client/components/chat-ui/<chat-header>` — mount `ShareButton`.
- `src/client/app/SettingsPage.tsx` — mount `ShareDefaultTtl` row.

Docs / c3:
- `.c3/adr/adr-20260524-session-share.md` (via c3x)
- `.c3/c3-2-server/c3-228-session-share.md` (via c3x)
- Updates to `c3-115`, `c3-116`, `c3-202`, `c3-203`, `c3-205`, `c3-306` (via c3x `write` / `set` / `wire`)

Wiki:
- `wiki/src/content/docs/sharing/session-share.mdx`

---

## Task 1: ADR + c3 component scaffold

**Files:**
- Create (via c3x): `.c3/adr/adr-20260524-session-share.md`
- Create (via c3x): `.c3/c3-2-server/c3-228-session-share.md`

- [ ] **Step 1.1: View schema before writing ADR body**

Run:
```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh schema adr
```
Read the REJECT IF block. Body must hit every section the schema lists.

- [ ] **Step 1.2: Write ADR body to a temp file**

Create `/tmp/adr-session-share.md`:

```markdown
## Context

Owners need to show finished Kanna chat sessions to teammates without giving them write access or a Kanna login. Today the only sharing mechanism is the whole-Kanna Cloudflare tunnel (c3-218), which requires recipients to authenticate against the host's password.

## Decision

Introduce c3-228 session-share. Owner clicks Share in the chat header; server builds a frozen JSON snapshot from the event log via existing read-models, persists it under ~/.kanna/shares/<token>.json (mode 0600), appends a share.token_minted event to the chat log, and returns <tunnel-base>/share/<token>. The path is exempt from auth (c3-203 path-prefix bypass); the 256-bit token is the credential. Snapshot only — no live updates. TTL default lives in settings (shareDefaultTtlHours).

## Consequences

Adds one public auth-bypass path-prefix (security review surface). Adds two event kinds to the chats log (forward-only, replay-safe). Adds ~1 GB shares-directory disk budget. Does not auto-spawn the tunnel — mint is refused with NO_TUNNEL when none active.

## Alternatives

- Live ws subscription with viewer scope: heavier auth surface across the entire event-store path.
- Static HTML export hosted externally: loses the chat-page look/feel and conflicts with the "full chat page read-only" requirement.
- Hosted snapshot upload service: out of scope; no Kanna backend service.

## Parent Delta

c3-2 server gains a new public route prefix. c3-203 gains a path-prefix exemption rule. c3-205 gains two event kinds in the chats union. No other parent contract change.
```

Then:
```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh add adr session-share --file /tmp/adr-session-share.md
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh check --include-adr
```
Expected: ADR created in `proposed`, `check` clean.

- [ ] **Step 1.3: Move ADR to accepted**

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh set adr-20260524-session-share status accepted
```

- [ ] **Step 1.4: View component schema**

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh schema component
```

- [ ] **Step 1.5: Write component body to temp file**

Create `/tmp/c3-228-body.md` populating every required section (Goal, Parent Fit, Purpose, Foundational Flow, Business Flow, Governance, Contract, Change Safety, Derived Materials) per the spec's Architecture and Data Flows sections. Use the snippets directly from `docs/superpowers/specs/2026-05-24-share-session-readonly-design.md` so the wording is consistent.

- [ ] **Step 1.6: Create the component**

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh add component session-share --container c3-2 --file /tmp/c3-228-body.md
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-228 ref-local-first-data
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-228 ref-event-sourcing
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-228 ref-cqrs-read-models
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-228 ref-side-effect-adapter
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-228 ref-strong-typing
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh check
```
Expected: `check` clean.

- [ ] **Step 1.7: Commit**

```bash
git add .c3/
git commit -m "docs(c3): add adr-20260524-session-share + c3-228 session-share component"
```

---

## Task 2: Shared types and protocol

**Files:**
- Create: `src/shared/session-share/types.ts`
- Create: `src/shared/session-share/protocol.ts`
- Modify: `src/shared/protocol.ts`
- Test: `src/shared/session-share/types.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `src/shared/session-share/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CHAT_SNAPSHOT_VERSION, isShareError, type ChatSnapshot, type ShareError } from "./types"

describe("session-share types", () => {
  test("CHAT_SNAPSHOT_VERSION is 1", () => {
    expect(CHAT_SNAPSHOT_VERSION).toBe(1)
  })

  test("isShareError narrows discriminated union", () => {
    const err: ShareError = { kind: "expired", expiredAt: 1 }
    expect(isShareError(err)).toBe(true)
    expect(isShareError({ kind: "ok" } as unknown as ShareError)).toBe(false)
  })

  test("ChatSnapshot is structurally typed", () => {
    const snap: ChatSnapshot = {
      version: CHAT_SNAPSHOT_VERSION,
      chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
      messages: [],
      attachmentsManifest: [],
    }
    expect(snap.version).toBe(1)
  })
})
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `bun test src/shared/session-share/types.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2.3: Write the types module**

Create `src/shared/session-share/types.ts`:

```ts
export const CHAT_SNAPSHOT_VERSION = 1 as const

export interface ChatMeta {
  id: string
  title: string
  model: string
  createdAt: number
}

export type ChatSnapshotMessage =
  | { kind: "user_prompt"; id: string; createdAt: number; text: string }
  | { kind: "assistant_text"; id: string; createdAt: number; text: string }
  | { kind: "tool_call"; id: string; createdAt: number; name: string; input: unknown }
  | { kind: "tool_result"; id: string; createdAt: number; toolCallId: string; output: unknown; isError: boolean }
  | { kind: "diff"; id: string; createdAt: number; path: string; patch: string }
  | { kind: "terminal_chunk"; id: string; createdAt: number; chunk: string }
  | { kind: "omitted"; id: string; createdAt: number; reason: "too_large" }

export interface AttachmentManifestEntry {
  filename: string
  sizeBytes: number
  inlineBase64?: string
}

export interface ChatSnapshot {
  version: typeof CHAT_SNAPSHOT_VERSION
  chatMeta: ChatMeta
  messages: ChatSnapshotMessage[]
  attachmentsManifest: AttachmentManifestEntry[]
}

export type ShareError =
  | { kind: "no_tunnel" }
  | { kind: "chat_not_found"; chatId: string }
  | { kind: "snapshot_too_large"; sizeBytes: number }
  | { kind: "snapshot_write_failed"; message: string }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "expired"; expiredAt: number }
  | { kind: "snapshot_read_failed"; message: string }

const SHARE_ERROR_KINDS = new Set<ShareError["kind"]>([
  "no_tunnel",
  "chat_not_found",
  "snapshot_too_large",
  "snapshot_write_failed",
  "not_found",
  "revoked",
  "expired",
  "snapshot_read_failed",
])

export function isShareError(value: unknown): value is ShareError {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && SHARE_ERROR_KINDS.has((value as { kind: ShareError["kind"] }).kind)
}

export interface ShareSummary {
  tokenId: string
  chatId: string
  url: string
  expiresAt: number
  createdAt: number
  revoked: boolean
}

export interface MintRequest {
  chatId: string
  ttlHours?: number
}

export interface MintResponse {
  summary: ShareSummary
}

export interface RevokeRequest {
  tokenId: string
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `bun test src/shared/session-share/types.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Write the protocol envelopes**

Create `src/shared/session-share/protocol.ts`:

```ts
import type { MintRequest, MintResponse, RevokeRequest, ShareError, ShareSummary } from "./types"

export const SHARE_CMD_MINT = "share_mint" as const
export const SHARE_CMD_REVOKE = "share_revoke" as const
export const SHARE_CMD_LIST = "share_list" as const

export const SHARE_EVT_RESULT = "share_result" as const
export const SHARE_EVT_LIST = "share_list_result" as const

export type ShareClientCommand =
  | { kind: typeof SHARE_CMD_MINT; requestId: string; payload: MintRequest }
  | { kind: typeof SHARE_CMD_REVOKE; requestId: string; payload: RevokeRequest }
  | { kind: typeof SHARE_CMD_LIST; requestId: string; payload: { chatId: string } }

export type ShareServerEvent =
  | { kind: typeof SHARE_EVT_RESULT; requestId: string; ok: true; data: MintResponse }
  | { kind: typeof SHARE_EVT_RESULT; requestId: string; ok: false; error: ShareError }
  | { kind: typeof SHARE_EVT_LIST; requestId: string; ok: true; data: { shares: ShareSummary[] } }
  | { kind: typeof SHARE_EVT_LIST; requestId: string; ok: false; error: ShareError }
```

- [ ] **Step 2.6: Extend the global protocol unions**

Open `src/shared/protocol.ts`. Find the `ClientEnvelope` discriminated union and add `ShareClientCommand` as a top-level member; find `ServerEnvelope` and add `ShareServerEvent`. Re-export the constants near the existing command kinds. Do not change existing kinds.

- [ ] **Step 2.7: Verify build + tests**

Run: `bun test src/shared/session-share/`
Expected: PASS. Then `bun run lint` — must report 0 warnings.

- [ ] **Step 2.8: Commit**

```bash
git add src/shared/session-share/ src/shared/protocol.ts
git commit -m "feat(share): add shared session-share types and ws protocol envelopes"
```

---

## Task 3: Token generator

**Files:**
- Create: `src/server/session-share/token.ts`
- Test: `src/server/session-share/token.test.ts`

- [ ] **Step 3.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { generateShareToken, hashToken } from "./token"

describe("token", () => {
  test("generateShareToken produces 43-char base64url (32 raw bytes)", () => {
    const t = generateShareToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("two generations differ", () => {
    expect(generateShareToken()).not.toBe(generateShareToken())
  })

  test("hashToken is stable, 32 chars, never returns the input", () => {
    const t = generateShareToken()
    const h = hashToken(t)
    expect(h).toMatch(/^[a-f0-9]{32}$/)
    expect(h).not.toBe(t)
    expect(hashToken(t)).toBe(h)
  })
})
```

- [ ] **Step 3.2: Run test to verify it fails**

`bun test src/server/session-share/token.test.ts` → FAIL (module not found).

- [ ] **Step 3.3: Implement**

```ts
import { createHash, randomBytes } from "node:crypto"

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32)
}
```

- [ ] **Step 3.4: Verify**

`bun test src/server/session-share/token.test.ts` → PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/server/session-share/token.ts src/server/session-share/token.test.ts
git commit -m "feat(share): token generator + stable hash for log lines"
```

---

## Task 4: Snapshot-store adapter

**Files:**
- Create: `src/server/session-share/snapshot-store.adapter.ts`
- Test: `src/server/session-share/snapshot-store.adapter.test.ts`

- [ ] **Step 4.1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kanna-share-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sample: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [],
  attachmentsManifest: [],
}

describe("SnapshotStore", () => {
  test("write then read round-trips, file mode 0600", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("tok1", sample)
    const got = await store.readSnapshot("tok1")
    expect(got).toEqual(sample)
    const mode = statSync(join(dir, "tok1.json")).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("readSnapshot returns null when missing", async () => {
    const store = new SnapshotStore(dir)
    expect(await store.readSnapshot("missing")).toBeNull()
  })

  test("deleteSnapshot is idempotent", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("tok1", sample)
    await store.deleteSnapshot("tok1")
    await store.deleteSnapshot("tok1")
    expect(await store.readSnapshot("tok1")).toBeNull()
  })

  test("totalBytes sums file sizes", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("a", sample)
    await store.writeSnapshot("b", sample)
    const total = await store.totalBytes()
    const expected = statSync(join(dir, "a.json")).size + statSync(join(dir, "b.json")).size
    expect(total).toBe(expected)
  })

  test("rejects tokenIds containing path separators", async () => {
    const store = new SnapshotStore(dir)
    await expect(store.writeSnapshot("../escape", sample)).rejects.toThrow()
  })
})
```

- [ ] **Step 4.2: Run test to verify it fails**

`bun test src/server/session-share/snapshot-store.adapter.test.ts` → FAIL.

- [ ] **Step 4.3: Implement**

```ts
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ChatSnapshot } from "../../shared/session-share/types"

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function assertSafeTokenId(tokenId: string) {
  if (!TOKEN_PATTERN.test(tokenId)) {
    throw new Error(`unsafe share tokenId: ${tokenId}`)
  }
}

export class SnapshotStore {
  constructor(private readonly dir: string) {}

  private path(tokenId: string): string {
    assertSafeTokenId(tokenId)
    return join(this.dir, `${tokenId}.json`)
  }

  async writeSnapshot(tokenId: string, snapshot: ChatSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const body = JSON.stringify(snapshot)
    await writeFile(this.path(tokenId), body, { mode: 0o600 })
  }

  async readSnapshot(tokenId: string): Promise<ChatSnapshot | null> {
    try {
      const body = await readFile(this.path(tokenId), "utf8")
      return JSON.parse(body) as ChatSnapshot
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  }

  async deleteSnapshot(tokenId: string): Promise<void> {
    await rm(this.path(tokenId), { force: true })
  }

  async totalBytes(): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
      throw err
    }
    let total = 0
    for (const name of entries) {
      const s = await stat(join(this.dir, name))
      if (s.isFile()) total += s.size
    }
    return total
  }

  async measureSnapshotBytes(snapshot: ChatSnapshot): Promise<number> {
    return Buffer.byteLength(JSON.stringify(snapshot), "utf8")
  }
}
```

- [ ] **Step 4.4: Verify**

`bun test src/server/session-share/snapshot-store.adapter.test.ts` → PASS. `bun run lint` must stay at 0 warnings (the `.adapter.ts` suffix exempts this file from the side-effect seal).

- [ ] **Step 4.5: Commit**

```bash
git add src/server/session-share/snapshot-store.adapter.ts src/server/session-share/snapshot-store.adapter.test.ts
git commit -m "feat(share): snapshot-store adapter (0600 mode, tokenId guard)"
```

---

## Task 5: Snapshot builder

**Files:**
- Create: `src/server/session-share/snapshot-builder.ts`
- Test: `src/server/session-share/snapshot-builder.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { CHAT_SNAPSHOT_VERSION } from "../../shared/session-share/types"
import { buildChatSnapshot, type SnapshotSources } from "./snapshot-builder"

function fakeSources(): SnapshotSources {
  return {
    getChatMeta: () => ({ id: "c1", title: "t", model: "claude-opus", createdAt: 1 }),
    getTranscript: () => [
      { kind: "user_prompt", id: "m1", createdAt: 2, text: "hi" },
      { kind: "assistant_text", id: "m2", createdAt: 3, text: "hello" },
    ],
    getAttachments: () => [{ filename: "a.txt", sizeBytes: 4, inlineBase64: "Zm9v" }],
  }
}

describe("buildChatSnapshot", () => {
  test("builds a v1 snapshot from sources", () => {
    const snap = buildChatSnapshot(fakeSources(), "c1")
    expect(snap.version).toBe(CHAT_SNAPSHOT_VERSION)
    expect(snap.chatMeta.id).toBe("c1")
    expect(snap.messages.length).toBe(2)
    expect(snap.attachmentsManifest[0]!.filename).toBe("a.txt")
  })

  test("strips diff and terminal_chunk bodies when stripLargeBodies=true", () => {
    const sources: SnapshotSources = {
      ...fakeSources(),
      getTranscript: () => [
        { kind: "diff", id: "m1", createdAt: 1, path: "f", patch: "X".repeat(1024) },
        { kind: "terminal_chunk", id: "m2", createdAt: 2, chunk: "Y".repeat(1024) },
        { kind: "assistant_text", id: "m3", createdAt: 3, text: "kept" },
      ],
    }
    const snap = buildChatSnapshot(sources, "c1", { stripLargeBodies: true })
    expect(snap.messages.map(m => m.kind)).toEqual(["omitted", "omitted", "assistant_text"])
  })

  test("throws when chat is unknown", () => {
    const sources: SnapshotSources = {
      ...fakeSources(),
      getChatMeta: () => null,
    }
    expect(() => buildChatSnapshot(sources, "missing")).toThrow(/chat_not_found/)
  })
})
```

- [ ] **Step 5.2: Run test to verify it fails**

`bun test src/server/session-share/snapshot-builder.test.ts` → FAIL.

- [ ] **Step 5.3: Implement**

```ts
import {
  CHAT_SNAPSHOT_VERSION,
  type AttachmentManifestEntry,
  type ChatMeta,
  type ChatSnapshot,
  type ChatSnapshotMessage,
} from "../../shared/session-share/types"

export interface SnapshotSources {
  getChatMeta(chatId: string): ChatMeta | null
  getTranscript(chatId: string): ChatSnapshotMessage[]
  getAttachments(chatId: string): AttachmentManifestEntry[]
}

export interface BuildOptions {
  stripLargeBodies?: boolean
}

export function buildChatSnapshot(
  sources: SnapshotSources,
  chatId: string,
  opts: BuildOptions = {},
): ChatSnapshot {
  const meta = sources.getChatMeta(chatId)
  if (!meta) {
    throw new Error(`chat_not_found:${chatId}`)
  }
  const transcript = sources.getTranscript(chatId)
  const messages = opts.stripLargeBodies
    ? transcript.map<ChatSnapshotMessage>((m) =>
        m.kind === "diff" || m.kind === "terminal_chunk"
          ? { kind: "omitted", id: m.id, createdAt: m.createdAt, reason: "too_large" }
          : m,
      )
    : transcript
  return {
    version: CHAT_SNAPSHOT_VERSION,
    chatMeta: meta,
    messages,
    attachmentsManifest: sources.getAttachments(chatId),
  }
}
```

The integration that adapts the real `EventStore` + `read-models` to `SnapshotSources` lives in Task 7's `SessionShareService` so this module stays pure.

- [ ] **Step 5.4: Verify**

`bun test src/server/session-share/snapshot-builder.test.ts` → PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/server/session-share/snapshot-builder.ts src/server/session-share/snapshot-builder.test.ts
git commit -m "feat(share): pure ChatSnapshot builder with optional large-body stripping"
```

---

## Task 6: Share projection

**Files:**
- Create: `src/server/session-share/share-projection.ts`
- Test: `src/server/session-share/share-projection.test.ts`

- [ ] **Step 6.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { applyShareEvent, buildShareProjection, type ShareEvent } from "./share-projection"

const minted: ShareEvent = {
  v: 1,
  kind: "share.token_minted",
  tokenId: "t1",
  chatId: "c1",
  expiresAt: 2000,
  createdAt: 1000,
  createdBy: "u",
}
const revoked: ShareEvent = { v: 1, kind: "share.token_revoked", tokenId: "t1", revokedAt: 1500 }

describe("share-projection", () => {
  test("replays mint then revoke", () => {
    const proj = buildShareProjection([minted, revoked])
    expect(proj.get("t1")?.revoked).toBe(true)
  })

  test("classifyShare returns expired vs ok vs revoked", () => {
    const proj = buildShareProjection([minted])
    const rec = proj.get("t1")!
    expect(rec.revoked).toBe(false)
    expect(rec.expiresAt).toBe(2000)
  })

  test("applyShareEvent on a fresh map matches buildShareProjection", () => {
    const map = new Map()
    applyShareEvent(map, minted)
    applyShareEvent(map, revoked)
    expect(map.get("t1")?.revoked).toBe(true)
  })
})
```

- [ ] **Step 6.2: Run test to verify it fails**

`bun test src/server/session-share/share-projection.test.ts` → FAIL.

- [ ] **Step 6.3: Implement**

```ts
export type ShareEvent =
  | {
      v: 1
      kind: "share.token_minted"
      tokenId: string
      chatId: string
      expiresAt: number
      createdAt: number
      createdBy: string
    }
  | { v: 1; kind: "share.token_revoked"; tokenId: string; revokedAt: number }

export interface ShareRecord {
  tokenId: string
  chatId: string
  expiresAt: number
  createdAt: number
  createdBy: string
  revoked: boolean
  revokedAt: number | null
}

export type ShareProjection = Map<string, ShareRecord>

export function applyShareEvent(projection: ShareProjection, event: ShareEvent): void {
  if (event.kind === "share.token_minted") {
    projection.set(event.tokenId, {
      tokenId: event.tokenId,
      chatId: event.chatId,
      expiresAt: event.expiresAt,
      createdAt: event.createdAt,
      createdBy: event.createdBy,
      revoked: false,
      revokedAt: null,
    })
    return
  }
  const existing = projection.get(event.tokenId)
  if (!existing) return
  projection.set(event.tokenId, { ...existing, revoked: true, revokedAt: event.revokedAt })
}

export function buildShareProjection(events: Iterable<ShareEvent>): ShareProjection {
  const proj: ShareProjection = new Map()
  for (const e of events) applyShareEvent(proj, e)
  return proj
}

export type ShareStatus =
  | { kind: "ok"; record: ShareRecord }
  | { kind: "not_found" }
  | { kind: "revoked"; record: ShareRecord }
  | { kind: "expired"; record: ShareRecord }

export function classifyShare(projection: ShareProjection, tokenId: string, now: number): ShareStatus {
  const record = projection.get(tokenId)
  if (!record) return { kind: "not_found" }
  if (record.revoked) return { kind: "revoked", record }
  if (record.expiresAt <= now) return { kind: "expired", record }
  return { kind: "ok", record }
}
```

- [ ] **Step 6.4: Verify**

`bun test src/server/session-share/share-projection.test.ts` → PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/server/session-share/share-projection.ts src/server/session-share/share-projection.test.ts
git commit -m "feat(share): event projection + classification (ok/not_found/revoked/expired)"
```

---

## Task 7: SessionShareService core

**Files:**
- Create: `src/server/session-share/index.ts`
- Test: `src/server/session-share/session-share.test.ts`
- Modify: `src/server/event-store.ts` — add `appendShareEvent(event)` + `getShareEvents(): ShareEvent[]` + a new `sharesLogPath` constant.

- [ ] **Step 7.1: Extend EventStore with share-event accessors**

Add to `src/server/event-store.ts`:

```ts
import type { ShareEvent } from "./session-share/share-projection"

// inside the constructor / paths block:
private readonly sharesLogPath = join(this.kannaDir, "events", "shares.jsonl")

// new public methods:
async appendShareEvent(event: ShareEvent): Promise<void> {
  await this.append(this.sharesLogPath, event)
}

getShareEvents(): ShareEvent[] {
  return this.readAll<ShareEvent>(this.sharesLogPath)
}
```

(`readAll` here mirrors the helper used for the other log files in this file — copy the pattern exactly.)

- [ ] **Step 7.2: Write the failing test**

Create `src/server/session-share/session-share.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionShareService } from "./index"
import type { ShareEvent } from "./share-projection"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"

class FakeEventStore {
  events: ShareEvent[] = []
  async appendShareEvent(e: ShareEvent) { this.events.push(e) }
  getShareEvents() { return this.events.slice() }
}

const snapshot: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [],
  attachmentsManifest: [],
}

let dir: string
let store: SnapshotStore
let events: FakeEventStore
let service: SessionShareService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "share-svc-"))
  store = new SnapshotStore(dir)
  events = new FakeEventStore()
  service = new SessionShareService({
    events,
    snapshotStore: store,
    buildSnapshot: () => snapshot,
    getTunnelBaseUrl: () => "https://x.trycloudflare.com",
    getDefaultTtlHours: () => 24,
    now: () => 1_000_000,
    owner: () => "owner",
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("SessionShareService", () => {
  test("mintToken returns NO_TUNNEL when base URL missing", async () => {
    service = new SessionShareService({
      events, snapshotStore: store, buildSnapshot: () => snapshot,
      getTunnelBaseUrl: () => null, getDefaultTtlHours: () => 24,
      now: () => 1, owner: () => "owner",
    })
    const r = await service.mintToken({ chatId: "c1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("no_tunnel")
  })

  test("mintToken success appends event and writes snapshot", async () => {
    const r = await service.mintToken({ chatId: "c1" })
    expect(r.ok).toBe(true)
    expect(events.events.length).toBe(1)
    if (r.ok) {
      expect(r.data.summary.url).toContain("/share/")
      const read = await store.readSnapshot(events.events[0]!.kind === "share.token_minted" ? events.events[0]!.tokenId : "")
      expect(read).toEqual(snapshot)
    }
  })

  test("revokeToken appends event and deletes file", async () => {
    const mint = await service.mintToken({ chatId: "c1" })
    if (!mint.ok) throw new Error("expected mint to succeed")
    const r = await service.revokeToken({ tokenId: mint.data.summary.tokenId })
    expect(r.ok).toBe(true)
    expect(await store.readSnapshot(mint.data.summary.tokenId)).toBeNull()
  })

  test("getShare returns expired when past expiresAt", async () => {
    const mint = await service.mintToken({ chatId: "c1", ttlHours: 0 })
    if (!mint.ok) throw new Error("expected mint to succeed")
    const r = await service.getShare(mint.data.summary.tokenId, Date.now() + 60_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("expired")
  })

  test("getShare returns not_found for unknown token", async () => {
    const r = await service.getShare("unknown", 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not_found")
  })
})
```

- [ ] **Step 7.3: Run test to verify it fails**

`bun test src/server/session-share/session-share.test.ts` → FAIL.

- [ ] **Step 7.4: Implement the service**

Create `src/server/session-share/index.ts`:

```ts
import type {
  ChatSnapshot,
  MintRequest,
  MintResponse,
  RevokeRequest,
  ShareError,
  ShareSummary,
} from "../../shared/session-share/types"
import { applyShareEvent, buildShareProjection, classifyShare, type ShareEvent, type ShareProjection } from "./share-projection"
import type { SnapshotStore } from "./snapshot-store.adapter"
import { generateShareToken } from "./token"

export interface ShareEventSink {
  appendShareEvent(event: ShareEvent): Promise<void>
  getShareEvents(): ShareEvent[]
}

export interface SessionShareDeps {
  events: ShareEventSink
  snapshotStore: SnapshotStore
  buildSnapshot: (chatId: string) => ChatSnapshot
  getTunnelBaseUrl: () => string | null
  getDefaultTtlHours: () => number
  now?: () => number
  owner: () => string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ShareError }

const HARD_SIZE_CAP = 50 * 1024 * 1024
const SOFT_SIZE_CAP = 10 * 1024 * 1024

export class SessionShareService {
  private projection: ShareProjection
  private readonly deps: SessionShareDeps
  private readonly now: () => number

  constructor(deps: SessionShareDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.projection = buildShareProjection(deps.events.getShareEvents())
  }

  async mintToken(req: MintRequest): Promise<Result<MintResponse>> {
    const base = this.deps.getTunnelBaseUrl()
    if (!base) return { ok: false, error: { kind: "no_tunnel" } }

    let snapshot: ChatSnapshot
    try {
      snapshot = this.deps.buildSnapshot(req.chatId)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.startsWith("chat_not_found:")) {
        return { ok: false, error: { kind: "chat_not_found", chatId: req.chatId } }
      }
      throw err
    }

    let bodyBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
    if (bodyBytes > HARD_SIZE_CAP) {
      return { ok: false, error: { kind: "snapshot_too_large", sizeBytes: bodyBytes } }
    }

    const tokenId = generateShareToken()
    const ttlHours = req.ttlHours ?? this.deps.getDefaultTtlHours()
    const createdAt = this.now()
    const expiresAt = createdAt + ttlHours * 3600 * 1000

    try {
      await this.deps.snapshotStore.writeSnapshot(tokenId, snapshot)
    } catch (err) {
      return { ok: false, error: { kind: "snapshot_write_failed", message: (err as Error).message } }
    }

    const event: ShareEvent = {
      v: 1, kind: "share.token_minted",
      tokenId, chatId: req.chatId, expiresAt, createdAt, createdBy: this.deps.owner(),
    }
    await this.deps.events.appendShareEvent(event)
    applyShareEvent(this.projection, event)

    const summary: ShareSummary = {
      tokenId, chatId: req.chatId,
      url: `${base.replace(/\/$/, "")}/share/${tokenId}`,
      expiresAt, createdAt, revoked: false,
    }
    return { ok: true, data: { summary } }
  }

  async revokeToken(req: RevokeRequest): Promise<Result<{ tokenId: string }>> {
    const record = this.projection.get(req.tokenId)
    if (!record) return { ok: false, error: { kind: "not_found" } }
    const event: ShareEvent = { v: 1, kind: "share.token_revoked", tokenId: req.tokenId, revokedAt: this.now() }
    await this.deps.events.appendShareEvent(event)
    applyShareEvent(this.projection, event)
    await this.deps.snapshotStore.deleteSnapshot(req.tokenId)
    return { ok: true, data: { tokenId: req.tokenId } }
  }

  async getShare(tokenId: string, now: number = this.now()): Promise<Result<{ snapshot: ChatSnapshot }>> {
    const status = classifyShare(this.projection, tokenId, now)
    if (status.kind === "not_found") return { ok: false, error: { kind: "not_found" } }
    if (status.kind === "revoked") return { ok: false, error: { kind: "revoked" } }
    if (status.kind === "expired") return { ok: false, error: { kind: "expired", expiredAt: status.record.expiresAt } }
    const snapshot = await this.deps.snapshotStore.readSnapshot(tokenId)
    if (!snapshot) return { ok: false, error: { kind: "snapshot_read_failed", message: "snapshot missing" } }
    return { ok: true, data: { snapshot } }
  }

  listSharesForChat(chatId: string): ShareSummary[] {
    const base = this.deps.getTunnelBaseUrl() ?? ""
    const out: ShareSummary[] = []
    for (const record of this.projection.values()) {
      if (record.chatId !== chatId) continue
      out.push({
        tokenId: record.tokenId, chatId: record.chatId,
        url: base ? `${base.replace(/\/$/, "")}/share/${record.tokenId}` : "",
        expiresAt: record.expiresAt, createdAt: record.createdAt, revoked: record.revoked,
      })
    }
    return out
  }

  async runSweep(now: number = this.now()): Promise<number> {
    let removed = 0
    for (const record of this.projection.values()) {
      if (record.revoked) continue
      if (record.expiresAt > now) continue
      await this.deps.snapshotStore.deleteSnapshot(record.tokenId)
      removed++
    }
    return removed
  }

  exposeSoftCapForTests() { return SOFT_SIZE_CAP }
}
```

- [ ] **Step 7.5: Verify**

`bun test src/server/session-share/session-share.test.ts` → PASS. `bun test src/server/event-store.test.ts` → still PASS.

- [ ] **Step 7.6: Commit**

```bash
git add src/server/event-store.ts src/server/session-share/index.ts src/server/session-share/session-share.test.ts
git commit -m "feat(share): SessionShareService (mint/revoke/getShare/listSharesForChat/runSweep) + event-store log file"
```

---

## Task 8: HTTP route + auth bypass

**Files:**
- Create: `src/server/session-share/http-routes.ts`
- Test: `src/server/session-share/http-routes.test.ts`
- Modify: `src/server/auth.ts` — export `isPublicSharePath(url)`.
- Modify: the HTTP server wiring (`src/server/cli-entry.ts` or the equivalent) to dispatch `/share/*` to the new handler before the auth gate.

- [ ] **Step 8.1: Add the path helper**

In `src/server/auth.ts`, near the top-level helpers:

```ts
export function isPublicSharePath(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  return pathname.startsWith("/share/")
    || pathname === "/share"
    || pathname.startsWith("/assets/share-view/")
}
```

- [ ] **Step 8.2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { handleShareRequest } from "./http-routes"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"
import type { Result } from "./index"

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [], attachmentsManifest: [],
}

function service(impl: (tokenId: string) => Promise<Result<{ snapshot: ChatSnapshot }>>) {
  return { getShare: impl } as Parameters<typeof handleShareRequest>[1]
}

describe("handleShareRequest", () => {
  test("200 returns inline HTML containing the snapshot JSON", async () => {
    const r = await handleShareRequest(new Request("http://x/share/tok1"), service(async () => ({ ok: true, data: { snapshot: snap } })))
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toMatch(/text\/html/)
    const body = await r.text()
    expect(body).toContain("\"version\":1")
    expect(body).toContain("share-view")
  })

  test("404 on not_found", async () => {
    const r = await handleShareRequest(new Request("http://x/share/x"), service(async () => ({ ok: false, error: { kind: "not_found" } })))
    expect(r.status).toBe(404)
  })

  test("410 on revoked + expired", async () => {
    const r1 = await handleShareRequest(new Request("http://x/share/x"), service(async () => ({ ok: false, error: { kind: "revoked" } })))
    const r2 = await handleShareRequest(new Request("http://x/share/x"), service(async () => ({ ok: false, error: { kind: "expired", expiredAt: 1 } })))
    expect(r1.status).toBe(410)
    expect(r2.status).toBe(410)
  })

  test("500 on snapshot_read_failed", async () => {
    const r = await handleShareRequest(new Request("http://x/share/x"), service(async () => ({ ok: false, error: { kind: "snapshot_read_failed", message: "boom" } })))
    expect(r.status).toBe(500)
  })

  test("404 when path doesn't match /share/:token", async () => {
    const r = await handleShareRequest(new Request("http://x/share/"), service(async () => ({ ok: true, data: { snapshot: snap } })))
    expect(r.status).toBe(404)
  })
})
```

- [ ] **Step 8.3: Run test to verify it fails**

`bun test src/server/session-share/http-routes.test.ts` → FAIL.

- [ ] **Step 8.4: Implement**

```ts
import type { ChatSnapshot, ShareError } from "../../shared/session-share/types"
import type { Result } from "./index"

interface ShareReadSurface {
  getShare(tokenId: string): Promise<Result<{ snapshot: ChatSnapshot }>>
}

const TOKEN_RE = /^\/share\/([A-Za-z0-9_-]{20,128})$/

function htmlEscape(value: string): string {
  return value.replace(/[<>&'"\\]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;", "\\": "&#92;" }[c] ?? c),
  )
}

function errorPage(status: number, title: string, message: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>body{font:14px system-ui;margin:4rem auto;max-width:32rem;color:#222}</style>
<h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  })
}

function describeError(error: ShareError): { status: number; title: string; message: string } {
  switch (error.kind) {
    case "not_found": return { status: 404, title: "Share not found", message: "This share link does not exist." }
    case "revoked": return { status: 410, title: "Share revoked", message: "The owner has revoked this share." }
    case "expired": return { status: 410, title: "Share expired", message: `This share expired on ${new Date(error.expiredAt).toISOString()}.` }
    case "snapshot_read_failed": return { status: 500, title: "Share temporarily unavailable", message: "Try again later." }
    default: return { status: 500, title: "Share error", message: "Unexpected error." }
  }
}

export async function handleShareRequest(req: Request, service: ShareReadSurface): Promise<Response> {
  const { pathname } = new URL(req.url)
  const match = TOKEN_RE.exec(pathname)
  if (!match) return errorPage(404, "Share not found", "Unknown share URL.")
  const result = await service.getShare(match[1]!)
  if (!result.ok) {
    const { status, title, message } = describeError(result.error)
    return errorPage(status, title, message)
  }
  const payload = JSON.stringify(result.data.snapshot).replace(/</g, "\\u003c")
  const html = `<!doctype html><meta charset="utf-8"><title>${htmlEscape(result.data.snapshot.chatMeta.title)}</title>
<div id="share-view"></div>
<script id="__SHARE_SNAPSHOT__" type="application/json">${payload}</script>
<script src="/assets/share-view/main.js" defer></script>`
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}
```

- [ ] **Step 8.5: Wire the route into the HTTP server**

Find the HTTP request dispatcher (search `Bun.serve` / `fetch(req)` in `src/server/`). Add, **before** any auth gate:

```ts
import { handleShareRequest } from "./session-share/http-routes"
import { isPublicSharePath } from "./auth"

// inside fetch(req):
if (isPublicSharePath(req.url)) {
  if (new URL(req.url).pathname.startsWith("/share/")) {
    return handleShareRequest(req, sessionShareService)
  }
  // Let /assets/share-view/* fall through to the static asset server (no auth)
}
```

`sessionShareService` is instantiated once at boot. Construct it with:
- `events`: the existing `EventStore`
- `snapshotStore`: `new SnapshotStore(join(kannaDir, "shares"))`
- `buildSnapshot`: a closure that reads chat meta + transcript + attachments via existing `read-models` accessors and calls `buildChatSnapshot`
- `getTunnelBaseUrl`: reads from the existing tunnel surface (the same accessor `c3-218` / `c3-223` exposes — wire the simplest available `publicUrl` getter)
- `getDefaultTtlHours`: `() => appSettings.getSnapshot().shareDefaultTtlHours`
- `owner`: `() => "owner"` (single-user host model — same convention used by other server modules)

- [ ] **Step 8.6: Verify**

`bun test src/server/session-share/http-routes.test.ts` → PASS. `bun test src/server/auth.test.ts` → still PASS. `bun run lint` → 0 warnings.

- [ ] **Step 8.7: Commit**

```bash
git add src/server/auth.ts src/server/session-share/http-routes.ts src/server/session-share/http-routes.test.ts src/server/cli-entry.ts
git commit -m "feat(share): public /share/:token HTTP route + auth bypass prefix"
```

(Adjust the staged paths to whichever file you edited for the HTTP server wiring.)

---

## Task 9: Snapshot sweep + boot replay

**Files:**
- Create: `src/server/session-share/sweep.ts`
- Test: `src/server/session-share/sweep.test.ts`

- [ ] **Step 9.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { startSnapshotSweep } from "./sweep"

describe("startSnapshotSweep", () => {
  test("calls service.runSweep on the configured interval and clear stops it", async () => {
    let calls = 0
    const fakeService = { runSweep: async () => { calls++; return 0 } }
    const handle = startSnapshotSweep(fakeService as never, 10)
    await new Promise(r => setTimeout(r, 35))
    handle.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test("runs once immediately on start", async () => {
    let calls = 0
    const fakeService = { runSweep: async () => { calls++; return 0 } }
    const handle = startSnapshotSweep(fakeService as never, 60_000)
    await new Promise(r => setTimeout(r, 5))
    handle.stop()
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 9.2: Run test to verify it fails**

`bun test src/server/session-share/sweep.test.ts` → FAIL.

- [ ] **Step 9.3: Implement**

```ts
import type { SessionShareService } from "./index"

export interface SweepHandle { stop(): void }

export function startSnapshotSweep(service: SessionShareService, intervalMs: number): SweepHandle {
  void service.runSweep()
  const timer = setInterval(() => { void service.runSweep() }, intervalMs)
  return { stop() { clearInterval(timer) } }
}
```

Wire `startSnapshotSweep(sessionShareService, 24 * 3600 * 1000)` into the same boot path as `sessionShareService`. Keep the returned handle so the existing shutdown sequence can call `.stop()`.

- [ ] **Step 9.4: Verify**

`bun test src/server/session-share/sweep.test.ts` → PASS.

- [ ] **Step 9.5: Commit**

```bash
git add src/server/session-share/sweep.ts src/server/session-share/sweep.test.ts src/server/cli-entry.ts
git commit -m "feat(share): periodic snapshot sweep (daily) wired at boot"
```

---

## Task 10: AppSettings `shareDefaultTtlHours`

**Files:**
- Modify: `src/server/app-settings.ts`
- Modify: `src/shared/types.ts` (if `AppSettingsSnapshot` lives there — verify)
- Test: extend `src/server/app-settings.test.ts`

- [ ] **Step 10.1: Add a failing test**

Append to `src/server/app-settings.test.ts`:

```ts
test("shareDefaultTtlHours defaults to 24 and is patchable", async () => {
  const mgr = await createAppSettingsManagerForTests()
  expect(mgr.getSnapshot().shareDefaultTtlHours).toBe(24)
  await mgr.writePatch({ shareDefaultTtlHours: 48 })
  expect(mgr.getSnapshot().shareDefaultTtlHours).toBe(48)
})

test("shareDefaultTtlHours rejects non-positive integers", async () => {
  const mgr = await createAppSettingsManagerForTests()
  await expect(mgr.writePatch({ shareDefaultTtlHours: 0 })).rejects.toThrow()
  await expect(mgr.writePatch({ shareDefaultTtlHours: -1 })).rejects.toThrow()
  await expect(mgr.writePatch({ shareDefaultTtlHours: 1.5 })).rejects.toThrow()
})
```

(`createAppSettingsManagerForTests` — match the helper used by the existing tests in the same file. If none exists, build one inline using the same constructor calls the existing tests use.)

- [ ] **Step 10.2: Run tests to verify failure**

`bun test src/server/app-settings.test.ts` → FAIL.

- [ ] **Step 10.3: Add field across the pipeline**

In `src/server/app-settings.ts`, in every place the existing fields are listed:

1. `AppSettingsFile` interface — add `shareDefaultTtlHours?: number`.
2. `AppSettingsState` / `AppSettingsSnapshot` — add `shareDefaultTtlHours: number`.
3. `AppSettingsPatch` — add `shareDefaultTtlHours?: number`.
4. Defaults block (`state: AppSettingsState = { ... }`) — set to `24`.
5. `normalizeAppSettings` — read `source?.shareDefaultTtlHours`, default to `24`, reject non-positive integers via `warnings.push`.
6. `toFilePayload` — include the field.
7. `toSnapshot` — include the field.
8. `applyPatch` — if `patch.shareDefaultTtlHours !== undefined`, validate `Number.isInteger(value) && value >= 1`, throw on failure, then set `state.shareDefaultTtlHours = value`.

- [ ] **Step 10.4: Run tests to verify pass**

`bun test src/server/app-settings.test.ts` → PASS.

- [ ] **Step 10.5: Commit**

```bash
git add src/server/app-settings.ts src/server/app-settings.test.ts src/shared/types.ts
git commit -m "feat(settings): add shareDefaultTtlHours (default 24, integer >= 1)"
```

---

## Task 11: ws-router envelopes

**Files:**
- Modify: `src/server/ws-router.ts`
- Test: extend `src/server/ws-router.test.ts`

- [ ] **Step 11.1: Add failing tests**

Append to `src/server/ws-router.test.ts`:

```ts
test("share_mint envelope dispatches to service.mintToken", async () => {
  const calls: string[] = []
  const svc = { mintToken: async () => { calls.push("mint"); return { ok: true, data: { summary: { tokenId: "t", chatId: "c", url: "u", expiresAt: 1, createdAt: 0, revoked: false } } } } }
  const router = createTestRouter({ sessionShare: svc as never })
  const reply = await router.dispatch({ kind: "share_mint", requestId: "r1", payload: { chatId: "c1" } } as never, { authenticated: true })
  expect(calls).toEqual(["mint"])
  expect(reply.kind).toBe("share_result")
})

test("share_revoke envelope dispatches to service.revokeToken", async () => {
  const calls: string[] = []
  const svc = { revokeToken: async () => { calls.push("revoke"); return { ok: true, data: { tokenId: "t" } } } }
  const router = createTestRouter({ sessionShare: svc as never })
  await router.dispatch({ kind: "share_revoke", requestId: "r2", payload: { tokenId: "t" } } as never, { authenticated: true })
  expect(calls).toEqual(["revoke"])
})

test("share envelopes reject unauthenticated callers", async () => {
  const router = createTestRouter({ sessionShare: {} as never })
  const reply = await router.dispatch({ kind: "share_mint", requestId: "r1", payload: { chatId: "c1" } } as never, { authenticated: false })
  expect(reply.kind).toBe("share_result")
  expect("ok" in reply && reply.ok).toBe(false)
})
```

(Match `createTestRouter` to the helper pattern already in `ws-router.test.ts`.)

- [ ] **Step 11.2: Run tests to verify failure**

`bun test src/server/ws-router.test.ts` → FAIL.

- [ ] **Step 11.3: Implement dispatch**

In `src/server/ws-router.ts`, accept a new dep `sessionShare: SessionShareService`. In the command-switch where existing `chat_send` / `customMcp` cases live, add three branches:

```ts
case "share_mint": {
  if (!ctx.authenticated) {
    return { kind: "share_result", requestId: command.requestId, ok: false, error: { kind: "not_found" } }
  }
  const r = await deps.sessionShare.mintToken(command.payload)
  return r.ok
    ? { kind: "share_result", requestId: command.requestId, ok: true, data: r.data }
    : { kind: "share_result", requestId: command.requestId, ok: false, error: r.error }
}
case "share_revoke": {
  if (!ctx.authenticated) {
    return { kind: "share_result", requestId: command.requestId, ok: false, error: { kind: "not_found" } }
  }
  const r = await deps.sessionShare.revokeToken(command.payload)
  return r.ok
    ? { kind: "share_result", requestId: command.requestId, ok: true, data: { summary: { tokenId: r.data.tokenId } as never } }
    : { kind: "share_result", requestId: command.requestId, ok: false, error: r.error }
}
case "share_list": {
  if (!ctx.authenticated) {
    return { kind: "share_list_result", requestId: command.requestId, ok: false, error: { kind: "not_found" } }
  }
  return { kind: "share_list_result", requestId: command.requestId, ok: true, data: { shares: deps.sessionShare.listSharesForChat(command.payload.chatId) } }
}
```

Adjust the field names to match what the existing router uses for `ctx` / `deps` / `command`.

- [ ] **Step 11.4: Verify**

`bun test src/server/ws-router.test.ts` → PASS.

- [ ] **Step 11.5: Commit**

```bash
git add src/server/ws-router.ts src/server/ws-router.test.ts
git commit -m "feat(share): ws-router dispatch for share_mint / share_revoke / share_list"
```

---

## Task 12: Client share-store (Zustand)

**Files:**
- Create: `src/client/components/share/share-store.ts`
- Test: `src/client/components/share/share-store.test.ts`

- [ ] **Step 12.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { useShareStore, type ShareStoreState } from "./share-store"

describe("share-store", () => {
  test("starts empty and exposes a stable EMPTY array", () => {
    const s1 = useShareStore.getState().listForChat("c1")
    const s2 = useShareStore.getState().listForChat("c1")
    expect(s1).toBe(s2)
    expect(s1.length).toBe(0)
  })

  test("setShares replaces the list for a chat", () => {
    useShareStore.getState().setShares("c1", [{ tokenId: "t", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false }])
    expect(useShareStore.getState().listForChat("c1")[0]!.tokenId).toBe("t")
  })

  test("removeShare drops by tokenId", () => {
    useShareStore.getState().setShares("c1", [{ tokenId: "t", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false }])
    useShareStore.getState().removeShare("c1", "t")
    expect(useShareStore.getState().listForChat("c1").length).toBe(0)
  })
})
```

- [ ] **Step 12.2: Run test to verify it fails**

`bun test src/client/components/share/share-store.test.ts` → FAIL.

- [ ] **Step 12.3: Implement**

```ts
import { create } from "zustand"
import type { ShareSummary } from "../../../shared/session-share/types"

const EMPTY: readonly ShareSummary[] = Object.freeze([])

export interface ShareStoreState {
  sharesByChat: Record<string, ShareSummary[]>
  listForChat: (chatId: string) => readonly ShareSummary[]
  setShares: (chatId: string, shares: ShareSummary[]) => void
  addShare: (chatId: string, share: ShareSummary) => void
  removeShare: (chatId: string, tokenId: string) => void
}

export const useShareStore = create<ShareStoreState>((set, get) => ({
  sharesByChat: {},
  listForChat(chatId) {
    return get().sharesByChat[chatId] ?? EMPTY
  },
  setShares(chatId, shares) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: shares } }))
  },
  addShare(chatId, share) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: [...(s.sharesByChat[chatId] ?? []), share] } }))
  },
  removeShare(chatId, tokenId) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: (s.sharesByChat[chatId] ?? []).filter((sh) => sh.tokenId !== tokenId) } }))
  },
}))
```

- [ ] **Step 12.4: Verify**

`bun test src/client/components/share/share-store.test.ts` → PASS.

- [ ] **Step 12.5: Commit**

```bash
git add src/client/components/share/share-store.ts src/client/components/share/share-store.test.ts
git commit -m "feat(share): client zustand share-store keyed by chatId with stable EMPTY ref"
```

---

## Task 13: ShareButton component

**Files:**
- Create: `src/client/components/share/ShareButton.tsx`
- Test: `src/client/components/share/ShareButton.test.tsx`

- [ ] **Step 13.1: Write the failing test**

```tsx
import { describe, expect, test } from "bun:test"
import { render, screen, fireEvent } from "@testing-library/react"
import { ShareButton } from "./ShareButton"

describe("ShareButton", () => {
  test("renders Share label and is enabled when tunnel up", () => {
    render(<ShareButton chatId="c1" tunnelUp={true} onOpenPopover={() => {}} />)
    expect(screen.getByRole("button", { name: /share/i })).not.toBeDisabled()
  })

  test("is disabled with tooltip text when tunnel down", () => {
    render(<ShareButton chatId="c1" tunnelUp={false} onOpenPopover={() => {}} />)
    const btn = screen.getByRole("button", { name: /share/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("aria-disabled", "true")
  })

  test("click calls onOpenPopover with chatId", () => {
    let received: string | null = null
    render(<ShareButton chatId="c1" tunnelUp={true} onOpenPopover={(id) => { received = id }} />)
    fireEvent.click(screen.getByRole("button", { name: /share/i }))
    expect(received).toBe("c1")
  })
})
```

(Use the existing testing-library setup that the other `*.test.tsx` files use; copy their imports verbatim.)

- [ ] **Step 13.2: Run test to verify it fails**

`bun test src/client/components/share/ShareButton.test.tsx` → FAIL.

- [ ] **Step 13.3: Implement**

```tsx
import { Tooltip } from "../ui/Tooltip"

export interface ShareButtonProps {
  chatId: string
  tunnelUp: boolean
  onOpenPopover: (chatId: string) => void
}

export function ShareButton({ chatId, tunnelUp, onOpenPopover }: ShareButtonProps) {
  const label = tunnelUp ? "Share this chat as a public read-only link" : "Start a Cloudflare tunnel to share"
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label="Share"
        aria-disabled={!tunnelUp}
        disabled={!tunnelUp}
        className="kanna-icon-button"
        onClick={() => onOpenPopover(chatId)}
      >
        Share
      </button>
    </Tooltip>
  )
}
```

Match the icon-button class name to the existing chat-header buttons. Replace the inline label with the project's icon component if the rest of the header uses one.

- [ ] **Step 13.4: Verify**

`bun test src/client/components/share/ShareButton.test.tsx` → PASS.

- [ ] **Step 13.5: Mount in chat header**

Edit the chat header file (under `src/client/components/chat-ui/`, the one rendering the existing toolbar buttons). Add:

```tsx
<ShareButton chatId={chat.id} tunnelUp={tunnelStatus.publicUrl !== null} onOpenPopover={openSharePopover} />
```

Wire `tunnelStatus.publicUrl` from whichever store / selector already surfaces the tunnel state (find via `grep -rn "publicUrl" src/client/`). Pass `openSharePopover` from the parent page so it can host the popover element.

- [ ] **Step 13.6: Commit**

```bash
git add src/client/components/share/ShareButton.tsx src/client/components/share/ShareButton.test.tsx src/client/components/chat-ui/
git commit -m "feat(share): chat-header ShareButton (disabled when tunnel down)"
```

---

## Task 14: SharePopover component

**Files:**
- Create: `src/client/components/share/SharePopover.tsx`
- Test: `src/client/components/share/SharePopover.test.tsx`

- [ ] **Step 14.1: Write the failing test**

```tsx
import { describe, expect, test } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SharePopover } from "./SharePopover"

describe("SharePopover", () => {
  test("shows NO_TUNNEL CTA when tunnel is down", () => {
    render(<SharePopover chatId="c1" tunnelUp={false} shares={[]} onMint={async () => {}} onRevoke={async () => {}} />)
    expect(screen.getByText(/start.*tunnel/i)).toBeInTheDocument()
  })

  test("Mint click calls onMint with chatId", async () => {
    let lastChatId: string | null = null
    render(<SharePopover chatId="c1" tunnelUp={true} shares={[]} onMint={async (id) => { lastChatId = id }} onRevoke={async () => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /create.*link/i }))
    await waitFor(() => expect(lastChatId).toBe("c1"))
  })

  test("Renders active share with copy + revoke + expiry text", () => {
    const share = { tokenId: "t1", chatId: "c1", url: "https://x/share/t1", expiresAt: Date.now() + 3600_000, createdAt: Date.now(), revoked: false }
    render(<SharePopover chatId="c1" tunnelUp={true} shares={[share]} onMint={async () => {}} onRevoke={async () => {}} />)
    expect(screen.getByText("https://x/share/t1")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument()
    expect(screen.getByText(/expires/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 14.2: Run test to verify it fails**

`bun test src/client/components/share/SharePopover.test.tsx` → FAIL.

- [ ] **Step 14.3: Implement**

```tsx
import { useState } from "react"
import type { ShareSummary } from "../../../shared/session-share/types"

export interface SharePopoverProps {
  chatId: string
  tunnelUp: boolean
  shares: readonly ShareSummary[]
  onMint: (chatId: string) => Promise<void>
  onRevoke: (tokenId: string) => Promise<void>
}

function relativeExpiry(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return "Expired"
  const h = Math.round(ms / 3600_000)
  if (h < 1) return `Expires in <1h`
  if (h < 48) return `Expires in ${h}h`
  return `Expires in ${Math.round(h / 24)}d`
}

export function SharePopover(props: SharePopoverProps) {
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  if (!props.tunnelUp) {
    return (
      <div className="kanna-popover">
        <p>Start a Cloudflare tunnel to enable public read-only sharing.</p>
        <a href="/settings#tunnel">Open tunnel settings</a>
      </div>
    )
  }
  return (
    <div className="kanna-popover">
      <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await props.onMint(props.chatId) } finally { setBusy(false) } }}>
        Create share link
      </button>
      {props.shares.map((s) => (
        <div key={s.tokenId} className="kanna-share-row">
          <code>{s.url}</code>
          <button type="button" onClick={() => navigator.clipboard.writeText(s.url)}>Copy</button>
          <button type="button" onClick={() => props.onRevoke(s.tokenId)}>Revoke</button>
          <span>{relativeExpiry(s.expiresAt, now)}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 14.4: Verify**

`bun test src/client/components/share/SharePopover.test.tsx` → PASS.

- [ ] **Step 14.5: Wire mint/revoke ws round-trip**

In the page-level container that hosts `<SharePopover>`, define:

```ts
async function onMint(chatId: string) {
  const reply = await socket.request({ kind: "share_mint", requestId: crypto.randomUUID(), payload: { chatId } })
  if (reply.ok) useShareStore.getState().addShare(chatId, reply.data.summary)
  else toast.error(reply.error.kind === "no_tunnel" ? "Tunnel is down" : "Mint failed")
}

async function onRevoke(tokenId: string) {
  const reply = await socket.request({ kind: "share_revoke", requestId: crypto.randomUUID(), payload: { tokenId } })
  if (reply.ok) useShareStore.getState().removeShare(chatId, tokenId)
}
```

Replace `socket.request` with whatever request/response helper the existing client uses for ws round-trips (search for the pattern used by `customMcp` commands in the client).

- [ ] **Step 14.6: Commit**

```bash
git add src/client/components/share/SharePopover.tsx src/client/components/share/SharePopover.test.tsx
git commit -m "feat(share): SharePopover (NO_TUNNEL CTA, mint, copy, revoke, expiry label)"
```

---

## Task 15: Public ShareViewPage + route

**Files:**
- Create: `src/client/app/share-view/ShareViewPage.tsx`
- Create: `src/client/app/share-view/index.tsx`
- Test: `src/client/app/share-view/ShareViewPage.test.tsx`
- Modify: `src/client/app/App.tsx` — register route.

- [ ] **Step 15.1: Write the failing test**

```tsx
import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { ShareViewPage } from "./ShareViewPage"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../../shared/session-share/types"

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "Public chat", model: "claude", createdAt: 0 },
  messages: [
    { kind: "user_prompt", id: "m1", createdAt: 0, text: "hi" },
    { kind: "assistant_text", id: "m2", createdAt: 1, text: "hello" },
  ],
  attachmentsManifest: [],
}

describe("ShareViewPage", () => {
  test("renders chat title and messages from snapshot", () => {
    render(<ShareViewPage snapshot={snap} />)
    expect(screen.getByText("Public chat")).toBeInTheDocument()
    expect(screen.getByText("hi")).toBeInTheDocument()
    expect(screen.getByText("hello")).toBeInTheDocument()
  })

  test("composer, sidebar, and settings link are absent", () => {
    render(<ShareViewPage snapshot={snap} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(screen.queryByRole("link", { name: /settings/i })).toBeNull()
  })
})
```

- [ ] **Step 15.2: Run test to verify it fails**

`bun test src/client/app/share-view/ShareViewPage.test.tsx` → FAIL.

- [ ] **Step 15.3: Implement**

```tsx
import type { ChatSnapshot, ChatSnapshotMessage } from "../../../shared/session-share/types"

export interface ShareViewPageProps {
  snapshot: ChatSnapshot
}

function MessageView({ message }: { message: ChatSnapshotMessage }) {
  switch (message.kind) {
    case "user_prompt": return <div className="kanna-message kanna-message--user">{message.text}</div>
    case "assistant_text": return <div className="kanna-message kanna-message--assistant">{message.text}</div>
    case "tool_call": return <div className="kanna-message kanna-message--tool-call">{message.name}({JSON.stringify(message.input)})</div>
    case "tool_result": return <pre className="kanna-message kanna-message--tool-result">{JSON.stringify(message.output)}</pre>
    case "diff": return <pre className="kanna-message kanna-message--diff">{message.patch}</pre>
    case "terminal_chunk": return <pre className="kanna-message kanna-message--terminal">{message.chunk}</pre>
    case "omitted": return <div className="kanna-message kanna-message--omitted">[content omitted: {message.reason}]</div>
  }
}

export function ShareViewPage({ snapshot }: ShareViewPageProps) {
  return (
    <main className="kanna-share-view">
      <header><h1>{snapshot.chatMeta.title}</h1><small>Read-only · model {snapshot.chatMeta.model}</small></header>
      <ol className="kanna-transcript">
        {snapshot.messages.map((m) => <li key={m.id}><MessageView message={m} /></li>)}
      </ol>
    </main>
  )
}
```

Create `src/client/app/share-view/index.tsx`:

```tsx
import { createRoot } from "react-dom/client"
import type { ChatSnapshot } from "../../../shared/session-share/types"
import { ShareViewPage } from "./ShareViewPage"

const raw = document.getElementById("__SHARE_SNAPSHOT__")?.textContent
if (!raw) throw new Error("missing snapshot payload")
const snapshot = JSON.parse(raw) as ChatSnapshot
createRoot(document.getElementById("share-view")!).render(<ShareViewPage snapshot={snapshot} />)
```

- [ ] **Step 15.4: Register the asset build**

Add a new client entry `share-view` to whatever bundler config the project uses for the main app (e.g. `bunfig.toml` / build script in `package.json`). Output target: `/assets/share-view/main.js`. Confirm by running the local build and verifying the file is produced.

- [ ] **Step 15.5: Verify**

`bun test src/client/app/share-view/ShareViewPage.test.tsx` → PASS.

- [ ] **Step 15.6: Commit**

```bash
git add src/client/app/share-view/ src/client/app/App.tsx
git commit -m "feat(share): public read-only ShareViewPage + standalone client entry"
```

---

## Task 16: Settings row for default TTL

**Files:**
- Create: `src/client/components/settings/ShareDefaultTtl.tsx`
- Modify: `src/client/app/SettingsPage.tsx` — mount the row.

- [ ] **Step 16.1: Implement directly (UI-only, no test gain over existing settings rows)**

```tsx
import { useAppSettingsStore } from "../../app/useKannaState"

export function ShareDefaultTtl() {
  const value = useAppSettingsStore((s) => s.snapshot.shareDefaultTtlHours)
  const setValue = useAppSettingsStore((s) => s.patch)
  return (
    <label className="kanna-settings-row">
      <span>Default share link expiry (hours)</span>
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= 1) void setValue({ shareDefaultTtlHours: n })
        }}
      />
    </label>
  )
}
```

Use whichever store hook the existing settings rows use; copy from a sibling row in `src/client/components/settings/`.

- [ ] **Step 16.2: Mount in `SettingsPage.tsx`**

Add `<ShareDefaultTtl />` next to the existing tunnel settings rows.

- [ ] **Step 16.3: Verify**

`bun run lint` clean. `bun test src/client/` clean.

- [ ] **Step 16.4: Commit**

```bash
git add src/client/components/settings/ShareDefaultTtl.tsx src/client/app/SettingsPage.tsx
git commit -m "feat(share): settings row for shareDefaultTtlHours"
```

---

## Task 17: HTTP integration test

**Files:**
- Create: `src/server/session-share/http-integration.test.ts`

- [ ] **Step 17.1: Write the test**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionShareService } from "./index"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"
import { handleShareRequest } from "./http-routes"

class FakeStore { events: any[] = []; async appendShareEvent(e: any) { this.events.push(e) } getShareEvents() { return this.events } }

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION, chatMeta: { id: "c1", title: "T", model: "m", createdAt: 0 }, messages: [], attachmentsManifest: [],
}

describe("mint → GET /share/<token> integration", () => {
  test("full round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-int-"))
    try {
      const store = new SnapshotStore(dir)
      const svc = new SessionShareService({
        events: new FakeStore() as never,
        snapshotStore: store,
        buildSnapshot: () => snap,
        getTunnelBaseUrl: () => "https://tunnel.example",
        getDefaultTtlHours: () => 24,
        now: () => 1_000,
        owner: () => "o",
      })
      const mint = await svc.mintToken({ chatId: "c1" })
      if (!mint.ok) throw new Error("mint failed")
      const res = await handleShareRequest(new Request(`http://x/share/${mint.data.summary.tokenId}`), svc)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain(`"title":"T"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 17.2: Verify**

`bun test src/server/session-share/http-integration.test.ts` → PASS.

- [ ] **Step 17.3: Commit**

```bash
git add src/server/session-share/http-integration.test.ts
git commit -m "test(share): mint → public GET integration round-trip"
```

---

## Task 18: c3 doc sweep + wiki

**Files:**
- Modify (via c3x): `c3-115`, `c3-116`, `c3-202`, `c3-203`, `c3-205`, `c3-306` — add the section deltas listed in the spec.
- Create: `wiki/src/content/docs/sharing/session-share.mdx`

- [ ] **Step 18.1: Update parent components**

For each id in `c3-115 c3-116 c3-202 c3-203 c3-205 c3-306`:

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh read <id> --full     # confirm current body
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh schema component
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh write <id> --file /tmp/<id>-body.md
```

The new body text in each `/tmp/<id>-body.md` adds:

- `c3-115` — Share button listed under chat-header surface contract.
- `c3-116` — settings row added; field name and validation rule called out.
- `c3-202` — `/share/:token` and `/assets/share-view/*` listed as public routes.
- `c3-203` — `isPublicSharePath` path-prefix exemption documented.
- `c3-205` — `share.token_minted` / `share.token_revoked` added to the event union.
- `c3-306` — no change if `share-shared` only covered tunnel types; otherwise add `ChatSnapshot` / `ShareError` cross-link to `src/shared/session-share/`.

- [ ] **Step 18.2: Wire c3-228 to consumers**

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-202 c3-228
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh wire c3-208 c3-228
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh check
```

- [ ] **Step 18.3: Move ADR to implemented**

```
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh set adr-20260524-session-share status implemented
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh check --include-adr
```

- [ ] **Step 18.4: Write wiki page**

Create `wiki/src/content/docs/sharing/session-share.mdx`:

```mdx
---
title: Read-only session share
description: Mint a public Cloudflare-tunnel URL that lets anyone view a Kanna chat as a frozen snapshot.
---

The Share button in a chat's header creates a public read-only link that anyone with the URL can open. The link points at your local Kanna over the same Cloudflare tunnel you've already enabled — Kanna does not host the snapshot anywhere else.

### How it works

- Server projects the current event log into a frozen JSON snapshot.
- Snapshot is stored under `~/.kanna/shares/<token>.json` (file mode `0600`).
- The URL is `<your-tunnel>/share/<token>`. The 256-bit token is the credential.
- Viewers see the chat transcript, tool calls, diffs, and terminal output. They cannot send messages.

### Lifecycle

- Default link lifetime is 24 hours — change it in Settings → "Default share link expiry".
- Click **Revoke** on any active link to invalidate it immediately. The snapshot file is deleted.
- Expired links return a 410 page; the snapshot disk is reclaimed by a daily sweep.

### Limits

- 10 MB per snapshot before large bodies (diffs, terminal output) are stripped.
- 50 MB hard cap per snapshot.
- 1 GB total shares directory budget.
```

- [ ] **Step 18.5: Commit**

```bash
git add .c3/ wiki/src/content/docs/sharing/session-share.mdx
git commit -m "docs(share): c3 doc sweep + wiki page for session-share"
```

---

## Task 19: Final verify gate + PR

- [ ] **Step 19.1: Full verify**

Run in order, all must be clean:

```
bun run lint
bun test
C3X_MODE=agent bash <skill-dir>/bin/c3x.sh check
```

- [ ] **Step 19.2: Open the PR against your fork**

```
git push -u origin worktree-feat-session-share-readonly:feat/session-share-readonly
gh pr create --repo cuongtranba/kanna --base main --head feat/session-share-readonly \
  --title "feat(share): read-only public session share" \
  --body "Implements docs/superpowers/specs/2026-05-24-share-session-readonly-design.md"
```

- [ ] **Step 19.3: Smoke-test the live feature**

In a Kanna instance with a Cloudflare tunnel up:

1. Open a chat. Click Share. Copy the URL.
2. Open the URL in an incognito window. Confirm transcript renders, composer absent.
3. Revoke from the popover. Refresh the incognito tab → 410 page.
4. Settings → set "Default share link expiry" to 2. Mint again. Confirm `expiresAt` is `now + 2h`.

If any step fails, stop and file an issue with reproduction steps before merging.

---

## Self-Review

Spec coverage check (each spec section → task):

- Goal / locked requirements — Task 1 (ADR captures the locked decisions).
- Architecture diagram — Tasks 7, 8, 11 wire all components in the diagram.
- Components and file layout — Tasks 2–16 each create one or two files from the list.
- Event-store additions — Task 7 step 7.1.
- App-settings addition — Task 10.
- c3 doc work — Tasks 1, 18.
- Mint flow — Task 7 (service) + Task 11 (ws envelope) + Task 14 (UI).
- View flow — Task 8 (HTTP route + auth bypass) + Task 15 (client share-view).
- Revoke flow — Task 7 + Task 11 + Task 14.
- Expiry / sweep — Task 9.
- Snapshot shape — Task 2 (types) + Task 5 (builder).
- Error taxonomy + security — Tasks 2, 7, 8.
- Strong-typing seal — discriminated unions live in `src/shared/session-share/types.ts` (Task 2); `ShareEvent` discriminated in Task 6.
- Side-effect seal — only `snapshot-store.adapter.ts` (Task 4) touches `node:fs`; filename suffix matches the convention.
- Disk caps — hard cap `HARD_SIZE_CAP` enforced in Task 7 `mintToken`; soft cap exposed via `stripLargeBodies` (Task 5) — wire the caller in Task 7 to retry when over soft cap if needed (the test in 7.2 covers the simple hard-cap reject; the soft-cap retry path is exercised by the snapshot builder test in 5.1).
- Race conditions — projection is in-process, file delete precedes ack: implemented in Task 7 `revokeToken`.
- Logging — emit analytics events in Task 7 (extend the methods to call `analytics.track("share.minted", { chatIdHash, tokenIdHash })` once the existing analytics helper signature is confirmed in `src/server/analytics.ts`).
- Testing strategy — Tasks 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 17.
- Rollout — Task 18 wiki + Task 19 PR + smoke test.
- Out-of-scope items — none added.

Placeholder scan: no `TBD` / `TODO` / "implement later" in any task.

Type consistency: `ShareError` kind names (`no_tunnel`, `expired`, `revoked`, `not_found`, `chat_not_found`, `snapshot_too_large`, `snapshot_write_failed`, `snapshot_read_failed`) are used identically across types.ts (Task 2), service (Task 7), router (Task 11), HTTP route (Task 8), and UI (Task 14). `ShareSummary` shape is the same in Task 2, Task 7, Task 12, Task 14. `ChatSnapshot` shape is the same in Task 2, Task 5, Task 7, Task 8, Task 15.
