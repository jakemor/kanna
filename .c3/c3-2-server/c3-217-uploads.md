---
id: c3-217
title: uploads
type: component
category: feature
parent: c3-2
goal: Accept file uploads (drag-drop attachments), store under data dir, emit events referencing the stored assets.
uses:
    - ref-local-first-data
c3-version: 4
---

# uploads
## Goal

Accept file uploads (drag-drop attachments), store under data dir, emit events referencing the stored assets.
## Container Connection

Enables attachment-aware chats without leaving the local disk.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Paths | c3-204 |
| IN (uses) | Event store | c3-206 |
| OUT (provides) | Upload endpoint | c3-202 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-local-first-data | Uploads land under ~/.kanna/data |
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
