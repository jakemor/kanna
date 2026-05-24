---
id: c3-203
c3-version: 4
c3-seal: 1e8aba899cef58a6197200c340a2b8ddb5a97ad954c783c31f314096d1ada971
title: auth
type: component
category: foundation
parent: c3-2
goal: Gate HTTP, WebSocket, and API routes behind a launch-password session cookie when `--password` is set.
uses:
    - ref-local-first-data
---

# auth

## Goal

Gate HTTP, WebSocket, and API routes behind a launch-password session cookie when `--password` is set.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Protect remote/shared servers behind launch-password" |
| Category | foundation |
| Lifecycle | Middleware module bound at HTTP server boot |
| Replaceability | Replaceable provided cookie + 401 contract preserved |

## Purpose

Issues and validates a launch-password session cookie, blocks unauthenticated HTTP/WS/API requests, and surfaces a login form when `--password` is set. Non-goals: per-user accounts, OAuth, multi-tenant auth — single launch password only.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | CLI flag --password provided when sharing | c3-201 |
| Input — paths | Reads cookie secret from data dir | c3-204 |
| Internal state | Session cookie hashed in memory | c3-203 |
| Initialization | Bound by http-ws-server before route registration | c3-202 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | Public/shared servers stay safe behind a password | c3-218 |
| Primary path | POST /login → set-cookie → cookie attached to subsequent reqs | c3-202 |
| Alternate — local-only | No password set: middleware passthrough | c3-203 |
| Failure — 401 | Closes WS upgrade with auth-required signal | c3-101 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-local-first-data | ref | Wider surfaces require password | must follow | Local-only bind is unauthenticated |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| attachAuth(server) | OUT | Wraps HTTP server, gates routes | c3-202 | src/server/auth.ts |
| Login endpoint | IN | Accepts password form, sets session cookie | c3-202 | src/server/auth.ts |
| WS auth check | OUT | Rejects upgrade without valid cookie | c3-208 | src/server/auth.ts |
| isPublicSharePath(url) | OUT | Exempts /share/* and /assets/share-view/* from owner auth; called at the top of the middleware before any cookie check | c3-228 | src/server/auth.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Cookie leakage | Wrong cookie attributes | Token shows up in non-secure context | bun run check + smoke src/server/auth.ts with --password |
| Bypass on WS upgrade | Middleware skipped for upgrade | Unauthorized clients connect | bun run check + manual upgrade smoke against src/server/auth.ts |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/auth.ts | c3-203 Contract | Middleware detail | src/server/auth.ts |
