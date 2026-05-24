---
id: c3-306
c3-version: 4
c3-seal: 6746ce8a78464cb978f7abcf0bfbea4de7757412733f762adb7ba38d3871efb2
title: share-shared
type: component
category: foundation
parent: c3-3
goal: Expose share/tunnel types used on both client and server (QR payload, public URL shape).
uses:
    - ref-strong-typing
    - rule-strong-typing
---

# share-shared

## Goal

Expose share/tunnel types used on both client and server (QR payload, public URL shape).

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-3 (shared) |
| Parent Goal Slice | "Define share/tunnel DTOs shared between client and server" |
| Category | foundation |
| Lifecycle | Pure type module |
| Replaceability | Replaceable provided exported type shapes preserved |

## Purpose

Holds the typed DTOs for the `--share` feature: public URL payload, QR-code payload, tunnel state. Now also covers read-only session-share types under `src/shared/session-share/` (`ChatSnapshot`, `ShareError`, `ShareSummary`, etc.) imported by both client and server for the session-share feature (c3-228). Non-goals: tunnel runtime, classifier logic.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | TypeScript strict mode | c3-3 |
| Input — shared types | Reuses common URL primitives | c3-301 |
| Internal state | None | c3-306 |
| Initialization | Imported by server share + client banner | c3-218 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Share UI and server use one canonical DTO | c3-218 |
| Primary path | Server emits DTO → client renders banner/QR | c3-110 |
| Alternate — settings | Settings page reads tunnel mode DTO | c3-116 |
| Alternate — none | No alternate transports — single shape across consumers | c3-306 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-strong-typing | ref | Typed share DTOs | must follow | No any in payloads |
| rule-strong-typing | rule | Compliance target added by c3x wire; refine what must be reviewed or complied with before handoff. | wired compliance target beats uncited local prose | Added by c3x wire for explicit compliance review. |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Share DTO exports | OUT | Public URL + QR payload types | c3-218 | src/shared/share.ts |
| Tunnel DTO exports | OUT | Tunnel state shape used in projection | c3-110 | src/shared/share.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Cross-wire drift | Type renamed only on one side | tsc fails on consumer | bun run check against src/shared/share.ts |
| Field marked required without migration | DTO required-flag flipped | Old client breaks at runtime | Manual mixed-version smoke pairing src/server/share.ts and src/client/app/socket.ts |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/shared/share.ts | c3-306 Contract | DTO detail | src/shared/share.ts |
