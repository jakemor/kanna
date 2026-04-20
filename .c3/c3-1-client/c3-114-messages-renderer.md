---
id: c3-114
title: messages-renderer
type: component
category: feature
parent: c3-1
goal: Render each transcript entry kind (text, tool call, write_file, delete_file, plan, diff, ...) consistently, with collapse/expand and status.
uses:
    - ref-tool-hydration
    - ref-strong-typing
c3-version: 4
---

# messages-renderer
## Goal

Render each transcript entry kind (text, tool call, write_file, delete_file, plan, diff, ...) consistently, with collapse/expand and status.
## Container Connection

Encapsulates per-kind UI so transcript stays dumb; adding a new tool only touches this component plus shared hydration.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Shared tools | c3-303 |
| OUT (provides) | Renderer map | c3-113 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-tool-hydration | Dispatches by kind only; never branches on provider |
| ref-strong-typing | Exhaustive switch on transcript entry union |
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
