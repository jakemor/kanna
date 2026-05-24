---
id: c3-228
c3-seal: c075f58df754a05ab3df66fb992f5f745a6990105e0d5d1b73ad54a7dd5b9079
title: session-share
type: component
category: feature
parent: c3-2
goal: Mint time-limited read-only share tokens for finished Kanna chat sessions, persist frozen snapshots under ~/.kanna/shares/, serve them at /share/:token without auth, and sweep expired tokens via TTL.
uses:
    - ref-cqrs-read-models
    - ref-event-sourcing
    - ref-local-first-data
    - ref-side-effect-adapter
    - ref-strong-typing
---

## Goal

Mint time-limited read-only share tokens for finished Kanna chat sessions, persist frozen snapshots under ~/.kanna/shares/, serve them at /share/:token without auth, and sweep expired tokens via TTL.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Provide opt-in session sharing without requiring recipient auth" |
| Category | feature |
| Lifecycle | Service started at boot; route registered before HTTP server binds; sweep timer fires on interval |
| Replaceability | Replaceable provided token mint, snapshot GET, and sweep contract preserved |

## Purpose

Owns the complete lifecycle of a read-only session share: receive mint request from ws-router (c3-208), build a frozen JSON snapshot from event-store read-models (c3-207), persist it under ~/.kanna/shares/<token>.json (mode 0600) via snapshot-store adapter, append share.token_minted to the shares JSONL log (c3-206), return the public URL. Serves the snapshot at GET /share/:token exempt from auth (c3-203 path-prefix bypass). Runs a TTL sweep that appends share.token_expired and deletes expired files. Non-goals include live transcript streaming to viewers, per-viewer access logs, multi-tenant user accounts, and hosting snapshots outside ~/.kanna/.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | Cloudflare tunnel active (c3-218/c3-223); server running; chat has at least one event | c3-218 |
| Input — ws-router | share.mint WsEnvelope carrying chatId and requestedTtlHours | c3-208 |
| Input — event-store | Replayed event log for the target chat | c3-206 |
| Input — read-models | Chat title, transcript entries, metadata from projection | c3-207 |
| Input — paths-config | ~/.kanna/shares/ directory resolved at boot | c3-204 |
| Internal state | In-memory share projection (token → ShareRecord) rebuilt from shares JSONL on startup | c3-228 |
| Initialization | SessionShareService registered in server bootstrap; HTTP route added to c3-202 | c3-202 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Owner receives a URL they can paste to any browser; recipient sees a frozen read-only transcript | c3-2 |
| Primary path | ws share.mint → build snapshot → write file (mode 0600) → append share.token_minted → return tunnel URL | c3-208 |
| Alternate — NO_TUNNEL | No active tunnel: return error envelope NO_TUNNEL; no file written, no event appended | c3-218 |
| Alternate — sweep expiry | TTL cron fires → load share projection → for each expired token: delete file + append share.token_expired | c3-228 |
| Alternate — startup replay | On boot, replay shares JSONL; any token past TTL is expired immediately (fail-closed) | c3-206 |
| Failure — snapshot read error | File missing or corrupt on GET: return 404 | c3-228 |
| Failure — expired token on GET | Token past TTL: return 410 Gone | c3-228 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-local-first-data | ref | Snapshots must live under ~/.kanna/shares/ (mode 0600) | must follow | No remote upload |
| ref-event-sourcing | ref | share.token_minted and share.token_expired appended before any mutation | must follow | Shares log is append-only JSONL |
| ref-cqrs-read-models | ref | Share lookup reads from in-memory projection rebuilt from shares log | must follow | No direct disk scan for token lookup |
| ref-side-effect-adapter | ref | All fs reads/writes in snapshot-store.adapter.ts only | must follow | No direct fs calls in service or route |
| ref-strong-typing | ref | ShareSnapshot, ShareToken, share event payloads — no any | must follow | tsc strict enforced |
| adr-20260524-session-share | adr | Full decision record including affected topology and compliance | governs this component | Accepted |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| mintShare(chatId, ttlHours) | IN | Builds snapshot, persists file, appends event, returns share URL or NO_TUNNEL error | c3-208 | src/server/session-share/session-share-service.ts |
| GET /share/:token | IN | Returns frozen ShareSnapshot JSON if valid; 404 if unknown; 410 if expired | c3-202 | src/server/session-share/share-route.ts |
| sweepExpired() | IN | Appends share.token_expired and deletes file for each token past TTL | internal timer | src/server/session-share/snapshot-sweep.ts |
| snapshot-store adapter | IN/OUT | readSnapshot(token), writeSnapshot(token, data), deleteSnapshot(token) | c3-204 | src/server/session-share/snapshot-store.adapter.ts |
| share projection | IN | Projects share events into Map<token, ShareRecord>; rebuilt on startup replay | c3-206 | src/server/session-share/share-projection.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Auth bypass widened | /share/ prefix extended or middleware ordering changed | Unauthenticated requests reach protected routes | bun test share-route.test.ts: non-share paths still return 401 |
| Snapshot disk leak | sweep timer stopped or share.token_expired not appended on expiry | ~/.kanna/shares/ grows unbounded | bun test src/server/session-share/snapshot-sweep.test.ts: asserts file deleted after TTL |
| Stale snapshot served | GET route reads file without checking projection expiry | Expired token returns 200 instead of 410 | bun test src/server/session-share/share-route.test.ts: expired fixture returns 410 |
| Event schema drift | New share event kind added without projection handler | Replay corrupts in-memory map | bun test share-projection.test.ts covers all event kinds |
| Token collision | PRNG weakness produces duplicate 256-bit token | Two chats share same file | Token uniqueness assertion in token.ts unit test |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/session-share/session-share-service.ts | c3-228 Contract: mintShare, sweepExpired | Orchestration detail | src/server/session-share/session-share-service.ts |
| src/server/session-share/share-route.ts | c3-228 Contract: GET /share/:token | HTTP framework detail | src/server/session-share/share-route.ts |
| src/server/session-share/snapshot-store.adapter.ts | c3-228 Contract: snapshot-store adapter | fs implementation detail | src/server/session-share/snapshot-store.adapter.ts |
| src/server/session-share/share-projection.ts | c3-228 Contract: share projection | Projection implementation | src/server/session-share/share-projection.ts |
| src/server/session-share/snapshot-sweep.ts | c3-228 Contract: sweepExpired | Cron wiring detail | src/server/session-share/snapshot-sweep.ts |
| src/server/session-share/share-route.test.ts | c3-228 Contract: GET /share/:token | Test fixture detail | src/server/session-share/share-route.test.ts |
