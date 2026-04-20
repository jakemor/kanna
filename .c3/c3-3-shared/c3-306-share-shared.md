---
id: c3-306
title: share-shared
type: component
category: foundation
parent: c3-3
goal: Expose share/tunnel types used on both client and server (QR payload, public URL shape).
uses:
    - ref-strong-typing
c3-version: 4
---

# share-shared
## Goal

Expose share/tunnel types used on both client and server (QR payload, public URL shape).
## Container Connection

Unifies the share feature across client + server without duplicating shapes.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| OUT (provides) | Share DTOs | c3-218 |
| OUT (provides) | Share DTOs | c3-110 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-strong-typing | Shared DTOs |
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
