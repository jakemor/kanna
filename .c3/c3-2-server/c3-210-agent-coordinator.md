---
id: c3-210
title: agent-coordinator
type: component
category: feature
parent: c3-2
goal: 'Drive turn lifecycle across providers: start/cancel/resume Claude + Codex sessions, emit normalized transcript events.'
uses:
    - ref-provider-adapter
    - ref-event-sourcing
    - ref-tool-hydration
    - ref-colocated-bun-test
c3-version: 4
---

# agent-coordinator
## Goal

Drive turn lifecycle across providers: start/cancel/resume Claude + Codex sessions, emit normalized transcript events.
## Container Connection

The brain of the server — without it no agent turn executes.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Codex adapter | c3-211 |
| IN (uses) | Provider catalog | c3-212 |
| IN (uses) | Event store | c3-206 |
| IN (uses) | Tool hydration | c3-303 |
| IN (uses) | Process utils | c3-209 |
| OUT (provides) | Turn commands | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|------|------|
| ref-provider-adapter | Owns the provider-agnostic turn orchestration |
| ref-event-sourcing | Writes turn events to the log first |
| ref-tool-hydration | Normalizes tool calls before persistence |
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
