---
id: c3-101
title: socket-client
type: component
category: foundation
parent: c3-1
goal: Maintain the single WebSocket to the backend, decode typed envelopes, and dispatch commands + subscription push messages.
uses:
    - ref-ws-subscription
    - ref-strong-typing
c3-version: 4
---

# socket-client
## Goal

Maintain the single WebSocket to the backend, decode typed envelopes, and dispatch commands + subscription push messages.
## Container Connection

Provides the transport every other client component depends on. Without it the client has no way to reach the server, subscribe to snapshots, or send commands.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Wire protocol envelopes | c3-302 |
| IN (uses) | Ports + dev-ports config | c3-304 |
| OUT (provides) | Socket client + subscribe/command API | c3-110 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Single WS + typed envelope exactly matches this component's shape |
| ref-strong-typing | Decoded envelopes are typed, not parsed as any |
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
