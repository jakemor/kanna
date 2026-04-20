---
id: c3-208
title: ws-router
type: component
category: foundation
parent: c3-2
goal: 'Multiplex WS traffic: route subscribe/unsubscribe/command envelopes, push projections on every state change.'
uses:
    - ref-ws-subscription
    - ref-cqrs-read-models
    - ref-colocated-bun-test
c3-version: 4
---

# ws-router
## Goal

Multiplex WS traffic: route subscribe/unsubscribe/command envelopes, push projections on every state change.
## Container Connection

The wire between read-models and every connected client.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Read models | c3-207 |
| IN (uses) | Agent coordinator for commands | c3-210 |
| IN (uses) | Protocol types | c3-302 |
| OUT (provides) | Subscribe/command dispatch | c3-202 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|------|------|
| ref-ws-subscription | Defines the router envelope and dispatch rules |
| ref-cqrs-read-models | Only projections cross the wire |
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
