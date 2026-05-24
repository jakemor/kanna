---
id: c3-208
c3-version: 4
c3-seal: 84bb93824011b523ed71e02324eb0473fbc9c77f838625000cf793816cf866a9
title: ws-router
type: component
category: foundation
parent: c3-2
goal: 'Multiplex WS traffic: route subscribe/unsubscribe/command envelopes, push projections on every state change.'
uses:
    - c3-228
    - ref-colocated-bun-test
    - ref-cqrs-read-models
    - ref-ws-subscription
    - rule-colocated-bun-test
---

# ws-router

## Goal

Multiplex WS traffic: route subscribe/unsubscribe/command envelopes, push projections on every state change.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Multiplex WS subscriptions and commands across the single socket" |
| Category | foundation |
| Lifecycle | One router instance per server, one connection per client |
| Replaceability | Replaceable provided envelope contract preserved |

## Purpose

Accepts upgraded WS sockets, decodes typed `ClientEnvelope` payloads, dispatches subscribe/unsubscribe/command, forwards push payloads from read-models, and relays command results. Non-goals: HTTP routing, persistence, business decisions.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | HTTP server upgraded the socket and auth check passed | c3-202 |
| Input — read-models | Snapshots and push streams | c3-207 |
| Input — agent-coordinator | Command handlers for chat/turn ops | c3-210 |
| Input — protocol envelopes | Shared discriminated unions | c3-302 |
| Initialization | Bound by http-ws-server on upgrade | c3-202 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Every connected client mirrors the latest server state | c3-101 |
| Primary path | subscribe → snapshot push → diff stream | c3-207 |
| Alternate — command | command envelope → handler → commandResult push | c3-210 |
| Alternate — terminal | PTY bytes piped over the same socket | c3-216 |
| Failure — envelope decode | Reject with typed error envelope | c3-302 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-ws-subscription | ref | Single-WS, typed envelopes | must follow | No additional sockets |
| ref-cqrs-read-models | ref | Only projections cross the wire | must follow | Raw events stay server-side |
| ref-colocated-bun-test | ref | Tests next to router | must follow | ws-router.test.ts |
| rule-colocated-bun-test | rule | Compliance target added by c3x wire; refine what must be reviewed or complied with before handoff. | wired compliance target beats uncited local prose | Added by c3x wire for explicit compliance review. |
| c3-228 | ref | Session-share envelopes (share.mint, share.revoke, share.list) dispatched through ws-router | must follow | Wired for session-share coupling |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Envelope dispatch | IN | Decodes ClientEnvelope → handler | c3-101 | src/server/ws-router.ts |
| Snapshot push | OUT | Pushes typed ServerEnvelope to subscribers | c3-101 | src/server/ws-router.ts |
| Command result | OUT | Correlates result envelope to client command | c3-101 | src/server/ws-router.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Envelope drift | Protocol bump without router update | Decode errors at runtime | bun run test src/server/ws-router.test.ts |
| Subscription leak | Listener not pruned on disconnect | Memory growth across long sessions | Long-session smoke + listener count assertion in src/server/ws-router.test.ts |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/ws-router.ts | c3-208 Contract | Routing detail | src/server/ws-router.ts |
| src/server/ws-router.test.ts | c3-208 Contract | Test cases per surface | src/server/ws-router.test.ts |
