---
id: c3-216
title: terminal-manager
type: component
category: feature
parent: c3-2
goal: Spawn and manage PTY sessions for the embedded xterm terminal; stream I/O over WS.
uses:
    - ref-ws-subscription
c3-version: 4
---

# terminal-manager
## Goal

Spawn and manage PTY sessions for the embedded xterm terminal; stream I/O over WS.
## Container Connection

Backs the terminal workspace component; without it there is no shell in the UI.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Process utils | c3-209 |
| OUT (provides) | PTY sessions | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Terminal bytes flow over the same socket |
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
