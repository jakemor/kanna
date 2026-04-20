---
id: c3-222
title: keybindings
type: component
category: feature
parent: c3-2
goal: Persist per-user keybindings to ~/.kanna/data and sync them with the client.
uses:
    - ref-local-first-data
c3-version: 4
---

# keybindings
## Goal

Persist per-user keybindings to ~/.kanna/data and sync them with the client.
## Container Connection

Makes shortcut preferences survive restarts and multiple tabs.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Paths | c3-204 |
| OUT (provides) | Keybinding projection | c3-207 |
| OUT (provides) | Keybinding projection | c3-116 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Persisted under ~/.kanna/data |
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
