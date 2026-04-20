---
id: c3-201
title: cli-entry
type: component
category: foundation
parent: c3-2
goal: Parse CLI flags, supervise the Bun server process, pick dev/prod runtime mode, and open the browser.
uses:
    - ref-local-first-data
c3-version: 4
---

# cli-entry
## Goal

Parse CLI flags, supervise the Bun server process, pick dev/prod runtime mode, and open the browser.
## Container Connection

Boot path for the entire server. Without it the rest of c3-2 never runs.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Paths | c3-204 |
| IN (uses) | Ports | c3-304 |
| IN (uses) | Process utilities | c3-209 |
| OUT (provides) | Runtime entry | c3-202 |
| OUT (provides) | Share tunnel hookup | c3-218 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Defaults to localhost; --remote/--host/--share are explicit opt-ins |
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
