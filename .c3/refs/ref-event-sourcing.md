---
id: ref-event-sourcing
title: Event Sourcing
goal: Every state mutation is first captured as an immutable event appended to a JSONL log; system state is derived by replay + periodic snapshot compaction.
c3-version: 4
---

# event-sourcing
## Goal

Every state mutation is first captured as an immutable event appended to a JSONL log; system state is derived by replay + periodic snapshot compaction.
## Choice

Append-only JSONL event logs (projects, chats, messages, turns) plus a compacted snapshot.json — no database. Implemented by src/server/event-store.ts and src/server/events.ts.
## Why

Zero-infra (no DB), crash-safe, human-inspectable, replayable for bug triage. Snapshots keep cold-start fast; replay tail handles recent events. Natural fit for a local-first single-user tool.
## How

| Guideline | Example |
|-----------|---------|
| Mutations always emit an event first, derivations follow | agent-coordinator appends turn events; read-models react |
| Events are append-only; never rewrite history | use new events for corrections, never edit log |
| Compact when log exceeds 2 MB | snapshot.json generated on startup |
## Not This

<!-- Alternatives we rejected and why -->

| Alternative | Rejected Because |
|-------------|------------------|
| ... | ... |
## Scope

<!-- Where does this choice apply? Be explicit about exclusions. -->

**Applies to:**
- <!-- containers/components where this ref governs behavior -->

**Does NOT apply to:**
- <!-- explicit exclusions -->
## Override

<!-- How to deviate from this choice when justified -->

To override this ref:
1. Document justification in an ADR under "Pattern Overrides"
2. Cite this ref and explain why the override is necessary
3. Specify the scope of the override (which components deviate)
## Cited By

<!-- Updated when components cite this ref -->
- c3-{N}{NN} ({component name})
