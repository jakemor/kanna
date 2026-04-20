---
id: c3-111
title: sidebar
type: component
category: feature
parent: c3-1
goal: 'Render the project-first sidebar: grouped chats, live status dots, drag-to-reorder project groups, number-key jumps.'
uses:
    - ref-cqrs-read-models
    - ref-zustand-store
c3-version: 4
---

# sidebar
## Goal

Render the project-first sidebar: grouped chats, live status dots, drag-to-reorder project groups, number-key jumps.
## Container Connection

Main navigation surface; the user never leaves this panel. Without it, there is no way to open chats or reorder projects.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Sidebar state store | c3-102 |
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Sidebar view snapshots | c3-207 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-cqrs-read-models | Sidebar consumes the sidebarView projection, not raw events |
| ref-zustand-store | Drag ordering persisted via zustand persist middleware |
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
