---
id: c3-117
title: local-projects-page
type: component
category: feature
parent: c3-1
goal: List projects auto-discovered from local Claude and Codex history so users can open them into Kanna.
uses:
    - ref-ws-subscription
    - ref-local-first-data
c3-version: 4
---

# local-projects-page
## Goal

List projects auto-discovered from local Claude and Codex history so users can open them into Kanna.
## Container Connection

Onboarding on-ramp: makes the app immediately useful by surfacing existing work without manual configuration.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Server discovery feed | c3-214 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Subscribes to discovery projection |
| ref-local-first-data | Only local history is read; no cloud lookup |
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
