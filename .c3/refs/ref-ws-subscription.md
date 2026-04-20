---
id: ref-ws-subscription
title: WebSocket Subscription
goal: A single typed WebSocket handles both subscriptions (push) and commands (pull), with a shared envelope defined in src/shared/protocol.ts.
c3-version: 4
---

# ws-subscription
## Goal

A single typed WebSocket handles both subscriptions (push) and commands (pull), with a shared envelope defined in src/shared/protocol.ts.
## Choice

One WS per client. Server-side ws-router multiplexes subscribe/unsubscribe/command. Client-side socket.ts maintains the connection and dispatches typed envelopes.
## Why

Keeps the wire count flat, reuses the auth cookie, pairs naturally with the reactive read-model broadcast. Avoids REST polling, still supports one-shot commands.
## How

| Guideline | Example |
|-----------|---------|
| All message shapes live in src/shared/protocol.ts | WsInbound / WsOutbound unions |
| Commands return correlation IDs | request/response still works over the same socket |
| Subscriptions receive full snapshots, not diffs | simpler reconciliation |
## Not This

<!-- Alternatives we rejected and why -->

| Alternative | Rejected Because |
|-------------|------------------|
| ... | ... |
## Scope

<!-- Where does this choice apply? Be explicit about exclusions. -->

**Applies to:**
- <!-- containers/components where this ref governs behavior -->

**Does NOT apply to:**
- <!-- explicit exclusions -->
## Override

<!-- How to deviate from this choice when justified -->

To override this ref:
1. Document justification in an ADR under "Pattern Overrides"
2. Cite this ref and explain why the override is necessary
3. Specify the scope of the override (which components deviate)
## Cited By

<!-- Updated when components cite this ref -->
- c3-{N}{NN} ({component name})
