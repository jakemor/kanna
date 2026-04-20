---
id: c3-302
title: protocol
type: component
category: foundation
parent: c3-3
goal: Define WebSocket wire envelopes (WsInbound, WsOutbound, subscribe/command kinds, correlation IDs).
uses:
    - ref-ws-subscription
    - ref-strong-typing
c3-version: 4
---

# protocol
## Goal

Define WebSocket wire envelopes (WsInbound, WsOutbound, subscribe/command kinds, correlation IDs).
## Container Connection

The wire contract both sides of the socket respect.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Protocol envelopes | c3-101 |
| OUT (provides) | Protocol envelopes | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Protocol is the shared vocabulary of the subscription pattern |
| ref-strong-typing | Envelopes are discriminated unions |
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
