---
id: c3-206
title: event-store
type: component
category: foundation
parent: c3-2
goal: Append events to JSONL, replay on boot, compact to snapshot.json when the log exceeds 2 MB.
uses:
    - ref-event-sourcing
    - ref-local-first-data
    - ref-colocated-bun-test
c3-version: 4
---

# event-store
## Goal

Append events to JSONL, replay on boot, compact to snapshot.json when the log exceeds 2 MB.
## Container Connection

Authoritative state of the system. Without it, read-models and subscribers have no source of truth.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Events schema | c3-205 |
| IN (uses) | Paths | c3-204 |
| OUT (provides) | Append + replay API | c3-207 |
| OUT (provides) | Append + replay API | c3-210 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|------|------|
| ref-event-sourcing | Canonical implementation |
| ref-local-first-data | All files under ~/.kanna/data |
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
