---
id: c3-215
title: diff-store
type: component
category: feature
parent: c3-2
goal: Maintain per-chat diff state for hydrated write_file/delete_file tool rendering and commit scaffolding.
uses:
    - ref-tool-hydration
c3-version: 4
---

# diff-store
## Goal

Maintain per-chat diff state for hydrated write_file/delete_file tool rendering and commit scaffolding.
## Container Connection

Lets the UI render full file diffs + commit flows without replaying tool events.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Paths | c3-204 |
| IN (uses) | Tool hydration | c3-303 |
| OUT (provides) | Diff snapshots | c3-207 |
| OUT (provides) | Diff snapshots | c3-210 |
| OUT (provides) | Diff snapshots | c3-213 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-tool-hydration | Diffs plug into the same tool entry pipeline |
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
