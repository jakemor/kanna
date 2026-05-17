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

Default is `sdk` (no behaviour change). Requires `claude /login` to have
been run once. `ANTHROPIC_API_KEY` must be unset (PTY mode refuses to
spawn if it is set — would force API billing).

Limitations of P2 (this release):
- Single account, no rotation (account pool lands in a later phase).
- No OS sandbox (defense-in-depth, later phase).
- Built-in CLI tools (`Read`/`Bash`/etc.) enabled — not yet routed through
  `kanna-mcp`. Permission gating from `KANNA_MCP_TOOL_CALLBACKS=1` still
  applies to `AskUserQuestion`/`ExitPlanMode` only.
- macOS/Linux only.

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
