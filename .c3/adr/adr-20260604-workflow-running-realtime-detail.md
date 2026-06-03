---
id: adr-20260604-workflow-running-realtime-detail
c3-seal: 056a6033604d64c095593addbdfefd45f3dea6c9b36eabc390ce3cd6b1c0cda8
title: workflow-running-realtime-detail
type: adr
goal: Make the workflow drill-in dialog show live per-agent state for a still-running workflow by parsing the small `subagents/workflows/<runId>/journal.jsonl` server-side in `WorkflowRegistry.getRun`, and have the client re-fetch on each `workflows` snapshot push without a loading flash.
status: implemented
date: "2026-06-04"
---

## Goal

Make the workflow drill-in dialog show live per-agent state for a still-running workflow by parsing the small `subagents/workflows/<runId>/journal.jsonl` server-side in `WorkflowRegistry.getRun`, and have the client re-fetch on each `workflows` snapshot push without a loading flash.

## Context

`getRun` already synthesizes a running `WorkflowRun` when no sidecar exists (PR #365) but with `agents:[]` and `agentCount` undefined, so the dialog body is blank. Claude writes per-agent events live to `journal.jsonl` (started + result lines, ~2KB at 10–20 agents); the heavy `agent-*.jsonl` files and the terminal sidecar carry token/toolcall counts and arrive only at termination. The existing `watchRunDirs` from PR #363 already pushes a `workflows` snapshot on each journal/agent write (debounced 250 ms), so a client effect is enough to keep the dialog live.

## Decision

Server: a new adapter `readWorkflowRunJournal(workflowsDir, runId)` returns parsed `WorkflowJournalEntry[]` (defensive: skips blank/unparseable lines, returns `[]` for missing file). `WorkflowRegistry` gains an optional `readRunJournal?` dep; when `getRun` falls into the synthetic-running path it uses the journal to derive `agents` + `agentCount`. Sidecar runs pass through unchanged.

Client: `WorkflowsSectionWithDetail` adds a `useEffect` keyed on the selected `runId` + `runs` prop. When the dialog is open and the matching run in `runs` is `status:"running"`, it calls `getRunDetail` and swaps the result into `selectedRun` WITHOUT setting `"loading"` first. Stop condition is implicit: when the sidecar lands the run flips to a terminal status and the predicate is false.

No new WS topic, no new store. Reuses the existing snapshot push and `workflows.getRun` command.

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-229 | component | New adapter export + getRun running enrich + Contract rows | Comply with side-effect-adapter, strong-typing, ws-subscription, colocated-bun-test |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-side-effect-adapter | new node:fs read lives in workflow-watch-io.adapter.ts, the exempt leaf | comply |
| ref-strong-typing | WorkflowJournalEntry is a named type at the adapter↔registry boundary | comply |
| ref-cqrs-read-models | getRun enrich stays on the read path; no event emitted | comply |
| ref-ws-subscription | reuses existing workflows topic push, no new envelope | comply |
| ref-colocated-bun-test | adapter + registry + client tests colocated next to the file under test | comply |
| ref-provider-adapter | no provider transcript change | N.A - not touched |
| ref-tool-hydration | no tool_use hydration change | N.A - not touched |
| ref-event-sourcing | read-model only, no event path | N.A - read-model |
| ref-zustand-store | no client store change (effect is local to the component) | N.A - no store |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-colocated-bun-test | new behavior in c3-229 gets colocated tests next to each file under test | comply |
| rule-strong-typing | typed adapter signature + journal entry shape | comply |
| rule-zustand-store | no client Zustand store touched | N.A - server-only data + local component effect |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| Adapter | WorkflowJournalEntry type + readWorkflowRunJournal(workflowsDir, runId) | src/server/workflow-watch-io.adapter.ts |
| Registry | optional readRunJournal? dep; getRun enriches the synthetic running run with agents[] + agentCount derived from the journal | src/server/workflow-registry.ts |
| Wiring | createWorkflowRegistry({ readRunJournal: readWorkflowRunJournal, ... }) | src/server/server.ts |
| Client | WorkflowsSectionWithDetail useEffect re-fetches getRunDetail on runs change while selected run is running; no "loading" swap | src/client/app/WorkflowsSection.tsx |
| Tests | adapter parse/skip/empty; registry getRun running-enrich + sidecar-wins + legacy fallback; client re-fetch + no-flash + stop-at-terminal + render-loop check | adapter.test, registry.test, WorkflowsSection.test |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| N.A - no C3 CLI underlay touched | runtime + read-model + client effect only | c3x check passes |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| workflow-watch-io.adapter.test.ts | Fails if journal parse mishandles started/result/blank/unparseable lines | bun test |
| workflow-registry.test.ts | Fails if getRun does not enrich running, or sidecar does not win, or dep absent regresses | bun test |
| WorkflowsSection.test.tsx | Fails if re-fetch does not fire on snapshot push, or sets "loading" mid-run, or keeps fetching past terminal | bun test |
| bun run lint | Fails on side-effect-seal or any-type violations | CI |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| New WS sub-topic pushing only the selected run's detail | More moving parts (envelope, store, subscription lifecycle) for the same effect the existing workflows push already triggers. |
| Parse agent-*.jsonl for live token/toolcall counts | Heavy (MB per agent, 10–40 agents per run); UI guards != null and the sidecar fills these at termination — out of scope here. |
| Server-side stream of journal events | Couples the read-model to a write-path stream; the watchRunDirs push + lazy parse on getRun is enough. |
| Client polling on a timer | Burns bandwidth and lags vs the existing 250 ms debounced push. |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Re-fetch loop (snapshot push triggers re-fetch triggers …) | getRun is a read command and does not fire the watcher; pushes are bounded by Claude's per-agent file-write cadence | client test asserts bounded fetch count per push |
| Out-of-order re-fetch responses | useEffect cleanup discards stale promise resolutions | client test races two responses |
| Partial-write tail in journal.jsonl | Adapter skips unparseable lines; next write re-fires the watch | adapter test covers blank/unparseable rows |
| Token/toolcall still missing live | Out of scope; UI already guards missing fields, sidecar fills them on terminate | n/a |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/workflow-watch-io.adapter.test.ts src/server/workflow-registry.test.ts src/client/app/WorkflowsSection.test.tsx | all pass |
| bun run lint | 0 errors |
| c3x check | structural PASS |
