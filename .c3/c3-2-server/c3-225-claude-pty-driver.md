---
id: c3-225
c3-seal: 2b67d72bd3d830ab385c32cec968efeb9bda5609562e0f99a38cf1b5c8e85db9
title: claude-pty-driver
type: component
category: feature
parent: c3-2
goal: Run the `claude` CLI under a pseudo-terminal, tail the on-disk transcript JSONL it writes under `~/.claude/projects/<encoded-cwd>/<session>.jsonl` as the SOLE event source, and deliver prompts via TUI input for interactive sessions or via `notifications/claude/channel` MCP push for one-shot subagent sessions. Preserves Pro/Max subscription billing.
uses:
    - ref-colocated-bun-test
    - ref-event-sourcing
    - ref-provider-adapter
    - rule-colocated-bun-test
    - rule-strong-typing
---

# claude-pty-driver

## Goal

Run the `claude` CLI under a pseudo-terminal, tail the on-disk transcript JSONL it writes under `~/.claude/projects/<encoded-cwd>/<session>.jsonl` as the SOLE event source, and deliver prompts via TUI input for interactive sessions or via `notifications/claude/channel` MCP push for one-shot subagent sessions. Preserves Pro/Max subscription billing.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | Orchestrate provider-agnostic agent turns — supplies the Claude PTY transport the orchestrator drives |
| Category | feature |
| Lifecycle | Per-spawn subprocess holder; one PTY child + one transcript-watch parser per session |
| Replaceability | Replaceable while the HarnessEvent stream contract, the prompt-delivery surfaces (TUI input + channel push), and the kanna-mcp channel capability declaration are preserved |

## Purpose

Owns the Claude CLI PTY transport: spawns the `claude` subprocess (after the smoke-test gate), watches the on-disk transcript JSONL the CLI writes at `~/.claude/projects/<encoded-cwd>/<session>.jsonl` via `tui-source.adapter.ts:startTranscriptStream` (`fs.watch` by default, polling under `KANNA_PTY_TRANSCRIPT_WATCH=poll`), feeds each line to `createJsonlEventParser` → normalized HarnessEvents. Prompt delivery has two surfaces: interactive sessions receive prompts via `tui-control.sendUserPrompt` bracketed paste; one-shot subagent sessions receive the initial prompt via a single `notifications/claude/channel` MCP push from the kanna-mcp loopback HTTP server (c3-226), gated by `KANNA_PTY_CHANNEL_DELIVERY` and a `channelClientReady` signal. Non-goals: turn orchestration and provider selection (c3-210), provider/model metadata normalization (c3-212), Codex transport (c3-211). Stdout is read into a bounded 256 KB ring buffer only for trust/dev-channels dialog detection and silent-exit failure synthesis; it is NEVER the event source. `jsonl-path.ts` (`computeJsonlPath`/`encodeCwd`) is LIVE production code with multiple callers (driver, tui-source.adapter, smoke-test).

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | OAuth-pool token injected as CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_API_KEY stripped from child env; smoke-test gate passes | c3-210 |
| Input — transcript JSONL | tui-source.adapter.ts startTranscriptStream watches ~/.claude/projects/<encoded-cwd>/ for the session file, then tails it via fs.watch or polling; each line fed to createJsonlEventParser → HarnessEvents | N.A - internal transcript-watch module within this component (tui-source.adapter.ts, jsonl-to-event.ts) |
| Input — output ring | 256 KB bounded ring buffer captures PTY stdout for trust/dev-channels dialog detection and silent-exit failure synthesis ONLY; not the event source | N.A - internal output-ring buffer (output-ring.ts) |
| Prompt — interactive | tui-control.sendUserPrompt sends bracketed paste then \r to the PTY for normal chat sessions | N.A - internal tui-control module |
| Prompt — channel push | One-shot subagent spawns: kanna-mcp pushes notifications/claude/channel with the full prompt content after channelClientReady resolves; NO TUI typing | c3-226 |
| Shared dep — Kanna MCP | In-process loopback HTTP MCP server attached per spawn via --mcp-config; declares experimental['claude/channel'+'/permission'] and provides pushChannelPrompt + channelClientReady | c3-226 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | A subscription-billed Claude turn streams to the UI with SDK-equivalent event sequencing | c3-210 |
| Primary path | spawn PTY → dismiss trust + dev-channels dialogs → deliver prompt (paste for chat, channel push for one-shot) → tail transcript JSONL → emit HarnessEvents upstream | c3-209 |
| Alternate — oneShot | Subagent one-turn sessions: prompt via channel push, REPL closed after first result line via /exit + SIGTERM/SIGKILL escalation | c3-210 |
| Alternate — silent crash | Exit with no result: synthesize {kind:result,subtype:error} from the output ring tail | N.A - internal failure synthesis within this component |
| Failure — OAuth/auth error | Synthesized error result drives the same rotation/retry path as the SDK driver | c3-210 |
| Failure — channel not ready | One-shot with KANNA_PTY_CHANNEL_DELIVERY=enabled: if channelClientReady does not resolve within KANNA_PTY_CHANNEL_READY_TIMEOUT_MS the spawn throws fail-fast and closes the transcript stream — no silent paste fallback | c3-226 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-provider-adapter | ref | Provider-agnostic turn/event shape and prompt-delivery surfaces | must follow | Claude PTY transport adapter, parallel to c3-211 |
| ref-event-sourcing | ref | Driver emits events; log-before-broadcast invariant | must follow | Ordering owned upstream by c3-210/c3-206 |
| ref-colocated-bun-test | ref | Tests sit beside sources under src/server/claude-pty/ | must follow | driver.test.ts, jsonl-to-event.test.ts, tui-control.test.ts, pty-cli-args.test.ts |
| rule-colocated-bun-test | rule | Test colocation enforced for this subtree | wired compliance target beats uncited local prose | Added by c3x wire |
| rule-strong-typing | rule | No internal untyped shapes; only documented external Bun boundary cast allowed | wired compliance target | as unknown as ReadableStream at subprocess boundary only |
| adr-20260519-pty-driver-stdout-event-source | adr | Originating charter; superseded by the transcript-watch ADR below | superseded | status=superseded — kept for history |
| adr-20260529-pty-transcript-watch-event-source | adr | Authoritative current event-source contract: on-disk transcript JSONL via tui-source.adapter.ts | governs this component | Implemented |
| adr-20260529-pty-oneshot-channel-push-prompt-delivery | adr | Authorizes channel-push prompt delivery for one-shot subagent spawns + the dev-channels CLI flag + dialog dismissal + fail-fast on channel timeout | governs this component | Implemented |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Start PTY session | IN | Spawn claude child for a chat/subagent turn; sets per-spawn runtimeDir, mcp-config, smoke-test gate | c3-210 | src/server/claude-pty/driver.ts |
| HarnessEvent stream | OUT | Normalized events parsed from the on-disk transcript JSONL — the SOLE event source; stdout is never the event source | c3-210 | src/server/claude-pty/tui-source.adapter.ts, src/server/claude-pty/driver.ts |
| TUI prompt input | IN | Interactive sessions: prompt written to PTY via tui-control.sendUserPrompt bracketed paste + \r; REPL closed on oneShot/close | c3-210 | src/server/claude-pty/tui-control.ts, src/server/claude-pty/driver.ts |
| Channel prompt push | IN | One-shot subagent sessions: full prompt delivered via kanna-mcp notifications/claude/channel push after channelClientReady resolves; bracketed paste path is bypassed for one-shot. Gated by KANNA_PTY_CHANNEL_DELIVERY (default enabled); KANNA_PTY_CHANNEL_READY_TIMEOUT_MS bounds readiness wait; fail-fast (no paste fallback) on timeout | c3-226 | src/server/claude-pty/driver.ts, src/server/kanna-mcp-http.ts, src/server/claude-pty/channel-notification.ts |
| Keep-alive multi-turn | IN/OUT | When StartClaudeSessionPtyArgs.keepAlive is set, the first result does NOT trigger oneShotClose so the REPL stays open; the handle exposes pushChannelPrompt(text) to deliver subsequent turns via the same channel push (after a short REPL idle beat). buildChannelPromptFraming(keepAlive) appends plural channel framing so the model expects multiple channel messages over the session. Drives c3-210 LiveTurnSource turns | c3-210 | src/server/claude-pty/driver.ts |
| Dev-channels CLI flag | OUT | One-shot spawns append --dangerously-load-development-channels server:kanna so the channel handler registers in the spawned claude | c3-226 | src/server/claude-pty/pty-cli-args.ts |
| Live-status registry upserts | OUT | Driver upserts PtyInstanceState (phase, pid, model, account, rssBytes, rssPeakBytes, cpuPercent, cpuPeakPercent) into PtyInstanceRegistry; ws-router fans deltas to subscribed clients. Resource sampler ticks every 2 s (configurable via memorySamplerIntervalMs) using sampleProcessTreeUsage which shells one ps -A -o pid=,ppid=,rss=,pcpu= per tick and sums RSS + CPU% across child + descendants; interval cleared on cleanupResources. Teardown is pid-scoped: cleanupResources captures the handle's own pid and uses markExitedIfCurrent(chatId, pid, …) + on-disk ptyRegistry.unregister(pid) so a stale re-spawn handle (same chatId+sessionId via --resume, older pid) cannot clobber the live entry. Orphan reap kills by process SUBTREE (killProcessTree), never by process group — the PTY child is not guaranteed to be its own pgid leader under a supervisor like PM2 | c3-102 | src/server/claude-pty/pty-instance-registry.ts, src/server/claude-pty/pid-registry.adapter.ts, src/server/claude-pty/pty-memory-sampler.adapter.ts, src/server/claude-pty/driver.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Event source drifts back to stdout pump | Edit re-adds pumpStdout or reads proc.stdout for events | grep -rn 'pumpStdout\|proc.stdout' src/server/claude-pty non-test count above zero | bun test src/server/claude-pty/driver.test.ts |
| One-shot prompt typed instead of channel-pushed | Edit calls sendUserPrompt on the oneShot path when KANNA_PTY_CHANNEL_DELIVERY is enabled | grep for sendUserPrompt inside the oneShot branch of driver.ts | bun test src/server/claude-pty/driver.test.ts |
| Channel push fires more than once per one-shot spawn | Edit removes single-push guard or retries on apparent stall | grep for repeated calls or loop around pushChannelPrompt | bun test src/server/claude-pty/driver.test.ts (single-push assertion) |
| Channel-ready timeout silently falls back to paste | Edit re-introduces paste fallback after channelClientReady timeout | grep for sendUserPrompt in the fail-fast cleanup block of driver.ts | bun test src/server/claude-pty/driver.test.ts (fail-fast throw assertion) |
| Dev-channels dialog dismissal regresses or signals premature ready | Edit removes postDismissOffset reference guard from waitForTuiReadyDismissingDialogs | grep for postDismissOffset usage in tui-control.ts | bun test src/server/claude-pty/tui-control.test.ts |
| Subscription-billing invariant broken | ANTHROPIC_API_KEY not stripped from child env | buildPtyEnv auth test fails | bun test src/server/claude-pty/auth.test.ts |
| Stale re-spawn handle clobbers the live PTY registry entry | Teardown calls unconditional upsert(chatId,exited)/unregister(sessionId) instead of the pid-scoped guards — a chat re-spawns via --resume so old+new handles share chatId+sessionId | grep for markExitedIfCurrent in cleanupResources and unregister(ownPid in driver.ts; absence = regression | bun test src/server/claude-pty/pty-instance-registry.test.ts src/server/claude-pty/pid-registry.test.ts |
| Reap no-ops on a non-leader pid or signals the whole app group | Edit reintroduces process.kill(-pid)/killPgroup instead of killProcessTree (PTY child inherits the server pgid under PM2) | grep -rn 'process.kill(-' src/server/claude-pty must be absent outside killProcessTree | bun test src/server/claude-pty/pid-registry.test.ts (non-leader subtree kill) |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/claude-pty/driver.ts | Contract | Spawn/dismiss/oneShot/channel-push wiring detail | src/server/claude-pty/driver.ts |
| src/server/claude-pty/tui-source.adapter.ts | Contract (HarnessEvent stream) | fs.watch vs polling, file-discovery loop | src/server/claude-pty/tui-source.adapter.ts |
| src/server/claude-pty/jsonl-to-event.ts | Contract | Parser state-machine detail | src/server/claude-pty/jsonl-to-event.ts |
| src/server/claude-pty/jsonl-path.ts | Contract | encodeCwd + computeJsonlPath path derivation | src/server/claude-pty/jsonl-path.ts |
| src/server/claude-pty/channel-notification.ts | Contract (Channel prompt push) | Payload shape; pure builder | src/server/claude-pty/channel-notification.ts |
| src/server/claude-pty/tui-control.ts | Contract (TUI prompt input + dialog dismissal) | NBSP marker matching, postDismissOffset reference guard | src/server/claude-pty/tui-control.ts |
| src/server/claude-pty/pty-cli-args.ts | Contract (Dev-channels CLI flag) | Flag assembly | src/server/claude-pty/pty-cli-args.ts |
| src/server/claude-pty/pty-memory-sampler.adapter.ts | Contract | ps invocation + parse + tree-RSS sum; ports-and-adapters seal exemption | src/server/claude-pty/pty-memory-sampler.adapter.ts |
| src/server/claude-pty/driver.test.ts | Change Safety | Test cases per surface | src/server/claude-pty/driver.test.ts |
| src/server/claude-pty/tui-control.test.ts | Change Safety | Dialog dismissal + reference-guard coverage | src/server/claude-pty/tui-control.test.ts |
| src/server/claude-pty/pty-cli-args.test.ts | Change Safety | Channel flag presence/absence per session kind | src/server/claude-pty/pty-cli-args.test.ts |
| src/server/claude-pty/pty-memory-sampler.adapter.test.ts | Change Safety | Parser + tree-collect + integration coverage for sampler | src/server/claude-pty/pty-memory-sampler.adapter.test.ts |
