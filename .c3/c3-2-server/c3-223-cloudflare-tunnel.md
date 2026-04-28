---
id: c3-223
title: cloudflare-tunnel
type: component
category: feature
parent: c3-2
goal: Detect listening dev-server ports from Bash tool output via a haiku LLM classifier, then expose them through opt-in `cloudflared` quick tunnels with inline transcript UX.
uses:
    - ref-cqrs-read-models
    - ref-strong-typing
    - ref-ws-subscription
c3-version: 4
---

# cloudflare-tunnel
## Goal

Detect listening dev-server ports from Bash tool output via a haiku LLM classifier, then expose them through opt-in `cloudflared` quick tunnels with inline transcript UX.

## Container Connection

Lets users access localhost services running inside Kanna-managed projects from outside the local network without invoking `cloudflared` manually. Hooks into the Agent's Bash tool result path; emits events that flow through the same WS broadcast pipeline as auto-continue.

## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | `query()` from `@anthropic-ai/claude-agent-sdk` for haiku classification | external SDK |
| IN (uses) | `cloudflared` CLI (assumed installed; path configurable) | external binary |
| IN (consumes) | Bash `tool_use`/`tool_result` entries | c3-210 (agent-coordinator) |
| IN (consumes) | `cloudflareTunnel` settings block | c3-225 (app-settings) — see settings normalization |
| OUT (provides) | Tunnel state projection (`tunnels`, `liveTunnelId` on `ChatSnapshot`) | c3-207 (read-models) |
| OUT (provides) | `tunnel.accept` / `tunnel.stop` / `tunnel.retry` WS commands | c3-208 (ws-router) |

## Code References

| File | Purpose |
|------|---------|
| `src/server/cloudflare-tunnel/events.ts` | Versioned discriminated union: `tunnel_proposed`/`tunnel_accepted`/`tunnel_active`/`tunnel_stopped`/`tunnel_failed`. |
| `src/server/cloudflare-tunnel/read-model.ts` | `deriveChatTunnels(events, chatId?)` projects events into `{ tunnels, liveTunnelId }`. |
| `src/server/cloudflare-tunnel/detector.ts` | `evaluateBashOutput({command, stdout, client})` returns `{isServer, port?}`. Trims stdout to 2KB tail; prompt cap 4KB. |
| `src/server/cloudflare-tunnel/haiku-client.ts` | Production wrapper around Claude Agent SDK `query()` with `claude-haiku-4-5-20251001` + JSON-schema output, 5s timeout. |
| `src/server/cloudflare-tunnel/tunnel-manager.ts` | Spawns `cloudflared tunnel --url http://localhost:PORT`; parses `*.trycloudflare.com` URL; tracks active tunnels by port and id. |
| `src/server/cloudflare-tunnel/lifecycle.ts` | Polls source PIDs; fires `onSourceExit` when the originating dev-server process disappears. |
| `src/server/cloudflare-tunnel/agent-integration.ts` | `handleBashToolResult` bridges detector hits to event emission; honors `enabled` and `mode` settings. |
| `src/server/cloudflare-tunnel/gateway.ts` | `TunnelGateway` composes manager + lifecycle + store + broadcast. Single entry point used by agent + ws-router. |
| `src/server/cloudflare-tunnel/e2e.test.ts` | Integration test: propose → accept → active → stop. |

## Settings

```ts
type CloudflareTunnelSettings = {
  enabled: boolean              // default false (opt-in)
  cloudflaredPath: string       // default "cloudflared"
  mode: "always-ask" | "auto-expose"  // default "always-ask"
}
```

Persisted in `~/.kanna/data/settings.json`. UI section in `c3-116 settings-page`. Setter `AppSettingsManager.setCloudflareTunnel(patch)` persists + broadcasts via WS snapshot push.

## Lifecycle Termination Triggers

| Trigger | Reason field |
|---------|--------------|
| User clicks Stop | `user` |
| Source dev-server PID exits | `source_exited` |
| Chat/session closes | `session_closed` |
| Server shutdown | `server_shutdown` |

## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-cqrs-read-models | Tunnel state projected from event log; pushed via WS snapshot. |
| ref-ws-subscription | Read-model push (not pull) for tunnel state changes. |
| ref-strong-typing | Discriminated event union; `HaikuClient` interface for test injection; `SpawnFn`/`ChildHandle` boundaries — no `any`. |

## Layer Constraints

This component operates within these boundaries:

**MUST:**
- Stay opt-in: `enabled: false` default; no haiku call when disabled.
- Respect ephemeral nature: tunnel records in-memory only; events persisted to `tunnels.jsonl` for in-session replay.
- Inject `HaikuClient` and `SpawnFn` for tests; never spawn real processes or call real LLM in unit tests.
- Use the same WS broadcast pipeline as auto-continue; do not invent a new push channel.

**MUST NOT:**
- Call cloudflared with anything other than quick-tunnel form (`tunnel --url http://localhost:PORT`) — named tunnels out of scope for v1.
- Persist tunnel state across server restarts (URLs are ephemeral by Cloudflare design).
- Auto-install cloudflared (out of scope; fail with helpful error if missing).
- Couple to specific port allow/deny lists — out of scope for v1.
