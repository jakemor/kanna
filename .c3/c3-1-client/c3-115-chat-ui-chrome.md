---
id: c3-115
title: chat-ui-chrome
type: component
category: feature
parent: c3-1
goal: 'Provide the composer and chat chrome: input dock, provider/model/effort pickers, attachment controls, queued message alignment.'
uses:
    - ref-provider-adapter
    - ref-zustand-store
c3-version: 4
---

# chat-ui-chrome
## Goal

Provide the composer and chat chrome: input dock, provider/model/effort pickers, attachment controls, queued message alignment.
## Container Connection

The user's input surface — without it there is nothing to send to the agent.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Chat input store + preferences | c3-102 |
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Provider catalog types | c3-301 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-provider-adapter | Pickers use the normalized catalog instead of per-provider forms |
| ref-zustand-store | Pending input persisted between route changes |
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
