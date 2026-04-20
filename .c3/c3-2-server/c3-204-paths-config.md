---
id: c3-204
title: paths-config
type: component
category: foundation
parent: c3-2
goal: Resolve all filesystem paths (data dir, JSONL logs, snapshots) and machine identity helpers.
uses:
    - ref-local-first-data
c3-version: 4
---

# paths-config
## Goal

Resolve all filesystem paths (data dir, JSONL logs, snapshots) and machine identity helpers.
## Container Connection

Single source of truth for where the server writes — prevents scattered path literals.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Path helpers | c3-206 |
| OUT (provides) | Path helpers | c3-215 |
| OUT (provides) | Path helpers | c3-217 |
| OUT (provides) | Path helpers | c3-222 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Centralizes the ~/.kanna/data layout |
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
