---
id: c3-219
title: update-manager
type: component
category: feature
parent: c3-2
goal: Check npm for newer kanna-code versions and expose update state to the UI.
uses:
    - ref-cqrs-read-models
c3-version: 4
---

# update-manager
## Goal

Check npm for newer kanna-code versions and expose update state to the UI.
## Container Connection

Keeps users aware of new versions without an external updater.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Update status projection | c3-207 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-cqrs-read-models | Exposes update state as a projection |
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
