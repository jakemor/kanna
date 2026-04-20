---
id: c3-213
title: quick-response
type: component
category: feature
parent: c3-2
goal: Execute lightweight structured queries (titles, commit messages) via Claude Haiku with Codex fallback.
uses:
    - ref-provider-adapter
c3-version: 4
---

# quick-response
## Goal

Execute lightweight structured queries (titles, commit messages) via Claude Haiku with Codex fallback.
## Container Connection

Small background jobs that must stay fast and cheap; keeps the main coordinator focused on interactive turns.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Codex fallback | c3-211 |
| IN (uses) | Provider catalog | c3-212 |
| OUT (provides) | Title + commit generators | c3-208 |
| OUT (provides) | Title + commit generators | c3-210 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-provider-adapter | Fallback path still honors catalog contracts |
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
