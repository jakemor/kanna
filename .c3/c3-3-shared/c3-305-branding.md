---
id: c3-305
title: branding
type: component
category: foundation
parent: c3-3
goal: Publish the product name + data dir constants ("kanna", ~/.kanna/data/...).
uses:
    - ref-local-first-data
c3-version: 4
---

# branding
## Goal

Publish the product name + data dir constants (kanna, ~/.kanna/data/...).
## Container Connection

Keeps strings like app name + data dir in exactly one place.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Branding constants | c3-204 |
| OUT (provides) | Branding constants | c3-110 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Anchors the data path layout |
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
