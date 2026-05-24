---
id: c3-205
c3-version: 4
c3-seal: db3dfa4b3eb72c604aa38aa59400c31112150e89eb4d57d63669097cfb003e38
title: events-schema
type: component
category: foundation
parent: c3-2
goal: Define the typed event union (project/chat/message/turn) appended to JSONL logs.
uses:
    - ref-event-sourcing
    - ref-strong-typing
    - rule-strong-typing
---

# events-schema

## Goal

Define the typed event union (project/chat/message/turn) appended to JSONL logs.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Define the canonical event vocabulary for the event log" |
| Category | foundation |
| Lifecycle | Type module, no runtime instances |
| Replaceability | Replaceable provided discriminated union shape preserved |

## Purpose

Owns the discriminated union of every event written to the JSONL log: project events, chat events, message events, turn events, tunnel events. Non-goals: I/O, replay, persistence — those live in c3-206.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | Bun + TypeScript strict mode | c3-2 |
| Input — shared types | Domain types reused for payloads | c3-301 |
| Internal state | Pure type module | c3-205 |
| Initialization | Imported by writers and read-models | c3-206 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Writers and read-models share one source of truth | c3-2 |
| Primary path | Writer constructs typed event → store appends | c3-206 |
| Alternate — projection | Read-models switch on event kind | c3-207 |
| Alternate — coordinator | Coordinator emits turn events | c3-210 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-event-sourcing | ref | Defines event vocabulary | must follow | One union per log line |
| ref-strong-typing | ref | Discriminated unions per kind | must follow | No any in event payloads |
| rule-strong-typing | rule | Compliance target added by c3x wire; refine what must be reviewed or complied with before handoff. | wired compliance target beats uncited local prose | Added by c3x wire for explicit compliance review. |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Event union | OUT | Discriminated union of every persisted kind | c3-206 | src/server/events.ts |
| Event constructors | OUT | Helpers returning typed events with timestamps | c3-210 | src/server/events.ts |
| share.token_minted event | OUT | { tokenId, chatId, expiresAt, createdAt, createdBy } — appended to shares.jsonl (owned by c3-206) when a share link is created | c3-228 | src/server/events.ts |
| share.token_revoked event | OUT | { tokenId, revokedAt } — appended to shares.jsonl when a link is revoked or expires | c3-228 | src/server/events.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Schema drift | New kind added without read-model handler | Replay errors or missing data on UI | bun run check against src/server/events.ts |
| Untyped payload | Writer escapes to any | tsc fails or runtime decode error | bun run check plus grep src/server/ for as any regressions |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/events.ts | c3-205 Contract | Type detail | src/server/events.ts |
