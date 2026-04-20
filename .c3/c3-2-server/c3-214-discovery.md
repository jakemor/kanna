---
id: c3-214
title: discovery
type: component
category: feature
parent: c3-2
goal: Scan Claude Code and Codex local history directories to surface candidate projects for the local-projects page.
uses:
    - ref-local-first-data
c3-version: 4
---

# discovery
## Goal

Scan Claude Code and Codex local history directories to surface candidate projects for the local-projects page.
## Container Connection

Zero-config on-ramp; without it users would start empty.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Paths | c3-204 |
| OUT (provides) | Discovered projects | c3-207 |
| OUT (provides) | Discovered projects | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Only reads user-local files, never hits network |
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
