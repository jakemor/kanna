---
id: adr-20260518-subagent-delegation-tool
title: subagent-delegation-tool
type: adr
goal: 'Replace @agent server-side mention routing with Anthropic Task-tool pattern: main agent always runs, sees subagent roster in system prompt, delegates via mcp__kanna__delegate_subagent. Sub-spawn-sub supported. @mention in user input is a hint, not a server route.'
status: implemented
date: "2026-05-18"
---

# subagent-delegation-tool

## Goal

Replace `@agent/<name>` server-side mention routing with the Anthropic Task-tool pattern. The main agent now always runs, sees every configured subagent's name + id + description in its system prompt, and decides whether to delegate by calling `mcp__kanna__delegate_subagent({ subagent_id, prompt })`. The MCP tool blocks until the subagent finishes and returns its final reply as a string. Subagents can in turn delegate to other subagents (sub-spawn-sub) bounded by the orchestrator's existing depth + cycle guards.

## Context

Before this change, an `@agent/<name>` mention in a user message was parsed in `chat_send` (and `dequeueAndStartQueuedMessage` for queued messages) and short-circuited the main turn — `subagentOrchestrator.runMentionsForUserMessage` started the subagent run directly, the main model never ran, and the subagent received the user's raw text via `composeInitialPrompt`. A secondary path (`dispatchAssistantMentions`) scanned the main assistant's reply text for `@agent/...` and dispatched there too.

This diverged from Anthropic's own `Task` tool pattern (Claude Code), where the main model orchestrates and a `Task({subagent_type, prompt})` tool hands off focused work. The differences mattered:

- The main model could not enrich the prompt with chat-history context the subagent needed.
- The main model could not pick a different subagent than the one the user mentioned when the actual ask was a better match elsewhere.
- The main model could not multi-step (delegate → read result → delegate again) within a single turn.
- The main model never even knew which subagents existed — `KANNA_SYSTEM_PROMPT_APPEND` was a static refusal-policy blurb with no roster.

The 2026-05-18 design conversation concluded the best path was option A (pure Task-tool pattern) per Anthropic best practice, accepting the latency cost of an extra LLM turn per delegation.

## Decision

Adopt the Task-tool pattern fully. Specifically:

1. **Dynamic system prompt.** `KANNA_SYSTEM_PROMPT_APPEND` becomes `KANNA_SYSTEM_PROMPT_BASE` (unchanged content); a new builder `buildKannaSystemPromptAppend(subagents)` concatenates the base + a `## Available subagents` section + delegation guidance. Computed per-spawn in `agent.ts` from `getSubagents()`, passed to both drivers (SDK `systemPrompt.append`, PTY `--append-system-prompt`). Truncated at 20 entries by `updatedAt` desc.

2. **`SubagentOrchestrator.delegateRun(args)`.** Public async method that awaits a single run and returns `DelegationOutcome = {status:"completed", runId, text} | {status:"failed", runId, errorCode, errorMessage}`. Internally delegates to the existing `spawnRun` (refactored to return outcome instead of `void`). Cycle + depth guards mirror the chained-mention path: `LOOP_DETECTED` when target subagent appears in the ancestor chain, `DEPTH_EXCEEDED` when `depth > maxChainDepth` (default 1).

3. **`mcp__kanna__delegate_subagent` tool.** Registered in `kanna-mcp.ts` only when the spawn supplies both `subagentOrchestrator` and `delegationContext`. Args: `{subagent_id, prompt}`. Main-agent spawns set `{depth:0, ancestorSubagentIds:[], parentRunId:null, parentSubagentId:null, getParentUserMessageId:() => activeTurn.userMessageId}`. Subagent spawns (sub-spawn-sub) set the caller's run context so cycle / depth checks apply. Returns the subagent's final reply text in `content[0].text`, JSON-wrapped with status + run_id; sets `isError: true` on failure.

4. **Short-circuit removal.** `chat_send` and `dequeueAndStartQueuedMessage` no longer route `parseMentions` results through the orchestrator. `dispatchAssistantMentions` and `ActiveTurn.assistantTextAccum` are deleted. `parseMentions` still runs inside `appendUserPrompt` so the `user_prompt` entry continues to carry `subagentMentions` + `unknownSubagentMentions` metadata for UI badges and analytics.

5. **Driver parity.** Both SDK (`startClaudeSession`) and PTY (`startClaudeSessionPTY` + `buildPtyCliArgs`) accept `systemPromptAppend`, `subagentOrchestrator`, `delegationContext` and forward them to `kanna-mcp` (in-process for SDK, in-process HTTP for PTY). D8 parity test rewritten to cover both the static default and the dynamic-roster override.

## Affected Topology

| Entity | Type | Why affected |
| --- | --- | --- |
| c3-210 agent-coordinator | component | Loses the @mention short-circuit; gains delegationContext wiring for kanna-mcp; subagent starter forwards orchestrator + context for sub-spawn-sub |
| src/shared/kanna-system-prompt.ts | shared | Static const split into base + dynamic builder |
| src/server/kanna-mcp.ts | server | `delegate_subagent` tool registered when `subagentOrchestrator` + `delegationContext` are supplied |
| src/server/kanna-mcp-tools/delegate-subagent.ts | server | New MCP tool module |
| src/server/subagent-orchestrator.ts | server | `spawnRun` returns `DelegationOutcome`; new public `delegateRun` entry point; `startProviderRun` callback gains `depth` / `ancestorSubagentIds` / `parentUserMessageId` |
| src/server/subagent-provider-run.ts | server | `startClaudeSession` signature extended for orchestrator + delegationContext to enable sub-spawn-sub |
| src/server/claude-pty/driver.ts | server | `StartClaudeSessionPtyArgs` and `buildPtyCliArgs` accept `systemPromptAppend`, `subagentOrchestrator`, `delegationContext`; CLI arg switched from constant to dynamic |

## Consequences

- Every `@agent/...` mention now costs an extra LLM turn (main model receives, decides, delegates). Acceptable given Pro/Max subscription billing for PTY mode and the design preference for best-of-Anthropic-pattern over token economy.
- The main model can pick the wrong subagent. Mitigation: the delegation guidance in the system prompt explicitly tells the model to treat `@` as a suggestion and confirm fit. Future work: telemetry on `delegate_subagent` call rate vs. user-mentioned subagent for drift analysis.
- The main model can loop (delegate → read → delegate again). Mitigation: existing `maxChainDepth` (default 1) + cycle guard prevents runaway. Subagent timeout (600s) still applies.
- Sub-spawn-sub via the tool is now possible. Mitigation: same `LOOP_DETECTED` / `DEPTH_EXCEEDED` guards apply, fed from the spawn's `delegationContext`.

## Verification

- `bun test src/shared/kanna-system-prompt.test.ts` — 8 tests covering empty roster, roster building, ordering, truncation, guidance content.
- `bun test src/server/kanna-mcp-tools/delegate-subagent.test.ts` — 4 tests covering input forwarding, completed payload shape, failed payload shape, no-active-turn guard, sub-spawn-sub context threading.
- `bun test src/server/subagent-orchestrator.test.ts` — 5 new `delegateRun` tests (completed, UNKNOWN_SUBAGENT, DEPTH_EXCEEDED, LOOP_DETECTED, PROVIDER_ERROR) plus all existing `runMentionsForUserMessage` tests still pass.
- `bun test src/server/claude-pty/driver.test.ts` — updated D8 test confirms `KANNA_SYSTEM_PROMPT_APPEND` is the default; new D8b confirms `systemPromptAppend` override path.
- `bun test src/server/agent.test.ts` — short-circuit tests rewritten to call `getSubagentOrchestrator().delegateRun(...)` directly.
- Full suite: `bun test` — 1957 pass / 0 fail.
- `bunx eslint src/ --max-warnings=0` — clean.
