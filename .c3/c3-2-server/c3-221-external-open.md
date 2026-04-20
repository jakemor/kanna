---
id: c3-221
title: external-open
type: component
category: feature
parent: c3-2
goal: Open URLs, files, and VS Code / editor links in the user's external apps.
uses:
    - ref-local-first-data
c3-version: 4
---

# external-open
## Goal

Open URLs, files, and VS Code / editor links in the user's external apps.
## Container Connection

Small quality-of-life bridge between the UI and the host OS.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Open command | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Dispatches to local host only, never remote |
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
