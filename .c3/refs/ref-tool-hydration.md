---
id: ref-tool-hydration
title: Tool Call Hydration
goal: Provider tool calls (Read, Edit, Bash, plan, diff, ...) are normalized into unified transcript entries by src/shared/tools.ts before rendering.
c3-version: 4
---

# tool-hydration
## Goal

Provider tool calls (Read, Edit, Bash, plan, diff, ...) are normalized into unified transcript entries by src/shared/tools.ts before rendering.
## Choice

One hydration function per tool kind in shared/tools.ts; messages-renderer selects renderer by kind; agent-coordinator emits normalized entries before persisting.
## Why

Renderers stay simple and exhaustive; adding a tool is one shared normalization + one UI renderer; provider-agnostic by construction.
## How

| Guideline | Example |
|-----------|---------|
| Hydration never throws — unknown tools map to generic entry | fallback branch in tools.ts |
| No provider branching in renderers | messages-renderer dispatches on kind only |
| Icons/labels live with hydration, not renderer | keeps hydration self-contained |
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
