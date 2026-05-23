# Architecture

This project uses C3 docs in `.c3/`.

**MANDATORY for Claude Code AND Codex:**
1. **Before coding** — run `/c3 query <topic>` (or `c3x lookup <file>`) to load
   component context, refs, and rules. Do NOT skip even for "small" edits.
   Skipping = stale assumptions = wrong patches.
2. **After coding** — if change touches component boundaries, refs, public
   contracts, or rules, run `/c3 change` (or `/c3 sweep` for audit) to update
   `.c3/` docs in the SAME PR. Code-doc drift is a blocker.
3. **Architecture questions, audits, file→component lookup** — always `/c3`.

Operations: query, audit, change, ref, sweep.
File lookup: `c3x lookup <file-or-glob>` maps files/directories to components + refs.
Skill: `c3-skill:c3` (auto-triggers on `/c3` or architecture phrases).

# Pull Requests

This is a fork. `origin` = `cuongtranba/kanna` (mine), `upstream` = `jakemor/kanna`.
PRs MUST target `cuongtranba/kanna`, never `jakemor/kanna`.
`gh repo set-default cuongtranba/kanna` is set; always pass `--repo cuongtranba/kanna`
or `--base main --head <branch>` to `gh pr create` to make the target explicit.

# Lint

`bun run lint` runs ESLint on `src/` with `--max-warnings=0`. CI runs it
before tests; merges blocked on lint errors AND on any warning count above
the cap. The cap is a ratchet: when warnings drop, lower the cap in the
same PR so they cannot creep back up. Plugin `react-hooks` (set 7+) enforces
React 19 rules: `rules-of-hooks`, `purity`, `globals` are errors;
`set-state-in-effect`, `refs`, `immutability`, `preserve-manual-memoization`,
`exhaustive-deps` are warnings.

# Side-Effect Lint (ports-and-adapters seal)

Side effects (`node:fs`, `chokidar`, `bun:sqlite`/`better-sqlite3`/`pg`,
`node:child_process`, `node:http`/`https`, `Bun.spawn`/`Bun.$`/`Bun.file`,
`new Database`, `process.exit`, `process.env`) are **sealed at `error`
across both `src/shared/**` + `src/client/**` AND `src/server/**`
production code**.

`no-restricted-imports` + `no-restricted-globals` + `no-restricted-syntax`
in `eslint.config.js` make every flagged import / global / call fail
`bun run lint`. Browser-native `fetch` is intentionally allowed in
shared/client. There is no escape valve; do not add `eslint-disable`
comments.

**Server layer exempt globs** (where direct IO is allowed):
`src/server/**/*.test.ts(x)`, `src/server/__fixtures__/**`,
`src/server/test-helpers/**`, `src/server/adapters/**`, and any file
matching `src/server/**/*.adapter.ts`.

**`.adapter.ts` filename convention.** Any file whose single
responsibility is to perform the side effect on behalf of a port
interface MUST be suffixed `.adapter.ts` and colocated next to its
port. Mixed-concern modules (domain logic + IO) extract their IO into
a sibling `*-io.adapter.ts` instead of renaming the parent.

**Adding new IO.** New IO requires either (1) putting the call in a
file matching one of the exempt globs above, or (2) injecting the
operation through a typed parameter / port interface. Adapter files
are leaf modules — they wrap one node/Bun primitive and have no
domain logic, so they are safe to import from anywhere that needs
the operation.

Authored across PRs #283 (pure-layer seal), #285 (paths-config
purify), #286 (call-site selectors), #287 (ratchet infrastructure),
#288–#302 (burn-down 90 → 0), and the final flip (server override
moved to `error` + ratchet tooling deleted).

# Render-loop regression checks

When introducing a new `use*Store` selector or any React hook that derives
collections, the selector MUST return a stable reference. Inline `?? []` or
`?? {}` produces fresh refs each call and triggers React error #185
(`Maximum update depth exceeded`). Pattern to use:

```ts
const EMPTY: Subagent[] = []
useStore((state) => state.list ?? EMPTY)
// or
useStore(useShallow((state) => state.list ?? []))
```

Tests can mount a component with effects and assert no loop warnings via
`renderForLoopCheck` in `src/client/lib/testing/`.

# Tool Callback Feature Flag (KANNA_MCP_TOOL_CALLBACKS)

Setting `KANNA_MCP_TOOL_CALLBACKS=1` routes `AskUserQuestion` and
`ExitPlanMode` through the durable approval protocol in
`src/server/tool-callback.ts`. Pending requests survive server restart
(resolved as `session_closed` fail-closed on boot) and are replayed to the
client on reconnect as `pending_tool_request` transcript entries. Default is
off; the SDK driver uses the legacy `canUseTool` → `onToolRequest` path.

**PTY exception (issue #215):** under `KANNA_CLAUDE_DRIVER=pty` the
`ask_user_question` / `exit_plan_mode` shims are **always registered**
regardless of this flag — the PTY driver passes
`forceInteractiveToolCallbacks: true` to `buildKannaMcpTools` because
PTY has no `canUseTool` hook (the durable approval protocol is the only
host path). The PTY CLI args also include
`--disallowedTools AskUserQuestion ExitPlanMode` so the model cannot
pick the native built-ins (which the CLI auto-rejects with
`is_error: "Answer questions?"`, mis-read as a user cancel). The flag
still **exclusively** gates the 8 built-in shims
(`read/glob/grep/bash/edit/write/webfetch/websearch`) and the SDK
driver's `canUseTool` routing — those are never force-enabled under PTY.

Optional `KANNA_SERVER_SECRET` env var stabilises HMAC tool-request ids
across the process lifetime. Cross-restart idempotency does not matter
because `recoverOnStartup()` fail-closes all pending records on boot.

Periodic `tickTimeouts` driver fires every 5s; default request timeout is
600s. Pending requests time out as `{kind:"deny", reason:"timeout"}`.

# Claude Driver Flag (KANNA_CLAUDE_DRIVER)

Setting `KANNA_CLAUDE_DRIVER=pty` launches the `claude` CLI **interactively**
under a Bun.Terminal pseudo-terminal (Shannon-style) and tails the on-disk
transcript JSONL at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
as the sole event source. Input is sent as raw text + `\r` (no JSONL
envelopes). PTY mode preserves Pro/Max subscription billing; SDK mode
bills at API rates.

Default is `sdk` (no behaviour change). Authentication requires an OAuth-pool
token configured in Kanna settings; the token is injected via
`CLAUDE_CODE_OAUTH_TOKEN`. The local `claude /login` keychain path is not
supported in this deployment. PTY mode is OAuth-only and NEVER uses an API
key: `buildPtyEnv` unconditionally strips `ANTHROPIC_API_KEY` from the
spawned child env. `verifyPtyAuth` only requires the OAuth-pool token.

Platform support: macOS / Linux only.

**Encoded cwd path:** Claude resolves the cwd to its real path
(`fs.realpathSync` — macOS `/var` → `/private/var`), then replaces both
`/` and `.` with `-`. `src/server/claude-pty/jsonl-path.ts`
(`encodeCwd`, `computeJsonlPath`, `computeProjectDir`) matches this
behaviour exactly. Mismatch = transcript file never found.

**Trust dialog:** TUI claude prompts "Quick safety check: Is this a project
you created or one you trust?" on every previously-unseen cwd. The driver
detects the marker in the PTY output ring buffer and sends `\r` to accept
"Yes, I trust this folder" (the default-highlighted option). Trust persists
across spawns in the same cwd, so the dismiss cost amortises. Set
`KANNA_PTY_TRUST_DISMISS=disabled` to bypass detection (escape hatch if
Anthropic changes the dialog wording).

**TUI ready signal:** Driver polls the output ring for the input-box marker
`❯ ` before sending the first prompt. Hard cap defaults to 3000 ms
(`KANNA_PTY_TUI_BOOT_MS`).

**Transcript watch:** `tui-source.ts` uses `fs.watch` by default; set
`KANNA_PTY_TRANSCRIPT_WATCH=poll` to force 50 ms polling (for unreliable
filesystems like NFS / CIFS).

**oneShot subagent close:** After the first `result` transcript entry on a
one-shot run (Claude subagent), the driver sends `/exit\r` to gracefully
close the REPL, awaits `pty.exited` with 5 s grace, then escalates SIGTERM →
SIGKILL on hang. Matches the SDK driver's prompt-queue close semantics.

**Smoke test (replaces preflight P3b):** Every spawn passes through a
single TUI probe that verifies `--disallowedTools Bash` is honored.
Cached 24 h per (binarySha256, model) under
`${HOME}/.kanna/cache/smoke-test/`. PASS unlocks spawn; FAIL refuses
with a clear reason that surfaces through the existing spawn-error
path. The 8-probe preflight gate is removed (`KANNA_PTY_PREFLIGHT_MODEL`
no longer consulted).

**AskUserQuestion / ExitPlanMode (issue #215 — CLOSED):** Driver disallows
the native built-ins (`--disallowedTools AskUserQuestion ExitPlanMode`)
and force-registers the `mcp__kanna__ask_user_question` /
`mcp__kanna__exit_plan_mode` shims, which route through the durable
approval protocol to the UI — active regardless of `KANNA_MCP_TOOL_CALLBACKS`.
See the Tool Callback Feature Flag section for full wiring.

**setPermissionMode:** Asymmetric.
- ENTER plan (`planMode === true`) sends `/plan\r` and sets an internal
  `localPlanModeActive = true` flag.
- EXIT plan (`planMode === false`) sends `SHIFT_TAB_KEY` (`\x1b[Z`, one
  Shift+Tab press) and clears the flag **when `localPlanModeActive` is
  true** — covers the common case where the driver entered plan mode.
  If the flag is false (plan mode toggled externally via Shift+Tab in the
  UI), a warning is logged and no keypress is sent. Restart the session
  to return to acceptEdits from an unknown state. Tracked:
  anthropics/claude-code#59891.

**setModel:** Sends `/model <name>\r` via the slash command (no stream-json
control_request envelope in TUI mode).

**interrupt:** Sends `Ctrl+C` (0x03) via PTY stdin — TUI claude treats this
as an interactive interrupt, cancelling the current turn.

**getSupportedCommands():** Returns the live slash-command list from the
spawned claude's `system_init` JSONL entry once a session is active.
Falls back to a static four-command list (`model`, `exit`, `clear`, `help`)
before first spawn (cold-start gap).

**SDK ↔ PTY equivalence (Phase 6):** `src/server/claude-pty/parity-matrix.test.ts`
drives both `createClaudeHarnessStream` (SDK) and `createJsonlEventParser`
fed via `startTranscriptStream` (PTY) with the same SDK-message fixtures and
asserts identical `HarnessEvent` sequences. Covers the original 7 cases
unchanged.

**Subagent + prompt + account parity (Phase 5):** unchanged from prior
phases — `buildClaudeSubagentStarter` adapts the SDK-shaped starter to
`StartClaudeSessionPtyArgs` with `oneShot: true`; both drivers append
the shared `KANNA_SYSTEM_PROMPT_APPEND`; PTY derives `AccountInfo` from
the picked OAuth-pool token label + masked key.

**Failure handling:** Every PTY spawn captures terminal output into a 256 KB
ring buffer (`OutputRing` in `output-ring.ts`). Failure synthesis on silent
exit, auth detection (`401`, "Please run /login", "Not logged in"), and
trust-dialog detection all read from this ring. Synthesised error events
feed the same `detectFromResultText` / OAuth-pool rotation path in
`agent.ts` the SDK driver uses.

**Architecture note:** PTY mode parses the on-disk transcript JSONL file
as the sole event source — `src/server/claude-pty/tui-source.ts`
(`startTranscriptStream`) watches `~/.claude/projects/<encoded-cwd>/`
for the file claude creates on first user prompt, then follows it via
`fs.watch` (or polling under `KANNA_PTY_TRANSCRIPT_WATCH=poll`).
`driver.ts` is a thin coordinator: spawn (via `pty-process.ts`
`spawnPtyProcess` + Bun.Terminal) → trust dismiss → first-prompt send →
pipe transcript lines into `createJsonlEventParser` → emit HarnessEvents.
Nothing reads the PTY stdout for events; the output ring only powers
trust detection + failure synth. Spawn-time `--mcp-config` still wires
the kanna-mcp loopback HTTP server (Phase 2) unchanged.

**OAuth pool rotation (P5):** PTY mode honors the same multi-token rotation
the SDK driver uses. `AgentCoordinator` picks an active token from
`OAuthTokenPool` per chat and the PTY driver injects it via the
`CLAUDE_CODE_OAUTH_TOKEN` env var. Auth failures (401 detected in the
output ring) synthesise an `oauth_invalid_token` result event that feeds
the same rotation/retry path the SDK driver uses on thrown stream errors.

**Env vars (PTY-specific):**
- `KANNA_CLAUDE_DRIVER=sdk|pty` — driver selector (default `sdk`).
- `KANNA_MCP_TOOL_CALLBACKS=1` — route built-in shims through durable approval.
- `KANNA_PTY_TRUST_DISMISS=enabled|disabled` — trust-dialog dismiss (default `enabled`).
- `KANNA_PTY_TUI_BOOT_MS=3000` — hard cap on TUI-ready wait (default `3000`).
- `KANNA_PTY_TRANSCRIPT_WATCH=fs|poll` — transcript watch mode (default `fs`).
- `CLAUDE_CODE_OAUTH_TOKEN` — set by driver from pool, NOT a user env var.

Removed in this version (no longer consulted):
- `KANNA_PTY_PREFLIGHT_MODEL` — preflight gone, replaced by smoke-test.
- `KANNA_PTY_SANDBOX` — sandbox already removed in a prior change; flag now inert.

# Kanna-MCP Built-in Shims

When `KANNA_MCP_TOOL_CALLBACKS=1`, kanna-mcp registers 8 additional tools
that mirror Claude's built-ins: `mcp__kanna__{read, glob, grep, bash, edit,
write, webfetch, websearch}`. They route through the durable approval
protocol with the same path-deny rules as the bash tool from P1 (readPathDeny
for `read`/`glob`/`grep`, writePathDeny for `edit`/`write`).

These shims are inert until the PTY driver applies `--tools "mcp__kanna__*"`
(P3b — landing in a follow-up PR). With the SDK driver (default), the model
still uses its native built-ins and these shims sit unused.

`websearch` is a stub that always returns `isError: true` — real web search
needs an external API integration which is out of scope for P3a.

# Custom MCP Servers

Users register MCP servers via Settings → "MCP servers". Entries persist
in `settings.json` under `customMcpServers` (file mode 0600) and are
merged into both Claude drivers at chat spawn time:

- **SDK driver** (`agent.ts`): `buildUserMcpServers` maps each enabled
  entry to the SDK's per-transport config and merges it into the
  `mcpServers` map passed to `query()` alongside `mcp__kanna__*`.
- **PTY driver** (`kanna-mcp-http.ts:buildMcpConfigJson` +
  `claude-pty/driver.ts`): entries serialize into the same
  `mcp-config.json` the driver hands to `--strict-mcp-config`. Kanna
  settings remain the single source of truth; `~/.claude.json` stays
  ignored.

User MCP tool calls auto-allow (`canUseTool` already returns
`{ behavior: "allow" }` for any tool that isn't `AskUserQuestion` /
`ExitPlanMode`, which includes every `mcp__<name>__*` whose `<name>`
isn't `kanna`). Trust model: if the user installed it, they trust it.

Supported transports: `stdio`, `http`, `sse`, `ws`. Reserved name:
`kanna`. Names match `^[a-zA-Z][a-zA-Z0-9_-]{0,31}$` and form the tool
prefix `mcp__<name>__<tool>`.

**Connect-test:** on create/update, `ws-router.ts` fires a fire-and-
forget `validateMcpServer` (`src/server/mcp-validator.ts`, 10s timeout,
list-tools probe) and persists `lastTest` on the entry. The UI shows a
per-row status pill plus a manual "Test" button that drives the
explicit `settings.testMcpServer` RPC.

**Boundary rule:** user MCP server names MUST NOT equal
`KANNA_MCP_SERVER_NAME`. Enforced by both `validateMcpShape`
(`app-settings.ts`) and `buildUserMcpServers` / `buildMcpConfigJson`
filters (belt-and-suspenders).

# Subagent Delegation (Anthropic Task-tool pattern)

The main agent is always in the loop. `@agent/<name>` in chat input is a
**hint**, not server-side routing — it no longer short-circuits the main
turn. The main model decides whether to delegate and calls
`mcp__kanna__delegate_subagent({ subagent_id, prompt })`. The tool blocks
until the run finishes and returns the subagent's final reply as text;
the main model then synthesizes it into its own response.

- **Roster injection:** `buildKannaSystemPromptAppend(subagents)` in
  `src/shared/kanna-system-prompt.ts` builds a dynamic system-prompt
  suffix listing every configured subagent's `name`, `id`, and
  `description`. Computed per-spawn in `agent.ts` and passed to both
  drivers (SDK via `systemPrompt.append`, PTY via
  `--append-system-prompt`). Truncated at 20 entries by `updatedAt`
  descending; remainder surfaced as "(N more subagents omitted ...)".
- **MCP tool:** registered in `kanna-mcp.ts` only when the spawn
  supplies both `subagentOrchestrator` AND `delegationContext`. Main
  spawns supply `depth: 0`, `ancestorSubagentIds: []`, `parentRunId:
  null`. Subagent spawns (sub-spawn-sub) supply the caller's own
  context so cycle / depth checks apply — `LOOP_DETECTED` when the
  target appears in the ancestor chain, `DEPTH_EXCEEDED` when
  `depth > maxChainDepth` (default 1, configurable on the orchestrator).
- **`SubagentOrchestrator.delegateRun(args)`:** public async API that
  awaits a single run and returns `DelegationOutcome` —
  `{status:"completed", text}` or `{status:"failed", errorCode, errorMessage}`.
  Used by the MCP tool; also exposed via
  `AgentCoordinator.getSubagentOrchestrator()` for tests.
- **Cancellation:** `cancelChat` / `cancelRun` cascade through delegated
  runs as before. Each `delegateRun` registers a `RunState` and obeys
  the same permit / timeout / abort wiring as the legacy
  mention-triggered path.
- **Backwards compat:** `parseMentions` still runs inside the normal
  `appendUserPrompt` path so `subagentMentions` metadata stays on
  `user_prompt` entries for UI badges and analytics. The assistant-text
  mention scan and the `chat_send` / dequeue short-circuits are removed.

# Tests

`bun test` MUST pass locally before any push or PR. CI (`.github/workflows/test.yml`)
runs `bun test` on every push to `main` and every PR; merges are blocked on failure.
Run `bun test src/server/<file>.test.ts` for fast iteration on a single suite.
When a test spawns `git` or other subprocesses, ensure the spawn sets
`stdin: "ignore"` and `GIT_TERMINAL_PROMPT=0` so a hung credential prompt
cannot exhaust the test timeout. Also give it an explicit timeout
(`test(name, fn, 30_000)`) — the 5s Bun default is too tight for CI runners.

# Wiki

Public docs site lives in `wiki/` (Astro Starlight) and is deployed to
https://kanna-wiki.lowbit.link on every push to `main` that touches `wiki/**`.

Regenerate screenshots:

```bash
bash wiki/scripts/capture-all.sh
```

This spawns a seeded demo Kanna under a tmpdir `KANNA_HOME`, captures all
~32 PNGs via Playwright, and writes them to `wiki/public/screenshots/`.
Commit the PNGs.

Regenerate env-var reference table:

```bash
cd wiki && bun run scripts/extract-env-vars.ts
```

Wiki is isolated from the main repo build — its own `package.json`, own
`node_modules`. `bun run lint` and `bun test` at the repo root do NOT touch
`wiki/`.
