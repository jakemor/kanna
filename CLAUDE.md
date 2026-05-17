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

Optional `KANNA_SERVER_SECRET` env var stabilises HMAC tool-request ids
across the process lifetime. Cross-restart idempotency does not matter
because `recoverOnStartup()` fail-closes all pending records on boot.

Periodic `tickTimeouts` driver fires every 5s; default request timeout is
600s. Pending requests time out as `{kind:"deny", reason:"timeout"}`.

# Claude Driver Flag (KANNA_CLAUDE_DRIVER)

Setting `KANNA_CLAUDE_DRIVER=pty` launches the `claude` CLI under a
pseudo-terminal and tails the on-disk JSONL transcript instead of using
the `@anthropic-ai/claude-agent-sdk` `query()` programmatic API. PTY mode
preserves Pro/Max subscription billing; SDK mode bills at API rates.

Default is `sdk` (no behaviour change). Authenticate via **either**
`claude /login` (populates `~/.claude/.credentials.json`) **or** an
OAuth-pool token configured in Kanna settings — `CLAUDE_CODE_OAUTH_TOKEN`
silently overrides the keychain / credentials.json lookup at CLI
startup (anthropics/claude-code#16238), so OAuth-pool-only deployments
do not need a local credentials file. `ANTHROPIC_API_KEY` must be unset
(PTY mode refuses to spawn if it is set — would force API billing).

Platform support: macOS / Linux only.

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
`CLAUDE_CODE_OAUTH_TOKEN` env var. Cross-platform: works on macOS
(overrides Keychain lookup) and Linux (overrides `.credentials.json` read).
No per-account `$HOME` directories required.

**Architecture note:** PTY mode uses the on-disk JSONL transcript at
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` as the sole event
source. The PTY is a subprocess holder + input channel only; output is
drained, not parsed. Model switches, rate-limit signals, and permission
changes all surface through JSONL.

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

# Tests

`bun test` MUST pass locally before any push or PR. CI (`.github/workflows/test.yml`)
runs `bun test` on every push to `main` and every PR; merges are blocked on failure.
Run `bun test src/server/<file>.test.ts` for fast iteration on a single suite.
When a test spawns `git` or other subprocesses, ensure the spawn sets
`stdin: "ignore"` and `GIT_TERMINAL_PROMPT=0` so a hung credential prompt
cannot exhaust the test timeout. Also give it an explicit timeout
(`test(name, fn, 30_000)`) — the 5s Bun default is too tight for CI runners.
