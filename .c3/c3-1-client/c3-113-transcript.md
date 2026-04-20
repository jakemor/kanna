---
id: c3-113
title: transcript
type: component
category: feature
parent: c3-1
goal: Render a hydrated list of transcript entries (text, tool calls, plan dialogs, diffs) with virtualized scrolling and sticky focus.
uses:
    - ref-tool-hydration
    - ref-provider-adapter
c3-version: 4
---

# transcript
## Goal

Render a hydrated list of transcript entries (text, tool calls, plan dialogs, diffs) with virtualized scrolling and sticky focus.
## Container Connection

Visual heart of the chat experience — transforms server-pushed transcript entries into readable, interactive UI.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Message renderers | c3-114 |
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Shared tool normalization | c3-303 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-tool-hydration | Dispatches renderers via hydrated tool kinds |
| ref-provider-adapter | Same render path for Claude + Codex entries |
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
