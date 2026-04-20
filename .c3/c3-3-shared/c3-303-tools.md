---
id: c3-303
title: tools
type: component
category: foundation
parent: c3-3
goal: Normalize tool-call inputs from Claude + Codex into unified transcript tool entries (read, edit, write_file, delete_file, bash, plan, diff...).
uses:
    - ref-tool-hydration
    - ref-strong-typing
    - ref-colocated-bun-test
c3-version: 4
---

# tools
## Goal

Normalize tool-call inputs from Claude + Codex into unified transcript tool entries (read, edit, write_file, delete_file, bash, plan, diff...).
## Container Connection

Lets both renderer and coordinator share a single hydration path.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Hydration functions | c3-113 |
| OUT (provides) | Hydration functions | c3-114 |
| OUT (provides) | Hydration functions | c3-210 |
| OUT (provides) | Hydration functions | c3-215 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|------|------|
| ref-tool-hydration | This module IS the hydration pipeline |
| ref-strong-typing | Output is a discriminated tool-entry union |
| ref-colocated-bun-test |  |
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
