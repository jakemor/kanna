---
id: c3-202
title: http-ws-server
type: component
category: foundation
parent: c3-2
goal: Serve HTTP (static + API) and upgrade to WebSocket; attach auth gating; expose /health.
uses:
    - ref-ws-subscription
    - ref-local-first-data
c3-version: 4
---

# http-ws-server
## Goal

Serve HTTP (static + API) and upgrade to WebSocket; attach auth gating; expose /health.
## Container Connection

The network surface of the server. Without it, no client can reach read models or agent turns.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Auth gate | c3-203 |
| IN (uses) | WS router | c3-208 |
| OUT (provides) | HTTP + WS endpoints | c3-101 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Upgrades one WS per client, handed to ws-router |
| ref-local-first-data | Default bind is 127.0.0.1 |
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
