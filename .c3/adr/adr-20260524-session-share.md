---
id: adr-20260524-session-share
c3-seal: aaee8ed4065044c56de52cb47dc9e221c981423e85d8bf785c8d46be8b20b9de
title: session-share
type: adr
goal: Introduce a read-only session-share capability (c3-228) that lets owners mint a time-limited token URL for a finished Kanna chat, enabling teammates to view the full transcript without a Kanna login or write access.
status: implemented
date: "2026-05-24"
---

## Goal

Introduce a read-only session-share capability (c3-228) that lets owners mint a time-limited token URL for a finished Kanna chat, enabling teammates to view the full transcript without a Kanna login or write access.

## Context

Owners need to show finished Kanna chat sessions to teammates without giving them write access or a Kanna login. Today the only sharing mechanism is the whole-Kanna Cloudflare tunnel (c3-218), which requires recipients to authenticate against the host's password.

## Decision

Introduce c3-228 session-share. Owner clicks Share in the chat header; server builds a frozen JSON snapshot from the event log via existing read-models, persists it under ~/.kanna/shares/<token>.json (mode 0600), appends a share.token_minted event to a new shares event log, and returns <tunnel-base>/share/<token>. The path is exempt from auth (c3-203 path-prefix bypass); the 256-bit token is the credential. Snapshot only — no live updates. TTL default lives in settings (shareDefaultTtlHours).

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-2 | container | Gains a new public route prefix /share/:token served without auth | ref-local-first-data, ref-side-effect-adapter |
| c3-203 | component | Gains a path-prefix exemption rule for /share/:token | ref-local-first-data |
| c3-205 | component | Gains two new event-kind union definitions: share.token_minted and share.token_revoked added to the events-schema discriminated union | ref-event-sourcing, ref-strong-typing |
| c3-206 | component | Gains the new on-disk shares JSONL log file (shares.jsonl) and the appendShareEvent / getShareEvents methods that append to and read from it | ref-event-sourcing, ref-local-first-data |
| c3-207 | component | Gains a new read-model projection for the shares log (share projection) | ref-cqrs-read-models |
| c3-115 | component | Gains a ShareButton + SharePopover in the chat header (chat-ui-chrome); emits share.mint via WebSocket | ref-ws-subscription |
| c3-204 | component | Shares directory ~/.kanna/shares resolves through c3-204; no new symbol added — c3-228 consumes the existing kannaDir accessor. | ref-local-first-data |
| c3-306 | component | Gains ShareSnapshot, ShareToken shared types | ref-strong-typing |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-local-first-data | Snapshot files must live under ~/.kanna/shares/ (mode 0600); no remote upload | comply |
| ref-event-sourcing | share.token_minted and share.token_expired must be appended to a JSONL shares log before any mutation | comply |
| ref-cqrs-read-models | Share list / lookup must read from the shares projection, not directly from disk | comply |
| ref-side-effect-adapter | All fs operations for snapshot persistence must live in a *.adapter.ts file | comply |
| ref-strong-typing | ShareSnapshot, ShareToken, and all event payloads must use concrete TypeScript types — no any | comply |
| ref-colocated-bun-test | Integration test for share-route.ts must sit next to the route file per project test convention | comply |
| ref-ws-subscription | The share.mint request and share.minted response flow through the single typed WebSocket handled by c3-208; c3-115 client emits via that socket | comply |
| ref-zustand-store | Session-share does not add or modify Zustand stores in c3-115 (chat-ui-chrome); the ShareButton is a new UI surface but does not own persistent store state | N.A - no zustand store changes in c3-115 |
| ref-provider-adapter | Session-share does not touch provider normalization or agent driver paths; affected components (c3-210, c3-211, c3-212, c3-213, c3-225) are cited only because they use the ref generally, not because this ADR changes them | N.A - no provider adapter code touched |
| ref-tool-hydration | Session-share does not involve tool-call hydration; snapshot is built from event-store read-models only; affected components (c3-210, c3-215, c3-226) are cited generally, not changed by this ADR | N.A - no tool hydration code touched |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-strong-typing | Share event payloads and snapshot shape must be fully typed at every boundary | comply |
| rule-colocated-bun-test | HTTP route integration test must sit next to the route file | comply |
| rule-zustand-store | Session-share does not add or modify any Zustand store in c3-115; the ShareButton is a pure UI component that calls a WebSocket command, no store ownership | N.A - no zustand store changes |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| c3-228 component scaffold | Add c3-228 session-share to c3-2 via c3x; wire 5 refs | .c3/ commit |
| ADR | Add adr-20260524-session-share; set status accepted | .c3/ commit |
| Shared types | Add ShareSnapshot, ShareToken, ShareEventKind to src/shared/types/share.ts | c3-228 Contract |
| Protocol | Add share.mint WsEnvelope and share.minted response to src/shared/protocol.ts | c3-302 |
| Token generator | Implement 256-bit random token in src/server/session-share/token.ts | c3-228 |
| Snapshot-store adapter | Implement fs read/write in src/server/session-share/snapshot-store.adapter.ts | ref-side-effect-adapter |
| Snapshot builder | Assemble frozen JSON from event-store read-models in src/server/session-share/snapshot-builder.ts | c3-207 |
| Share projection | Project share events into in-memory map in src/server/session-share/share-projection.ts | ref-cqrs-read-models |
| SessionShareService | Orchestrate mint, persist, sweep in src/server/session-share/session-share-service.ts | c3-228 |
| HTTP route | Add GET /share/:token route; exempt from auth in src/server/session-share/share-route.ts | c3-203 |
| Snapshot sweep | TTL cron in src/server/session-share/snapshot-sweep.ts appending share.token_expired | c3-228 |
| Settings TTL row | Add shareDefaultTtlHours to app-settings.ts and settings UI | c3-116 |
| ws-router envelopes | Handle share.mint in ws-router.ts and emit share.minted | c3-208 |
| Client share-store | Zustand store for share state in src/client/stores/share-store.ts | c3-102 |
| ShareButton + SharePopover | UI components in src/client/components/ShareButton.tsx | c3-112 |
| ShareViewPage | Read-only transcript page at /share/:token in src/client/pages/ShareViewPage.tsx | c3-1 |
| Integration test | HTTP test for /share/:token route in src/server/session-share/share-route.test.ts | rule-colocated-bun-test |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| c3-228 component | New component added via c3x add component session-share --container c3-2 | c3x check reports clean |
| adr-20260524-session-share | New ADR added via c3x add adr session-share; set status accepted | c3x check --include-adr reports clean |
| Refs wired | 5 refs wired to c3-228: ref-local-first-data, ref-event-sourcing, ref-cqrs-read-models, ref-side-effect-adapter, ref-strong-typing | c3x check reports clean |
| N.A - schema/validator | No c3x schema or validator changes required by this ADR | N.A - no underlay schema modified |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| bun run lint | ESLint side-effect adapter seal catches any direct fs calls outside *.adapter.ts in server production code | CLAUDE.md side-effect-lint section |
| bun test src/server/session-share/share-route.test.ts | Integration test verifies /share/:token returns 200 with snapshot, unknown tokens return 404, expired tokens return 410 | Task 17 |
| c3x check | Validates c3-228 sections and wired refs remain consistent | c3x check output |
| TypeScript strict mode | tsc catches any untyped shapes in share event payloads and snapshot boundary | bun run build |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Live ws subscription with viewer scope | Heavier auth surface across the entire event-store path; does not meet the "no login required" requirement |
| Static HTML export hosted externally | Loses the chat-page look/feel and conflicts with the "full chat page read-only" requirement |
| Hosted snapshot upload service | Out of scope; no Kanna backend service and violates local-first-data ref |
| Whole-Kanna tunnel with password | Recipients must create a Kanna login; does not provide per-session granularity |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Token guessing attack | 256-bit random token; ~3.4×10^77 space makes brute-force infeasible | Token length check in token.ts unit test |
| Snapshot disk exhaustion | TTL default + sweep cron append share.token_expired and delete file | Sweep integration test asserts file deleted after TTL |
| Auth bypass regression | /share/:token path-prefix exemption must be narrow; any other prefix remains gated | bun test share-route.test.ts asserts non-share paths still return 401 |
| Stale snapshot served post-TTL | Sweep checks expiry on startup replay; expired tokens return 410 | Integration test with expired snapshot fixture |
| NO_TUNNEL mint refused | Mint endpoint checks tunnel active before minting; returns NO_TUNNEL error if none | Integration test with no tunnel fixture |

## Verification

| Check | Result |
| --- | --- |
| c3x check --include-adr | Clean — no errors |
| bun run lint | Zero warnings/errors on all new files |
| bun test src/server/session-share/share-route.test.ts | All assertions pass |
| GET /share/<valid-token> returns snapshot JSON | 200 with frozen transcript JSON |
| GET /share/<expired-token> returns 410 | 410 Gone |
| GET /share/<unknown-token> returns 404 | 404 Not Found |
| GET /api/anything without cookie still returns 401 | Auth bypass is scoped to /share/ prefix only |
