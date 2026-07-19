# Kanna — development notes

Kanna is a local web UI for coding agents (Claude Code, Codex, Cursor, Pi).
Bun server + React 19 client, talking over one WebSocket.

## Commands

- `bun run dev` — client (Vite) + server together
- `bun test` — unit/integration suite (Bun test)
- `bun run test:e2e` — build + Playwright smoke suite (boots the real server against a temp HOME)
- `bun run check` — typecheck + both production builds
- `bun run build` — client + export-viewer bundles

## How it fits together

```
React client (src/client)
  socket.ts ── one WebSocket ──► WSRouter (src/server/ws-router.ts)
                                   ├─ commands: switch on ClientCommand (shared/protocol.ts)
                                   ├─ snapshots: per-topic push with dedupe signatures
                                   ├─ AgentCoordinator (agent.ts) ── provider adapters:
                                   │    Claude Agent SDK (in agent.ts) · codex-app-server.ts
                                   │    cursor-cli.ts · pi-agent.ts
                                   └─ EventStore (event-store.ts): JSONL logs + snapshot
                                      compaction + per-chat transcripts (~/.kanna/data)
```

- **Everything the client renders comes from server snapshots** pushed per
  subscription topic (`sidebar`, `chat`, `project-git`, `local-projects`,
  `update`, `keybindings`, `app-settings`, `terminal`). The client sends
  commands; it never mutates server state locally except optimistic user
  prompts (reconciled by content signature).
- Snapshot pushes dedupe by signature: sidebar/chat use the serialized
  snapshot itself (built once per broadcast and shared across sockets),
  project-git uses a version counter. Keep that property when adding topics.
- Provider adapters normalize three different wire protocols into
  `HarnessEvent`s (`harness-types.ts`). Claude runs through the Agent SDK in
  `agent.ts` directly; codex/cursor/pi produce `HarnessTurn`s.
- Transcripts are append-only JSONL per chat (`transcripts/<chatId>.jsonl`)
  with a small LRU cache in the EventStore. `debugRaw` (raw provider JSON) is
  stamped only on `system_init` and Claude `tool_result` entries — the only
  places the client reads it.

## Conventions

- `src/shared/` is imported by both sides — no Bun/node imports there.
- New WS commands: add to `shared/protocol.ts`, handle in `ws-router.ts`,
  and prefer targeted `broadcastFilteredSnapshots({...})` over full
  broadcasts (name exactly the topics the command can change).
- Tests live next to their module (`foo.ts` / `foo.test.ts`) and run in Bun.
  Playwright specs live in `e2e/*.e2e.ts` (the `.e2e.ts` suffix keeps
  `bun test` from picking them up).
- When tests need git, they create throwaway repos; in sandboxes set
  `GIT_CONFIG_GLOBAL` to a clean config so URL rewrites/identity don't leak in.
