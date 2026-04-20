---
id: c3-118
title: terminal-workspace
type: component
category: feature
parent: c3-1
goal: Host the embedded xterm terminal panel with layout animation + resize + preference persistence.
uses:
    - ref-zustand-store
    - ref-ws-subscription
c3-version: 4
---

# terminal-workspace
## Goal

Host the embedded xterm terminal panel with layout animation + resize + preference persistence.
## Container Connection

Keeps shell work next to agent work without leaving the chat page.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Terminal layout + preference stores | c3-102 |
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Server terminal manager | c3-216 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-zustand-store | Terminal layout persisted per user |
| ref-ws-subscription | Terminal I/O streamed via WS |
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
