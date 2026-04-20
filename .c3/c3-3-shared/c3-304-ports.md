---
id: c3-304
title: ports
type: component
category: foundation
parent: c3-3
goal: Centralize default ports and dev-mode port offsets (Vite client + Bun backend).
uses:
    - ref-strong-typing
c3-version: 4
---

# ports
## Goal

Centralize default ports and dev-mode port offsets (Vite client + Bun backend).
## Container Connection

Keeps port defaults in sync between CLI, client build, and dev scripts.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Port constants | c3-201 |
| OUT (provides) | Port constants | c3-202 |
| OUT (provides) | Port constants | c3-101 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-strong-typing | Typed port constants |
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
