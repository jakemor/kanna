---
id: c3-229
c3-seal: 1528d5418749edf204f2ede1dc7ce71261d4743abda37c8682a458a7a125088f
title: workflow-status
type: component
category: feature
parent: c3-2
goal: Watch Claude Code `wf_<runId>.json` sidecar files from disk, maintain a per-chat in-memory WorkflowRegistry read-model, and broadcast WorkflowsSnapshot updates to subscribing clients over the `workflows` WebSocket topic.
uses:
    - ref-cqrs-read-models
    - ref-event-sourcing
    - ref-provider-adapter
    - ref-side-effect-adapter
    - ref-strong-typing
    - ref-tool-hydration
    - ref-ws-subscription
    - ref-zustand-store
    - rule-colocated-bun-test
    - rule-strong-typing
    - rule-zustand-store
---

# workflow-status

## Goal

Watch Claude Code `wf_<runId>.json` sidecar files from disk, maintain a per-chat in-memory WorkflowRegistry read-model, and broadcast WorkflowsSnapshot updates to subscribing clients over the `workflows` WebSocket topic.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | Broadcast derived read models — supplies the workflow projection the ws-router broadcasts |
| Category | feature |
| Lifecycle | Singleton registry per server; per-chat disk-watchers created on PTY spawn, torn down on session close |
| Replaceability | Replaceable while WorkflowsSnapshot shape and watch/unwatch API are preserved |

## Purpose

Owns the workflow sidecar read-model lifecycle: receives `watch(chatId, dir)` / `unwatch(chatId)` calls from `claude-pty-driver` (c3-225), delegates all IO to `workflow-watch-io.adapter.ts` (the sole adapter), maintains per-chat WorkflowsSnapshot in memory, and notifies subscribers on every disk change. Also owns the `workflow` ToolKind normalization in `src/shared/tools.ts` that converts the `Workflow` tool_use transcript entry into a hydrated inline card for the UI. Non-goals: emitting Kanna JSONL events for workflow state, driving turn lifecycle, writing to disk.

**Override of ref-event-sourcing (scoped):** This read-model is disk-fed, not event-sourced from the Kanna event log (c3-206). The Claude Code `wf_<runId>.json` sidecars are external filesystem artifacts; duplicating them into the Kanna event log would pollute the append-only log with non-Kanna mutations. This exception is limited to WorkflowRegistry only and is documented in ADR `adr-20260603-workflow-disk-watch-read-model`.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | PTY session started; workflows directory path known | c3-225 |
| Input — disk adapter | workflow-watch-io.adapter.ts lists, reads, and watches wf_*.json files; emits debounced change events | ref-side-effect-adapter |
| Input — agent-coordinator | Constructs WorkflowRegistry singleton and passes it to PTY driver at spawn | c3-210 |
| Input — ws-router | Calls registry.subscribe(chatId, cb) to receive snapshot pushes for WS broadcast | c3-208 |
| Initialization | registry.watch(chatId, dir) called by c3-225 on PTY spawn; registry.unwatch(chatId) on close | c3-225 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | UI clients see live workflow run progress without polling | c3-101 |
| Primary path | PTY writes wf_<runId>.json → adapter detects change → registry updates snapshot → WS push to subscriber | c3-208 |
| Alternate — initial subscribe | Client subscribes → ws-router calls registry.getSnapshot(chatId) → full snapshot pushed immediately | c3-208 |
| Alternate — getRun command | Client sends workflows.getRun → ws-router calls registry.getRun(chatId, runId) → typed response | c3-302 |
| Failure — dir not found | adapter returns empty snapshot; re-arms parent watcher; recovers when dir is created | ref-side-effect-adapter |
| Failure — unwatch missing | unwatch(chatId) is idempotent; no-op if chatId not registered | c3-225 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-cqrs-read-models | ref | WorkflowRegistry is a read-model: read path (snapshot + WS push) separated from write path (disk sidecar) | primary | Registry never writes to disk |
| ref-ws-subscription | ref | workflows topic follows the single-socket subscribe/command/push envelope contract in protocol.ts | primary | WorkflowsSnapshot and getRun use shared typed envelopes |
| ref-side-effect-adapter | ref | All fs.watch/readFile/readdir calls live in workflow-watch-io.adapter.ts only; domain files stay pure | primary | ESLint seal enforces mechanically |
| ref-provider-adapter | ref | WorkflowRegistry is PTY-only; SDK driver must not wire it; wiring is conditional on driver type | primary | registry is undefined when SDK driver is active |
| ref-tool-hydration | ref | workflow ToolKind added to tools.ts; WorkflowMessage.tsx dispatches on kind | primary | Hydration normalizes Workflow tool_use into inline card |
| ref-strong-typing | ref | WorkflowsSnapshot, WorkflowRunSummary, WorkflowRunFile are named exports; no any at WS boundary | primary | Types declared in src/shared/workflow-types.ts |
| ref-zustand-store | ref | workflowsStore.ts is a scoped Zustand store holding server-pushed workflow state | primary | Never independently cache truth; re-populate from WS subscription |
| ref-event-sourcing | ref | SCOPED OVERRIDE: workflow state is derived from disk sidecars, not from the Kanna event log. Override documented in adr-20260603-workflow-disk-watch-read-model | override | Exception limited to WorkflowRegistry only |
| rule-strong-typing | rule | All boundary types crossing WS or module boundaries must be named TypeScript exports | primary | bunx tsc --noEmit enforces |
| rule-colocated-bun-test | rule | workflow-types.test.ts, workflow-watch-io.adapter.test.ts, workflow-registry.test.ts colocated next to impl | primary | bun test enforces by path convention |
| rule-zustand-store | rule | workflowsStore.ts follows one-concern-per-store and subscribes via WS, not direct server import | primary | Store subscribes to socket topic on mount |
| adr-20260603-workflow-disk-watch-read-model | adr | Work order authorizing this component and its disk-watch design | primary | Must be accepted before implementation |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| WorkflowRegistry.watch(chatId, dir) | IN | Register a per-chat workflows directory for disk-watching; idempotent on re-call with same dir | c3-225 | src/server/workflow-registry.ts |
| WorkflowRegistry.unwatch(chatId) | IN | Tear down all fs.watch handles for the chat; idempotent if chatId not registered | c3-225 | src/server/workflow-registry.ts |
| WorkflowRegistry.snapshot(chatId) | OUT | Return WorkflowRunSummary[] = terminal sidecar runs MERGED with synthetic running rows from live run dirs (no sidecar yet, fresh within 10m); sidecars win | c3-208 | src/server/workflow-registry.ts |
| WorkflowRegistry.getRun(chatId, runId) | OUT | Return single WorkflowRun or null; mirrors snapshot — a running run with no sidecar yet is synthesized from its live dir and (when readRunJournal is wired) enriched with agents[] + agentCount derived from the live journal.jsonl | c3-208 | src/server/workflow-registry.ts |
| WorkflowRegistry.hasActiveRun(chatId, freshnessMs, now) | OUT | True when a live run dir (subagents/workflows/wf_*) saw activity within freshnessMs AND has no terminal sidecar yet; the in-run liveness signal for the idle reaper / budget enforcer | c3-210 | src/server/workflow-registry.ts |
| listWorkflowRunDirs(workflowsDir) | OUT | Adapter: list live run dirs subagents/workflows/wf_* with newest file mtime; the live signal Claude writes from second one (unlike the terminal sidecar) | c3-210 | src/server/workflow-watch-io.adapter.ts |
| watchWorkflowRunDirs(workflowsDir, cb) | IN | Adapter: watch the live run-dir root so a launch (no sidecar yet) pushes a snapshot promptly | c3-302 | src/server/workflow-watch-io.adapter.ts |
| readWorkflowRunJournal(workflowsDir, runId) | OUT | Adapter: parse subagents/workflows/<runId>/journal.jsonl into WorkflowJournalEntry[] (defensive; [] when missing/unreadable); the live per-agent signal getRun uses to enrich a running run | c3-208 | src/server/workflow-watch-io.adapter.ts |
| WorkflowRegistry.subscribe(chatId, cb) | IN/OUT | Register callback invoked on every snapshot change; returns unsubscribe fn | c3-208 | src/server/workflow-registry.ts |
| WorkflowsSnapshot WS push | OUT | Typed envelope for WS push on the workflows topic | c3-302 | src/shared/workflow-types.ts |
| workflow ToolKind | OUT | Normalized hydrated transcript entry for Workflow tool_use dispatched to WorkflowMessage.tsx | c3-303 | src/shared/tools.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Violating c3-225 sole-event-source invariant | Any code in workflow-status imports from or writes to the HarnessEvent stream | bun test src/server/workflow-registry.test.ts fails if HarnessEvent coupling introduced | bun test src/server/workflow-registry.test.ts |
| fs.watch handle leak | unwatch(chatId) not called on PTY session close | Registry holds stale watchers; memory grows per chat | bun test src/server/workflow-registry.test.ts |
| ESLint side-effect seal breach | fs.watch/readFile called outside *.adapter.ts file | bun run lint fails with no-restricted-imports error | bun test src/server/workflow-watch-io.adapter.test.ts |
| WorkflowsSnapshot shape drift | Type changed in shared/ without updating ws-router push or client store | bunx tsc --noEmit reports type errors at boundary | bunx tsc --noEmit |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/shared/workflow-types.ts | Contract | Field additions are non-breaking; removals require ADR update | src/shared/workflow-types.ts |
| src/server/workflow-watch-io.adapter.ts | Contract | May add new fs primitives; must stay a leaf module with no domain logic | src/server/workflow-watch-io.adapter.ts |
| src/server/workflow-registry.ts | Contract | Internal data structure may change; public API is the contract | src/server/workflow-registry.ts |
| src/client/stores/workflowsStore.ts | Contract | May add UI-local state fields; must not independently derive server truth | src/client/stores/workflowsStore.ts |
| src/client/app/WorkflowsSection.tsx | Contract | UI layout may change; must not bypass the Zustand store | src/client/app/WorkflowsSection.tsx |
| src/client/components/messages/WorkflowMessage.tsx | Contract | Presentation may change; must dispatch only on kind === workflow | src/client/components/messages/WorkflowMessage.tsx |
| src/server/workflow-registry.test.ts | Change Safety | Test cases per surface | src/server/workflow-registry.test.ts |
| src/server/workflow-watch-io.adapter.test.ts | Change Safety | Debounce, re-arm, error handling coverage | src/server/workflow-watch-io.adapter.test.ts |
| src/shared/workflow-types.test.ts | Change Safety | parseWorkflowRunFile and toRunSummary coverage | src/shared/workflow-types.test.ts |
