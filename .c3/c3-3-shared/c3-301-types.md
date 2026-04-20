---
id: c3-301
title: types
type: component
category: foundation
parent: c3-3
goal: Declare core domain types (projects, chats, turns, transcript entries, provider catalog shape) shared by client and server.
uses:
    - ref-strong-typing
c3-version: 4
---

# types
## Goal

Declare core domain types (projects, chats, turns, transcript entries, provider catalog shape) shared by client and server.
## Container Connection

Anchor for shared typing; everything that crosses the wire uses these types.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Core types | c3-1 |
| OUT (provides) | Core types | c3-2 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-strong-typing | Home of the shared type surface |
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
