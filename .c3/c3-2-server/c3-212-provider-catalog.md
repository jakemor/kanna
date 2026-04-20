---
id: c3-212
title: provider-catalog
type: component
category: feature
parent: c3-2
goal: Normalize providers, models, reasoning effort levels, and Codex fast-mode flags into a single catalog.
uses:
    - ref-provider-adapter
c3-version: 4
---

# provider-catalog
## Goal

Normalize providers, models, reasoning effort levels, and Codex fast-mode flags into a single catalog.
## Container Connection

Lets the coordinator, UI, and quick-response all agree on what providers/models exist.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Catalog | c3-210 |
| OUT (provides) | Catalog | c3-213 |
| OUT (provides) | Catalog types (re-exported) | c3-301 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-provider-adapter | Catalog is the shared vocabulary of the adapter |
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
