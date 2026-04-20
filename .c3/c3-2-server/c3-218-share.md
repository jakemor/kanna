---
id: c3-218
title: share
type: component
category: feature
parent: c3-2
goal: Create public trycloudflare URLs or named Cloudflare tunnels + terminal QR output.
uses:
    - ref-local-first-data
c3-version: 4
---

# share
## Goal

Create public trycloudflare URLs or named Cloudflare tunnels + terminal QR output.
## Container Connection

Makes remote-sharing possible without inventing networking infra.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Process utils | c3-209 |
| IN (uses) | Shared share types | c3-306 |
| OUT (provides) | Tunnel URLs + QR | c3-201 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Only runs when the user opts in with --share |
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
