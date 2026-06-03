---
id: adr-20260603-workflow-aware-idle-reaper
c3-seal: 540f2d23ebafb5590fa5af08f8180771bdd095373d8dde8c5ab59a27dea7a9b8
title: workflow-aware-idle-reaper
type: adr
goal: 'Make the Claude PTY session idle reaper and the resident-session budget enforcer in `AgentCoordinator` workflow-aware: a chat whose on-disk workflow registry reports a run with `status: "running"` must NOT have its warm PTY session torn down by `sweepIdleClaudeSessions` (idle ≥ `idleTimeoutMs`) nor evicted by `enforceClaudeSessionBudget` (resident > `maxConcurrent`). This stops Kanna from killing the host process out from under an in-flight background Workflow.'
status: implemented
date: "2026-06-03"
---

## Goal

Make the Claude PTY session idle reaper and the resident-session budget enforcer in `AgentCoordinator` workflow-aware: a chat whose on-disk workflow registry reports a run with `status: "running"` must NOT have its warm PTY session torn down by `sweepIdleClaudeSessions` (idle ≥ `idleTimeoutMs`) nor evicted by `enforceClaudeSessionBudget` (resident > `maxConcurrent`). This stops Kanna from killing the host process out from under an in-flight background Workflow.

## Context

A background Claude Code Workflow runs inside the warm PTY claude process Kanna keeps per chat. When the main turn ends, the chat registers no `activeTurn`, adds no `pendingPromptSeqs`, and never bumps `lastUsedAt` (only `result`/`interrupted` events do). So `isClaudeSessionIdle` (`agent.ts:1345`) judges the chat idle after `idleTimeoutMs` (default 600_000) and `closeClaudeSession` → `session.session.close()` kills the PTY process tree, aborting the workflow.

Observed in session `de4c6a76` (run `wf_5350e128-922`): last turn ended 13:24:33Z, idle reaper fired at +600s (~13:34:33Z — matches the closing file-history-snapshot), PTY killed, the on-disk sidecar `wf_5350e128-922.json` flipped to `status:"killed"` ("Workflow aborted"), losing in-flight agents. The #357 self-scheduled-wake mitigation does not cover this: its protective 120s `pending_workflow` wake is suppressed by the `if (live !== null) return` guard whenever the model has set its own longer `agent_wakeup` (the harvest prompt explicitly tells the model to "wait longer", so it sets 1200s > 600s idle), and a 1200s wake fires after the 600s reaper already killed the process.

Topology: `c3-210 agent-coordinator` owns the reaper/budget logic and already holds `this.workflowRegistry` (wired in `server.ts`). `c3-229 workflow-status` owns `WorkflowRegistry.snapshot(chatId): WorkflowRunSummary[]` whose `status` field is the authoritative liveness signal (verified terminal on abort: a killed run reads `status:"killed"`, not stale `"running"`).

## Decision

Add a private `hasLiveWorkflow(chatId)` to `AgentCoordinator` that returns `true` iff `this.workflowRegistry?.snapshot(chatId)` contains a run with `status === "running"`. Add this as an early-return `false` guard inside `isClaudeSessionIdle` (alongside the existing `activeTurns` / `pendingPromptSeqs` guards) and as an extra predicate in the `enforceClaudeSessionBudget` candidate filter so a workflow-hosting session is neither swept nor evicted while a run is live.

This consumes the existing #358 read-model rather than inventing new lifecycle state — the sidecar `status` is already watched live and is written terminal on process death, so it cannot strand a session in a false `"running"` state on a clean kill. It is the smallest correct change: no new event types, no driver changes, no clamp on wake delays. Wake-delay clamping (option 2) is deferred — the registry guard removes the root cause directly; clamping is a redundant belt that can land later if a hung-but-`running` workflow ever proves to strand a session.

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-210 | component | isClaudeSessionIdle + enforceClaudeSessionBudget + new hasLiveWorkflow helper change session-teardown decisions | Comply with event-sourcing/provider-adapter refs + strong-typing + colocated-bun-test rules; add unit tests in agent.test.ts |
| c3-229 | component | Consumed read-only via WorkflowRegistry.snapshot(chatId).status; no contract change, but the consumer relationship is new | Confirm no Contract change to c3-229; record consumer wiring; no Parent Delta to its surface |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-cqrs-read-models | The fix reads the derived WorkflowRegistry snapshot (read path) to drive a coordinator decision; must consume the read-model, not replay the log | comply |
| ref-strong-typing | hasLiveWorkflow crosses the coordinator↔read-model boundary; must use named WorkflowRunSummary / WorkflowStatus types, no any | comply |
| ref-event-sourcing | Reaper decision only reads a snapshot and emits no new event; must not mutate or depend on un-derived state | comply |
| ref-colocated-bun-test | New agent.ts behavior needs colocated agent.test.ts cases (cited by c3-210) | comply |
| ref-provider-adapter | Cited by c3-210/c3-229; this change touches session-teardown timing, not provider transcript normalization | N.A - no provider adapter surface touched |
| ref-side-effect-adapter | Cited by c3-229; the guard reads an in-memory snapshot, adds no node:fs/spawn/IO | N.A - no new side effect introduced |
| ref-tool-hydration | Cited by c3-210/c3-229; no Workflow tool_use hydration path changes | N.A - tool hydration unchanged |
| ref-ws-subscription | Cited by c3-229; no WebSocket envelope or topic surface changes | N.A - no WS surface touched |
| ref-zustand-store | Cited by c3-229; no client UI store changes | N.A - server-only change |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-colocated-bun-test | New behavior in agent.ts needs colocated tests in agent.test.ts covering idle-guard and budget-guard with a fake workflow registry | comply |
| rule-strong-typing | The snapshot predicate types against WorkflowRunSummary["status"]; no untyped literals at the coordinator↔registry boundary | comply |
| rule-zustand-store | Cited by c3-229; no client Zustand store added or changed | N.A - server-only change |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| Helper | Add private hasLiveWorkflow(chatId: string): boolean reading this.workflowRegistry?.snapshot(chatId).some(r => r.status === "running") ?? false | src/server/agent.ts |
| Idle guard | In isClaudeSessionIdle, add if (this.hasLiveWorkflow(chatId)) return false after the pendingPromptSeqs guard | src/server/agent.ts:1345 |
| Budget guard | In enforceClaudeSessionBudget candidate filter, add && !this.hasLiveWorkflow(chatId) | src/server/agent.ts:1383 |
| Tests | TDD: idle-not-reaped when a run is running; reaped when completed/killed/none; budget keeps a live-workflow session resident; fake WorkflowRegistry injected via existing args.workflowRegistry | src/server/agent.test.ts |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| N.A - no C3 CLI underlay touched | This ADR changes runtime coordinator logic only; no c3x command, validator, schema, hint, or template is modified | c3x check passes unchanged after ADR + code |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| agent.test.ts idle-guard test | Fails if a session with a running workflow is reaped by the sweep | bun test src/server/agent.test.ts |
| agent.test.ts budget-guard test | Fails if enforceClaudeSessionBudget evicts a session hosting a running workflow | bun test src/server/agent.test.ts |
| bun run lint | Fails on any/untyped boundary or side-effect-seal violation in the new helper | CI lint gate |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Clamp schedule_wakeup delay to < idleTimeoutMs (option 2) | Indirect — only narrows the race window; a workflow longer than the clamp still gets killed across multiple wake cycles, and it fights the #357 "wait longer" prompt. Registry guard removes the root cause. Deferred as optional belt. |
| Keep the 120s protective wake armed even when a longer schedule is live | Burns the maxAgentWakes (25) cap every 2 min and re-enters the chat needlessly while the workflow is healthy; treats the symptom, not the reaper. |
| Bump lastUsedAt from the workflow watcher | Couples the read-model into the write-path heartbeat, fragile to watch latency, and still leaves budget eviction unguarded. |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| A genuinely hung workflow stuck at status:"running" strands the session forever (no idle reap, no budget evict) | Claude writes terminal status (killed/failed/completed) on abort/exit (verified on wf_5350e128-922.json); the workflow runtime has its own agent-count + timeout caps; cancelChat/killPtyInstance remain available as manual escape | Inspect sidecar status transitions; manual killPtyInstance path unaffected |
| maxConcurrent budget exceeded when >N chats each host a live workflow | Intended: a soft resident cap must not abort live work; excess is bounded by real workflow concurrency, not unbounded idle sessions | Budget-guard test asserts live-workflow sessions are skipped, idle ones still evicted |
| Registry returns empty (sidecar dir not yet registered / SDK driver) | hasLiveWorkflow returns false → falls back to existing behavior, no regression | Idle/budget tests with null registry assert unchanged legacy behavior |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/agent.test.ts | All pass incl. new idle-guard + budget-guard cases |
| bun run lint | 0 errors, no new warnings above cap |
| c3x check | PASS (no drift) |
