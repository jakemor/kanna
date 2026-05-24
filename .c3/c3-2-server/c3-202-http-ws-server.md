---
id: c3-202
c3-version: 4
c3-seal: f58866c80e38d426fb062c197cd5da0d5523016aed3a1e393a6b1a7a46e168c5
title: http-ws-server
type: component
category: foundation
parent: c3-2
goal: Serve HTTP (static + API) and upgrade to WebSocket; attach auth gating; expose `/health`.
uses:
    - c3-228
    - ref-local-first-data
    - ref-ws-subscription
---

# http-ws-server

## Goal

Serve HTTP (static + API) and upgrade to WebSocket; attach auth gating; expose `/health`.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Expose HTTP + WebSocket endpoints to the local browser" |
| Category | foundation |
| Lifecycle | Singleton listener per server process |
| Replaceability | Replaceable provided HTTP+WS contract and auth hookup preserved |

## Purpose

Hosts the Bun-side HTTP server, serves built client assets, exposes API + upgrade endpoints, gates connections via the auth middleware, and routes upgraded sockets to the WS router. Non-goals: business logic, persistence, projection state.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | CLI parsed and port resolved | c3-201 |
| Input — auth gate | Cookie-based middleware | c3-203 |
| Input — WS router | Receives upgraded sockets | c3-208 |
| Input — port defaults | Shared port constants | c3-304 |
| Initialization | Invoked from CLI after flag parse | c3-201 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Client connects, authenticates, opens single WS | c3-101 |
| Primary path | HTTP serves assets → upgrade → ws-router | c3-208 |
| Alternate — health | /health returns 200 for liveness checks | c3-202 |
| Alternate — API | /api/* routes serve JSON endpoints (uploads, etc.) | c3-217 |
| Failure — auth reject | 401 close on missing/invalid cookie | c3-203 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-ws-subscription | ref | Single-WS upgrade pattern | must follow | Hand off to ws-router |
| ref-local-first-data | ref | Default bind 127.0.0.1 | must follow | Wider bind requires explicit flag |
| c3-228 | ref | /share/:token and /assets/share-view/* routes are dispatched before the auth gate | must follow | Wired for session-share coupling |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| HTTP listener | IN | Serves static assets + API + upgrade | c3-101 | src/server/http.ts |
| WS upgrade hookup | OUT | Hands socket to ws-router | c3-208 | src/server/http.ts |
| /health | OUT | Liveness probe | c3-2 | src/server/http.ts |
| /share/:token | OUT | Public read-only snapshot endpoint dispatched BEFORE the auth gate; serves frozen chat snapshot JSON | c3-228 | src/server/http.ts |
| /assets/share-view/* | OUT | Reserved static path for the share viewer bundle, also pre-auth | c3-228 | src/server/http.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Auth bypass | Middleware order regression | Unauthenticated requests succeed | bun run check + smoke src/server/http.ts with --password |
| Static asset 404 | Build path drift | UI fails to load | bun run check against src/server/http.ts |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/http.ts | c3-202 Contract | Listener detail | src/server/http.ts |
