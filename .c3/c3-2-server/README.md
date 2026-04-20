---
id: c3-2
title: Server
type: container
parent: c3-0
goal: 'Run the local Bun backend: serve HTTP+WebSocket, coordinate Claude + Codex agent turns, persist events, and broadcast derived read models.'
boundary: service
c3-version: 4
---

# server
## Goal

Run the local Bun backend: serve HTTP+WebSocket on localhost, coordinate Claude + Codex agent turns, persist events, and broadcast derived read models.
## Responsibilities

- Own the authoritative event log and derived read models; every state mutation lands as a JSONL event first.
- Accept WebSocket subscriptions and commands; push fresh snapshots on every change.
- Drive multi-provider agent turns (Claude Agent SDK, Codex App Server) through a single coordinator.
- Discover local projects, manage terminals and uploads, operate share tunnels.
- Gate network access (auth), supervise its own CLI lifecycle, and refuse to leave localhost unless explicitly asked.
## Complexity Assessment

**Level:** <!-- [trivial|simple|moderate|complex|critical] -->
**Why:** <!-- signals observed from code analysis -->
## Components

| ID | Name | Category | Status | Goal Contribution |
|----|------|----------|--------|-------------------|
| c3-201 | cli-entry | foundation | implemented | CLI parsing, supervisor, browser launcher |
| c3-202 | http-ws-server | foundation | implemented | HTTP + WS + static serving |
| c3-203 | auth | foundation | implemented | Password + session cookie gating |
| c3-204 | paths-config | foundation | implemented | Central data-path resolution |
| c3-205 | events-schema | foundation | implemented | Typed event unions for the log |
| c3-206 | event-store | foundation | implemented | Append-only JSONL + replay + snapshot compaction |
| c3-207 | read-models | foundation | implemented | Derived views from event state |
| c3-208 | ws-router | foundation | implemented | WS subscribe/command multiplexer |
| c3-209 | process-utils | foundation | implemented | Shared process lifecycle helpers |
| c3-210 | agent-coordinator | feature | implemented | Multi-provider turn orchestration |
| c3-211 | codex-app-server | feature | implemented | Codex App Server JSON-RPC adapter |
| c3-212 | provider-catalog | feature | implemented | Provider/model/effort normalization |
| c3-213 | quick-response | feature | implemented | Structured Haiku queries with Codex fallback |
| c3-214 | discovery | feature | implemented | Auto-discover local Claude + Codex projects |
| c3-215 | diff-store | feature | implemented | Per-chat diff state for file-change UI |
| c3-216 | terminal-manager | feature | implemented | PTY sessions for embedded terminal |
| c3-217 | uploads | feature | implemented | File upload handling |
| c3-218 | share | feature | implemented | Cloudflare quick + named tunnels + QR |
| c3-219 | update-manager | feature | implemented | npm version checking |
| c3-220 | restart | feature | implemented | In-place server relaunch |
| c3-221 | external-open | feature | implemented | Open URLs/files in external apps |
| c3-222 | keybindings | feature | implemented | Persist user keybindings |
## Layer Constraints

This container operates within these boundaries:

**MUST:**
- Coordinate components within its boundary
- Define how context linkages are fulfilled internally
- Own its technology stack decisions

**MUST NOT:**
- Define system-wide policies (context responsibility)
- Implement business logic directly (component responsibility)
- Bypass refs for cross-cutting concerns
- Orchestrate other containers (context responsibility)
