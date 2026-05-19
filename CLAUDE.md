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

Setting `KANNA_CLAUDE_DRIVER=pty` launches the `claude` CLI under a
pseudo-terminal and parses the CLI's stdout JSONL stream line-by-line
instead of using the `@anthropic-ai/claude-agent-sdk` `query()`
programmatic API. PTY mode preserves Pro/Max subscription billing; SDK
mode bills at API rates.

Default is `sdk` (no behaviour change). Authentication requires an OAuth-pool token configured in Kanna settings; the token is injected via `CLAUDE_CODE_OAUTH_TOKEN`. The local `claude /login` keychain path is not supported in this deployment. PTY mode is OAuth-only and NEVER uses an API key: `buildPtyEnv` unconditionally strips `ANTHROPIC_API_KEY` from the spawned child env, so a key left in the parent environment is harmless — it does not block the spawn and cannot force API billing. `verifyPtyAuth` only requires the OAuth-pool token.

Platform support: macOS / Linux only.

**AskUserQuestion / ExitPlanMode (issue #215 — CLOSED):** PTY now
reaches parity. The driver disallows the native built-ins
(`--disallowedTools AskUserQuestion ExitPlanMode`) and force-registers
the `mcp__kanna__ask_user_question` / `mcp__kanna__exit_plan_mode`
shims, which route through the durable approval protocol to the UI —
active regardless of `KANNA_MCP_TOOL_CALLBACKS`. See the Tool Callback
Feature Flag section for the full wiring.

**Remaining parity gaps vs SDK driver** (closed phases tracked in #162;
umbrella #163):
- `setPermissionMode(planMode)` is now asymmetric, not a full no-op:
  ENTER plan (`planMode === true`) sends the `/plan` slash command — a
  real, deterministic runtime mode change (`/plan` "enters plan mode
  directly from the prompt", code.claude.com/docs/en/commands). EXIT
  plan (`planMode === false`) is still warn-only: no slash command
  leaves plan mode, and the only exit is the relative Shift+Tab TUI
  cycle whose keypress count depends on unobservable TUI state (PTY
  drains output unparsed). Restart the session to return to acceptEdits.
  Tracked: anthropics/claude-code#59891.
- `getSupportedCommands()` returns a static four-command list. Phase 6
  spike confirmed `claude --help` has no slash-command listing flag and
  the CLI exposes no `--print '/help'` mode that prints a structured
  list; a live `/help` parser needs an authenticated ephemeral session
  per chat (cosmetic, deferred).

**SDK ↔ PTY equivalence (Phase 6):** `src/server/claude-pty/parity-matrix.test.ts`
drives both `createClaudeHarnessStream` (SDK) and
`createJsonlEventParser` (PTY) with the same SDK-message fixtures and
asserts identical `HarnessEvent` sequences after normalising volatile
fields. Covers: simple turn, SDK-native `rate_limit_event`,
prompt-too-long isError result, assistant usage-id dedup, 1M
context-window floor, per-message `session_token`, and `compact_boundary`
turns. Regression guard for future driver edits.

**Subagent + prompt + account parity (Phase 5):**
- D6 — Claude subagents route through the PTY driver when
  `KANNA_CLAUDE_DRIVER=pty` (subscription billing), via
  `buildClaudeSubagentStarter()` which adapts the SDK-shaped starter to
  `StartClaudeSessionPtyArgs` and sets `oneShot: true` so the REPL closes
  after the single turn (Phase 4 D7). SDK fallback when the flag is unset.
- D8 — Both drivers now append the single shared
  `KANNA_SYSTEM_PROMPT_APPEND` constant (`src/shared/kanna-system-prompt.ts`).
  PTY previously sent a one-sentence stub that diverged refusal behaviour.
- C1 — The claude CLI never writes account info to the JSONL transcript
  (confirmed: `SDKSystemMessage` has no account fields; `q.accountInfo()`
  is an SDK-only API). PTY instead derives `AccountInfo` from the picked
  OAuth-pool token label: `{organization: <label>, tokenSource:
  "kanna-oauth-pool"}`. Returns `null` (UI fallback) when no pool token
  is configured.

**Failure handling (Phase 4):** Every PTY spawn captures terminal output
into a 256 KB ring buffer. If the process exits without ever emitting a
`result` transcript entry (silent crash, OAuth failure, preflight kill),
the driver synthesizes a `{kind:"result", subtype:"error",
isError:true}` entry from the output tail before draining the stream
`done`. This feeds the same `detectFromResultText` / auth-error
detection + rotation/retry path in `agent.ts` that the SDK driver gets
from thrown stream errors. A clean exit that already produced a `result`
does not synthesize. The `oneShot` arg (used by one-turn subagent
sessions) gracefully closes the REPL after the first `result` entry,
mirroring the SDK driver closing its prompt queue.

**JSONL event parity (Phase 3):** PTY mode uses a stateful
`createJsonlEventParser` (one per session) that mirrors the SDK driver's
`createClaudeHarnessStream`. Emits `session_token` for every JSONL line
carrying a `session_id`, `rate_limit` events from both
`rate_limit_event` (SDK-native) and `system/rate_limit` (legacy) shapes,
and `context_window_updated` transcript entries per assistant message
plus a final turn-end entry derived from `result.modelUsage`. The
configured-window floor (`parseConfiguredContextWindowFromModelId` —
1M for `[1m]` models) is preserved against `modelUsage.contextWindow`
under-reports.

**Kanna MCP server (Phase 2):** PTY mode now starts an in-process HTTP
MCP server bound to loopback (`127.0.0.1:<ephemeral>`) for every PTY
spawn. The claude CLI subprocess connects via `--mcp-config <file>` with
a per-spawn random Bearer token in the `Authorization` header.
`--strict-mcp-config` is set so the CLI ignores any user-side MCP config.
This exposes the same tool surface the SDK driver gets via
`createSdkMcpServer`: `offer_download`, `expose_port`, and when
`KANNA_MCP_TOOL_CALLBACKS=1` the eight built-in shims plus
`ask_user_question` / `exit_plan_mode`. `toolCallback`,
`tunnelGateway`, and `chatPolicy` live in the parent process so no IPC
serialization is needed. Server is torn down on `close()` along with
`toolCallback.cancelAllForSession(sessionId, "session_closed")`.

**OAuth pool rotation (P5):** PTY mode honors the same multi-token rotation
the SDK driver uses. `AgentCoordinator` picks an active token from
`OAuthTokenPool` per chat and the PTY driver injects it via the
`CLAUDE_CODE_OAUTH_TOKEN` env var. No per-account `$HOME` directories or local `.credentials.json` files required.

**Architecture note:** PTY mode parses the `claude` CLI subprocess
**stdout** as the sole event source. `driver.ts` `pumpStdout` reads the
stdout `ReadableStream` via `reader.read()` (event-driven, no poll
interval / `fs.watch` / file-tail loop / sleep), splits on `\n`, and
feeds each line to `createJsonlEventParser`. The PTY supplies the
subprocess + input channel; its stdout IS parsed (not drained). Model
switches, rate-limit signals, and permission changes all surface through
this stdout JSONL stream. Nothing reads the on-disk transcript at
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` —
`claude-pty/jsonl-path.ts` (`computeJsonlPath`/`encodeCwd`) has zero
production callers (referenced only by its own test) and is currently
dead code.

**Allowlist preflight (P3b):** When `KANNA_CLAUDE_DRIVER=pty`, every PTY
spawn passes through `claude-pty/preflight/gate.ts`. The gate computes a
sha256 of the `claude` binary, looks up a cached probe-suite result for
`(binarySha256, tools-string, model)`, and on cache miss runs 8 directed
probes (one per disallowed built-in: Bash/Edit/Write/Read/Glob/Grep/
WebFetch/WebSearch). Each probe spawns claude with `--tools "mcp__kanna__*"`
and a system prompt pressuring the model to invoke that built-in or call
`mcp__kanna__probe_unavailable`. If any built-in is reachable → spawn
refused with `"built-in reachable: <names>"`. Cache TTL: 24 h.

Override the probe model via `KANNA_PTY_PREFLIGHT_MODEL` (default
`claude-haiku-4-5-20251001` for cost/speed). Real probes burn subscription
turns; CI does not run them — unit tests cover the classifier + cache only.

**OS sandbox (P4 + P4.1):** Every PTY spawn is wrapped with an OS-level
sandbox when supported:
- macOS: `/usr/bin/sandbox-exec -f <profile.sb>`. Profile generated per
  spawn from `POLICY_DEFAULT.readPathDeny` + `writePathDeny`. Default on.
- Linux: `/usr/bin/bwrap <flags> claude ...`. Each deny entry becomes
  `--tmpfs <path>` (replaces the path with an empty in-memory filesystem).
  Default on **only when `bwrap` is installed** (`apt install bubblewrap` /
  `pacman -S bubblewrap` / `dnf install bubblewrap`). If absent, sandbox
  silently disables — set `KANNA_PTY_SANDBOX=off` to suppress the gap.
- Windows: PTY refused per spec.

Set `KANNA_PTY_SANDBOX=off` to skip (advanced users, loses defense-in-depth
against built-in tool credential reads).

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
