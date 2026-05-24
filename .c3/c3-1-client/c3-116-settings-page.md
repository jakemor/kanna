---
id: c3-116
c3-version: 4
c3-seal: 72ccfdb8495323653e32e38da789836066c397a86c1bf67cfe22bae1a790b6a7
title: settings-page
type: component
category: feature
parent: c3-1
goal: 'Expose user settings: provider keys, theme, keybindings, chat preferences, notifications, data location.'
uses:
    - ref-local-first-data
    - ref-zustand-store
    - rule-zustand-store
---

# settings-page

## Goal

Expose user settings: provider keys, theme, keybindings, chat preferences, notifications, data location.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-1 (client) |
| Parent Goal Slice | "Accept user input: … settings" |
| Category | feature |
| Lifecycle | Mounts on /settings route |
| Replaceability | Section composition replaceable; settings keys remain stable |

## Purpose

Surfaces user-facing configuration: provider API keys, theme, custom keybindings, chat preferences, notification toggles, data directory, cloudflare tunnel toggles. Non-goals: server-side preference enforcement, secret storage policy, multi-user identity.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | App-shell mounted; preferences hydrated | c3-110 |
| Input — preferences store | Theme, notifications, model defaults | c3-102 |
| Input — primitives | Switches, dialogs, sliders | c3-103 |
| Input — server keybinding projection | Persisted bindings from server | c3-222 |
| Input — cloudflare tunnel settings | Toggles + setter | c3-223 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | User configures Kanna without leaving the app | c3-1 |
| Primary path | Edit field → store/setter → optimistic update + server command | c3-208 |
| Alternate — provider keys | Saved to local config (via server) only | ref-local-first-data |
| Alternate — keybinding edit | Capture new chord → emit keybindings.set | c3-222 |
| Failure — save reject | Revert optimistic change; show banner | c3-116 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-zustand-store | ref | Store-backed preferences with persist | must follow | One preferences store |
| ref-local-first-data | ref | Local-only paths and keys | must follow | No cloud sync |
| rule-zustand-store | rule | Compliance target added by c3x wire; refine what must be reviewed or complied with before handoff. | wired compliance target beats uncited local prose | Added by c3x wire for explicit compliance review. |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| <SettingsPage> route | OUT | Mounts at /settings; sections per concern | c3-110 | src/client/app/SettingsPage.tsx |
| Setting setters | OUT | Emit typed commands (keybindings.set, tunnel.set, ...) | c3-208 | src/client/app/SettingsPage.tsx |
| Provider key form | IN/OUT | Reads/writes provider config via server | c3-203 | src/client/app/SettingsPage.tsx |
| Share expiry row | IN/OUT | "Default share link expiry (hours)" input wired through settings.writeAppSettingsPatch | c3-228 | src/client/app/SettingsPage.tsx |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Lost preferences on schema bump | Persist field rename | Settings reset after upgrade | Add migrate in src/client/stores/ + bun run check |
| Secret leakage | Provider key shown in DOM | Manual inspect of input element | bun run check + grep src/client/app/SettingsPage.tsx for plain logs |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/client/app/SettingsPage.tsx | c3-116 Contract | Section ordering | src/client/app/SettingsPage.tsx |
