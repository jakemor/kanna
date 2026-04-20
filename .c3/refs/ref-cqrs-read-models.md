---
id: ref-cqrs-read-models
title: CQRS Read Models
goal: Separate write path (event log) from read path (derived views) so subscribers consume fast snapshots without replaying the log.
c3-version: 4
---

# cqrs-read-models
## Goal

Separate write path (event log) from read path (derived views) so subscribers consume fast snapshots without replaying the log.
## Choice

read-models.ts projects events into sidebar / chat / project views; ws-router broadcasts those views to subscribers on every state change.
## Why

Keeps UI render paths off the log; allows per-view memoization; lets derived shapes evolve without touching event schema.
## How

| Guideline | Example |
|-----------|---------|
| One read model per UI concern | sidebarView, chatView, projectsView |
| Pure projections — no I/O from derivation | read-models.ts functions are deterministic |
| Broadcast diffs on change, not on request | ws-router pushes on event append |
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
