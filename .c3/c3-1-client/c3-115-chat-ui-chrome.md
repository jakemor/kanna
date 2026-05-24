---
id: c3-115
c3-version: 4
c3-seal: d7e82da963e2a764aebfb3ff17eb76c2110cc197b1a5b8eb628c1e6c01de8291
title: chat-ui-chrome
type: component
category: feature
parent: c3-1
goal: 'Provide the composer and chat chrome: input dock, provider/model/effort pickers, attachment controls, queued message alignment.'
uses:
    - ref-provider-adapter
    - ref-zustand-store
    - rule-zustand-store
---

# chat-ui-chrome

## Goal

Provide the composer and chat chrome: input dock, provider/model/effort pickers, attachment controls, queued message alignment.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-1 (client) |
| Parent Goal Slice | "Accept user input: chat composer, provider/model switches" |
| Category | feature |
| Lifecycle | Mounts inside chat-page for active session |
| Replaceability | Replaceable provided composer command contract preserved |

## Purpose

Owns the composer and surrounding chrome: textarea input, provider/model/effort pickers, attachment controls, queued message indicator, send action. Non-goals: transcript rendering, server command execution, chat history.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | Chat-page provides session context | c3-112 |
| Input — chat input store | Pending text, attachments | c3-102 |
| Input — preferences | Theme, provider/model defaults | c3-102 |
| Input — primitives | Textarea, popover, select, tooltip | c3-103 |
| Input — provider catalog types | Provider/model/effort options | c3-301 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | User sends a message to the agent with chosen provider/model | c3-1 |
| Primary path | Type → choose model → click Send → emit chat.send command | c3-208 |
| Alternate — drag-attach | Drop file → upload → reference inserted in payload | c3-217 |
| Alternate — provider switch | Picker writes to preferences store; persists across sessions | ref-zustand-store |
| Failure — send rejected | Show inline banner; retain text in store | c3-115 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-provider-adapter | ref | Use normalized catalog, not per-provider forms | must follow | One UI for all providers |
| ref-zustand-store | ref | Persist pending input + preferences | must follow | Survives reload |
| rule-zustand-store | rule | Compliance target added by c3x wire; refine what must be reviewed or complied with before handoff. | wired compliance target beats uncited local prose | Added by c3x wire for explicit compliance review. |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Composer component | OUT | Renders input + pickers; emits send | c3-112 | src/client/components/chat-ui |
| Send callback | OUT | Calls socket command chat.send with provider/model | c3-101 | src/client/components/chat-ui |
| Attachment controls | OUT | Opens file picker; pushes to upload pipeline | c3-217 | src/client/components/chat-ui |
| Public link button | OUT | Renders "Public link" button in chat header toolbar, next to existing Share button; triggers share.mint command | c3-228 | src/client/components/chat-ui |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Provider/model mismatch | Catalog type change | Picker shows wrong options | bun run check against src/client/components/chat-ui |
| Lost draft on reload | Persistence regression | Pending text disappears | bun run check + manual reload smoke against src/client/stores/ |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/client/components/chat-ui/**/*.tsx | c3-115 Contract | Layout/skin detail | src/client/components/chat-ui |
