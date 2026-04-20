---
id: ref-zustand-store
title: Zustand Store Pattern
goal: Client UI state lives in small Zustand stores scoped by concern (chat input, preferences, sidebar, terminal), persisted selectively via localStorage.
c3-version: 4
---

# zustand-store
## Goal

Client UI state lives in small Zustand stores scoped by concern (chat input, preferences, sidebar, terminal), persisted selectively via localStorage.
## Choice

One store per concern under src/client/stores/. Prefer selectors + shallow equality. Persist via zustand/middleware when state must survive reloads.
## Why

Lightweight, no Provider tree, easy to test. Aligns with server-pushed snapshots (stores only hold UI-local state, server state comes via socket).
## How

| Guideline | Example |
|-----------|---------|
| One concern per store file | chatInputStore, rightSidebarStore |
| Colocate a *.test.ts | chatInputStore.test.ts |
| Never store server-derived truth | server snapshots live in useKannaState hook, not a store |
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
