---
id: c3-110
title: app-shell
type: component
category: feature
parent: c3-1
goal: 'Own the top-level React shell: routing, Kanna state hook (useKannaState), socket wiring, global keybindings, and layout chrome.'
uses:
    - ref-ws-subscription
    - ref-cqrs-read-models
c3-version: 4
---

# app-shell
## Goal

Own the top-level React shell: routing, Kanna state hook (useKannaState), socket wiring, global keybindings, and layout chrome.
## Container Connection

Entry point for every client feature — without it, pages have no router, no shared state, and no socket.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Socket transport | c3-101 |
| IN (uses) | Stores for preferences + layout | c3-102 |
| IN (uses) | Primitives | c3-103 |
| OUT (provides) | Router-mounted chat page | c3-112 |
| OUT (provides) | Router-mounted settings | c3-116 |
| OUT (provides) | Router-mounted projects page | c3-117 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Shell opens the socket and threads snapshots through useKannaState |
| ref-cqrs-read-models | Shell consumes derived snapshots, never the raw event log |
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
