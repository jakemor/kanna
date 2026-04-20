---
id: c3-220
title: restart
type: component
category: feature
parent: c3-2
goal: Implement in-place server restart (self-relaunch) after version updates or CLI flag changes.
uses:
    - ref-ws-subscription
c3-version: 4
---

# restart
## Goal

Implement in-place server restart (self-relaunch) after version updates or CLI flag changes.
## Container Connection

Lets users upgrade without manually killing the process.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Process utils | c3-209 |
| OUT (provides) | Restart command | c3-208 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Clients observe restart state over WS |
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
