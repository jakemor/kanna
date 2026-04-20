---
id: c3-207
title: read-models
type: component
category: foundation
parent: c3-2
goal: Project events into derived views (sidebar, chat, projects, discovery) that ws-router broadcasts.
uses:
    - ref-cqrs-read-models
    - ref-strong-typing
c3-version: 4
---

# read-models
## Goal

Project events into derived views (sidebar, chat, projects, discovery) that ws-router broadcasts.
## Container Connection

Turns raw events into UI-shaped snapshots so clients never replay the log.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Event stream | c3-206 |
| IN (uses) | Events schema | c3-205 |
| OUT (provides) | Projections | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-cqrs-read-models | Canonical implementation |
| ref-strong-typing | Typed view models per UI surface |
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
