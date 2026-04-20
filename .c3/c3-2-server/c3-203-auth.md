---
id: c3-203
title: auth
type: component
category: foundation
parent: c3-2
goal: Gate HTTP + WS + API routes behind a launch-password session cookie when --password is set.
uses:
    - ref-local-first-data
c3-version: 4
---

# auth
## Goal

Gate HTTP + WS + API routes behind a launch-password session cookie when --password is set.
## Container Connection

Keeps shared/tunnelled servers safe. Without it, --share would expose data without protection.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Middleware + session cookie | c3-202 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | When opting into wider surfaces, password becomes mandatory |
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
