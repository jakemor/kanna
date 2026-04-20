---
id: c3-205
title: events-schema
type: component
category: foundation
parent: c3-2
goal: Define the event type definitions (project/chat/message/turn) appended to JSONL logs.
uses:
    - ref-event-sourcing
    - ref-strong-typing
c3-version: 4
---

# events-schema
## Goal

Define the event type definitions (project/chat/message/turn) appended to JSONL logs.
## Container Connection

The contract between writers (agent-coordinator, uploads, diff-store, etc.) and read-models. Without it events drift.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Typed event unions | c3-206 |
| OUT (provides) | Typed event unions | c3-207 |
| OUT (provides) | Typed event unions | c3-210 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-event-sourcing | Defines the event vocabulary appended to the log |
| ref-strong-typing | Discriminated unions per event kind |
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
