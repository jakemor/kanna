---
id: c3-116
title: settings-page
type: component
category: feature
parent: c3-1
goal: 'Expose user settings: provider keys, theme, keybindings, chat preferences, notifications, data location.'
uses:
    - ref-zustand-store
    - ref-local-first-data
c3-version: 4
---

# settings-page
## Goal

Expose user settings: provider keys, theme, keybindings, chat preferences, notifications, data location.
## Container Connection

One place to configure how the client and the local server behave; without it users cannot customize the tool.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | Preference stores | c3-102 |
| IN (uses) | Primitives | c3-103 |
| IN (uses) | Server keybinding projection | c3-222 |
| IN (uses) | Cloudflare tunnel settings + setter | c3-223 |
## Code References

<!-- List concrete code files that implement this component -->
| File | Purpose |
|------|---------|
## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-zustand-store | Preferences live in stores with persistence |
| ref-local-first-data | Settings surface the paths.ts data dir |
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
