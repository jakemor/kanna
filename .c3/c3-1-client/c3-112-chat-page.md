---
id: c3-112
title: chat-page
type: component
category: feature
parent: c3-1
goal: 'Compose the chat route: transcript viewport, input dock, terminal workspace, focus policy, and sidebar actions.'
uses:
    - ref-ws-subscription
    - ref-cqrs-read-models
c3-version: 4
---

# chat-page
## Goal

Compose the chat route: transcript viewport, input dock, terminal workspace, focus policy, and sidebar actions.
## Container Connection

The primary workspace of the app. Without it the user has nowhere to read or write agent turns.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Transcript renderer | c3-113 |
| IN (uses) | Chat UI chrome (input) | c3-115 |
| IN (uses) | Terminal workspace | c3-118 |
| IN (uses) | Stores | c3-102 |
| IN (uses) | Primitives | c3-103 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-ws-subscription | Subscribes to chat view for its sessionId |
| ref-cqrs-read-models | Renders the chatView projection |
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
