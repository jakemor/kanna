---
id: c3-211
title: codex-app-server
type: component
category: feature
parent: c3-2
goal: 'Drive the Codex App Server over JSON-RPC: boot, run turns, translate Codex events into coordinator-friendly shapes.'
uses:
    - ref-provider-adapter
    - ref-strong-typing
c3-version: 4
---

# codex-app-server
## Goal

Drive the Codex App Server over JSON-RPC: boot, run turns, translate Codex events into coordinator-friendly shapes.
## Container Connection

Provides the Codex half of multi-provider support; without it users only have Claude.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Process utils | c3-209 |
| OUT (provides) | Codex turn API | c3-210 |
| OUT (provides) | Codex turn API | c3-213 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-provider-adapter | Adapter that stays behind the coordinator |
| ref-strong-typing | Typed JSON-RPC protocol module |
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
