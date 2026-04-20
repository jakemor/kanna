---
id: c3-103
title: ui-primitives
type: component
category: foundation
parent: c3-1
goal: 'Ship the low-level, brand-aligned UI primitives (Radix + shadcn derivatives: button, dialog, popover, scroll-area, tooltip, select, kbd, ...).'
uses:
    - ref-strong-typing
c3-version: 4
---

# ui-primitives
## Goal

Ship the low-level, brand-aligned UI primitives (Radix + shadcn derivatives: button, dialog, popover, scroll-area, tooltip, select, kbd, ...).
## Container Connection

Feature components compose these primitives to keep interaction quality consistent across chat, sidebar, settings, and terminal.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Primitives | c3-111 |
| OUT (provides) | Primitives | c3-112 |
| OUT (provides) | Primitives | c3-115 |
| OUT (provides) | Primitives | c3-116 |
| OUT (provides) | Primitives | c3-117 |
| OUT (provides) | Primitives | c3-118 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-strong-typing | Primitives forward typed props to Radix without loosening types |
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
