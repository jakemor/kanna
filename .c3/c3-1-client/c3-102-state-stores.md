---
id: c3-102
title: state-stores
type: component
category: foundation
parent: c3-1
goal: Hold UI-local state (chat input, terminal layout, sidebar, preferences) in small Zustand stores, persisting only what must survive reload.
uses:
    - ref-zustand-store
    - ref-strong-typing
    - ref-colocated-bun-test
c3-version: 4
---

# state-stores
## Goal

Hold UI-local state (chat input, terminal layout, sidebar, preferences) in small Zustand stores, persisting only what must survive reload.
## Container Connection

Gives features a place to keep UI state without pushing it into React context or the server. Without it, the client would need a global store or ad-hoc hooks.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Typed hooks per concern | c3-110 |
| OUT (provides) | Chat input + preferences stores | c3-115 |
| OUT (provides) | Sidebar state | c3-111 |
| OUT (provides) | Chat page layout state | c3-112 |
| OUT (provides) | Settings preferences | c3-116 |
| OUT (provides) | Terminal layout + preferences | c3-118 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|------|------|
| ref-zustand-store | Codifies the per-concern store pattern |
| ref-strong-typing | Each store exports typed selectors |
| ref-colocated-bun-test |  |
## Layer Constraints

This component operates within these boundaries:

**MUST:**
- Focus on single responsibility within its domain
- Cite refs for patterns instead of re-implementing
- Hand off cross-component concerns to container

**MUST NOT:**
- Import directly from other containers (use container linkages)
- Define system-wide configuration (context responsibility)
- Orchestrate multiple peer components (container responsibility)
- Redefine patterns that exist in refs
