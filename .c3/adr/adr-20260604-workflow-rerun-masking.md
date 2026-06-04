---
id: adr-20260604-workflow-rerun-masking
c3-seal: 06938fa4bff45257107c9e2f71815b4157fa82c460420c75c1f4c26de2518fe5
title: workflow-rerun-masking
type: adr
goal: |-
    Stop the WorkflowRegistry read-model from showing a stale terminal `failed`
    sidecar when a later workflow launch has reused the same `runId` and is
    actively running. When Claude Code relaunches a workflow via `scriptPath`
    (the persisted script filename embeds the `runId`), the re-run reuses that
    `runId` but mints a new `taskId`, pours its agents into the same
    `subagents/workflows/wf_<runId>/` live dir, and does NOT rewrite the prior
    sidecar until it terminates. The registry currently lets the prior
    `failed` sidecar permanently mask the live re-run, so the panel shows a
    finished run while 40+ agents are actually running. The decision: in
    `snapshot()` and `getRun()`, a terminal sidecar that is the no-op crash
    shape (`status=failed`, `agentCount=0`, empty `agents`) must NOT mask a
    fresh, non-empty live journal for the same `runId` — surface a synthetic
    `running` row enriched from the journal instead.
status: implemented
date: "2026-06-04"
uses:
    - c3-229
---

# workflow-rerun-masking

## Goal

Stop the WorkflowRegistry read-model from showing a stale terminal `failed`
sidecar when a later workflow launch has reused the same `runId` and is
actively running. When Claude Code relaunches a workflow via `scriptPath`
(the persisted script filename embeds the `runId`), the re-run reuses that
`runId` but mints a new `taskId`, pours its agents into the same
`subagents/workflows/wf_<runId>/` live dir, and does NOT rewrite the prior
sidecar until it terminates. The registry currently lets the prior
`failed` sidecar permanently mask the live re-run, so the panel shows a
finished run while 40+ agents are actually running. The decision: in
`snapshot()` and `getRun()`, a terminal sidecar that is the no-op crash
shape (`status=failed`, `agentCount=0`, empty `agents`) must NOT mask a
fresh, non-empty live journal for the same `runId` — surface a synthetic
`running` row enriched from the journal instead.

## Context

Reproduced in chat `5f78aa43` (cwd `pvs-core-i-full`). Launch 1
(`Workflow({name})`, taskId `wdd2dyoww`) crashed at script eval
(`TypeError: 'safeDirs.length'`) with 0 agents and wrote a terminal
`failed` sidecar `wf_ca5a4465-d00.json`. The model fixed the script and
relaunched via `Workflow({scriptPath: ".../sonar-sweep-remaining-wf_ca5a4465-d00.js"})`
(taskId `w9mwas7qa`), which reused `runId` `wf_ca5a4465-d00` and ran 40+
real agents (11:34→11:43, 74 distinct agentIds in `journal.jsonl`). The
sidecar was never refreshed; the panel showed `FAILED` and never the
running re-run. Constraint: WorkflowRegistry is bound by the c3-225
sole-event-source invariant — it must NOT read the HarnessEvent transcript,
so the strong identity (`taskId`, unique per launch) is unavailable
server-side; only disk artifacts (sidecar + live journal) may be consulted.
mtime ordering is too weak (fs granularity, buffered flush races,
shared-dir interleave); a naive "any live agentId beyond the sidecar →
running" signal false-positives on genuinely `completed` runs (validated:
several completed runs have 2–4 journal agentIds absent from
`workflowProgress`). Affected topology: c3-229 (workflow-status) only.

## Decision

Add a content-based predicate `isStaleCrashSidecar(run)` =
`status === "failed" && (agentCount ?? 0) === 0 && agents.length === 0`.
In `snapshot()` and `getRun()`, a sidecar passing this predicate is treated
as overridable: when the same `runId`'s live run dir is fresh (within the
existing `SNAPSHOT_LIVE_WINDOW_MS`) AND its `journal.jsonl` yields ≥1 agent,
emit a synthetic `running` row enriched from the journal instead of the
stale `failed` sidecar. A non-crash terminal sidecar
(`completed`/`killed`/`failed-with-agents`) still wins unconditionally, and
a crash sidecar with no fresh/non-empty journal still shows `failed`
(truthful). This wins over mtime comparison because `agentCount===0` means
the sidecar's run did literally nothing, so any journal agent can only
belong to a later run reusing the dir — a monotonic, clock-independent fact
that is safe under concurrency. Validated across 31 real runs: the
predicate flags exactly the one re-run (`wf_ca5a4465-d00`) and zero of the
12 completed / 16 killed / 2 true-crash runs. Coverage is intentionally
narrow (re-run over a crashed-at-launch run — the only path that reuses a
`runId` in practice, since the `runId` is embedded in the relaunched script
filename); re-run over a completed/killed run is out of scope and noted.
Client polish: `ToolCallMessage` joins a launch card to a run by exact
`taskId`; lock that the card for a launch whose `taskId` has no matching
run row renders the "started…" pill (never a stale failed run) — already
the behavior; add a regression test since the synthetic running row carries
no `taskId` (live dir has none) and cannot be bound to the card within
c3-225.

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-229 | component | Owns WorkflowRegistry snapshot/getRun semantics and the workflow ToolKind hydration consumed by ToolCallMessage; the masking rule and the contract text for snapshot/getRun change here | Update Contract rows for snapshot + getRun; verify c3-225 sole-event-source invariant still holds (no HarnessEvent read) |
| c3-2 | container | Parent container (server) hosting the read-model; no structural/boundary delta — surface signatures unchanged | Parent Delta: no-delta, contract semantics refined within existing API |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-cqrs-read-models | Registry stays a pure read-model deriving views from disk; the override reads only the existing disk journal, never writes | comply |
| ref-side-effect-adapter | All new disk reads (journal for the override) go through workflow-watch-io.adapter.ts via the already-wired readRunJournal/listRunDirs deps; no fs in workflow-registry.ts | comply |
| ref-strong-typing | isStaleCrashSidecar takes/returns named types (WorkflowRun→boolean); no any, no new untyped boundary shape | comply |
| ref-event-sourcing | SCOPED OVERRIDE (adr-20260603-workflow-disk-watch-read-model): state is disk-derived; this change stays inside that override and the c3-225 invariant (no HarnessEvent / no taskId from transcript) | comply |
| ref-provider-adapter | Registry remains PTY-only; the override adds no SDK-path coupling and no provider branching | review |
| ref-tool-hydration | Workflow ToolKind hydration is unchanged; the client polish only refines the taskId join, not hydration | review |
| ref-ws-subscription | WorkflowsSnapshot envelope shape is unchanged; the override emits the same WorkflowRunSummary row type over the same topic | comply |
| ref-zustand-store | workflowsStore stays WS-fed; client polish reads the snapshot via props, never caches server truth | comply |
| ref-colocated-bun-test | New cases land in colocated workflow-registry.test.ts / ToolCallMessage.test.tsx | comply |
| ref-local-first-data | Not cited by c3-229 and not touched here: workflow state is an external Claude Code disk sidecar, no Kanna local-first persisted store is read or written | N.A - ref not used by c3-229 |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-strong-typing | New predicate + altered snapshot/getRun branches cross the registry boundary; must stay named-typed, no any | comply |
| rule-colocated-bun-test | New cases must land in the colocated workflow-registry.test.ts; client case in ToolCallMessage.test.tsx | comply |
| rule-zustand-store | Client polish must not cache server truth in a store; workflowsStore stays WS-fed and the card reads the snapshot via existing props | comply |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| Server predicate | Add isStaleCrashSidecar(run: WorkflowRun): boolean = failed && agentCount 0 && agents empty | src/server/workflow-registry.ts |
| Server snapshot() | In the listRunDirs loop, allow override of a merged entry when it isStaleCrashSidecar and the live journal (read only in that case) is non-empty + fresh; emit enriched synthetic running row | src/server/workflow-registry.ts |
| Server getRun() | Return sidecar only when !isStaleCrashSidecar; otherwise fall through to live-dir synthesis, but fall back to the failed sidecar when the live journal is empty / dir not fresh | src/server/workflow-registry.ts |
| Server tests | Cases: stale-crash sidecar + fresh non-empty journal → running; completed/killed sidecar → unchanged; crash sidecar + empty journal → failed; no-sidecar + live → running (existing) | src/server/workflow-registry.test.ts |
| Client polish | Lock taskId-exact join: card whose taskId has no run row renders StartedPill, never a mismatched run | src/client/components/messages/ToolCallMessage.tsx, ToolCallMessage.test.tsx |
| Doc sync | Update c3-229 Contract rows (snapshot/getRun) to state crash-sidecar override; CLAUDE.md Workflow Status Panel note | .c3 via c3x write; CLAUDE.md |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| N.A - no C3 CLI/validator/schema/template/help change | This ADR changes product code under c3-229 only; it does not touch the c3x CLI, its validators, schemas, hints, or templates | c3x check passes unchanged after the c3-229 Contract-row doc update |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| bun test src/server/workflow-registry.test.ts | Fails if a stale-crash sidecar masks a fresh live re-run, or if a completed/killed sidecar is wrongly overridden | src/server/workflow-registry.test.ts |
| bun test src/client/components/messages/ToolCallMessage.test.tsx | Fails if a launch card binds to a run whose taskId differs | src/client/components/messages/ToolCallMessage.test.tsx |
| bunx tsc --noEmit | Fails on any untyped boundary in the new predicate / branches | tsconfig |
| bun run lint | Fails if any fs call leaks into workflow-registry.ts (side-effect seal) | eslint.config.js |
| c3x check | Fails if c3-229 Contract drifts from the new snapshot/getRun semantics | .c3/c3-2-/c3-229-.md |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Compare sidecar mtime vs live-dir newestMtimeMs (live newer → running) | Clock-based: fs mtime granularity + buffered/fsync ordering + shared-dir interleave make it racy; a genuinely-finished run with a trailing agent flush would ghost as running. User flagged it as too weak. |
| Naive agentId set-difference (any live agentId not in sidecar → running) | Validated false-positive: several completed runs have 2–4 journal agentIds absent from workflowProgress → would ghost finished runs as running. |
| Read taskId from the transcript to disambiguate launches server-side | Violates the c3-225 sole-event-source invariant — WorkflowRegistry must not couple to the HarnessEvent stream. |
| Resolve staleness entirely on the client using transcript taskId ordering | Client never receives a row for the masked re-run (server suppresses it), so there is nothing to re-render; the fix must originate server-side. |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Override ghosts a real failed-at-launch run that never re-ran | Predicate also requires a non-empty live journal + freshness; a true crash has an empty journal (validated: wf_13d6d464, wf_a727ef61 → journal 0, not flagged) | bun test src/server/workflow-registry.test.ts (crash+empty-journal → failed) |
| Re-run over a completed/killed run not surfaced as running | Out of scope by design; documented; such reuse is rare (runId reuse comes from relaunching the crashed run's persisted script). log()/doc note only | Doc note in c3-229 + CLAUDE.md; no false claim of full coverage |
| Per-run journal read in snapshot adds IO cost | Journal read is gated behind isStaleCrashSidecar(existing) — only the rare crash-sidecar case reads it; the common no-sidecar synthetic path stays journal-free | Code review of snapshot() branch ordering |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/workflow-registry.test.ts | pass (new crash-override + non-regression cases green) |
| bun test src/client/components/messages/ToolCallMessage.test.tsx | pass (taskId-exact join locked) |
| bunx tsc --noEmit | pass (no type errors) |
| bun run lint | pass (no side-effect seal breach, 0 warnings) |
| c3x check | pass (c3-229 Contract matches code) |
