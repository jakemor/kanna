# Kanna — development notes

Kanna is a local web UI for coding agents (Claude Code, Codex, Cursor, Pi).
Bun server + React 19 client, talking over one WebSocket.

## Commands

- `bun run dev` — client (Vite) + server together
- `bun test` — unit/integration suite (Bun test)
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
- A chat subscription holds a window of the transcript, not all of it:
  the last N assistant messages (`transcript.windowAssistantMessages`,
  default 50), widened to reach the read anchor. `chat.loadOlder` moves the
  window back and the older slice arrives as an incremental push that lands
  in front. `outline` on the snapshot names every user prompt so the minimap
  covers the whole chat. Logic in `src/shared/transcript-window.ts`.
- Provider adapters normalize three different wire protocols into
  `HarnessEvent`s (`harness-types.ts`). Claude runs through the Agent SDK in
  `agent.ts` directly; codex/cursor/pi produce `HarnessTurn`s.
- Transcripts are append-only JSONL per chat (`transcripts/<chatId>.jsonl`)
  with a small LRU cache in the EventStore. `debugRaw` (raw provider JSON) is
  stamped only on `system_init` — the one entry with a raw JSON view. Tool
  results keep `tool_use_result` as `structuredResult` instead, and only for
  `ask_user_question` / `exit_plan_mode`.
- The transcript file holds entries in header form. Tool bodies (file
  contents, edits, command output) live in `transcripts/<chatId>.payloads.jsonl`
  and are read by byte offset when a row is opened (`transcript-payloads.ts`).
  Images in tool results are files under `media/<chatId>/`, referenced by URL
  (`transcript-media.ts`). `getMessages()` merges everything back for export,
  handoff and fork. `slimTranscripts` rewrites older transcripts to this shape
  once per data dir (`kanna slim-transcripts` forces it). Agents handed a
  transcript path see headers only.

## Conventions

- `src/shared/` is imported by both sides — no Bun/node imports there.
- New WS commands: add to `shared/protocol.ts`, handle in `ws-router.ts`,
  and prefer targeted `broadcastFilteredSnapshots({...})` over full
  broadcasts (name exactly the topics the command can change).
- Tests live next to their module (`foo.ts` / `foo.test.ts`) and run in Bun.
  The `.e2e.ts` suffix keeps a file out of `bun test`'s default sweep (used
  by the cloud wire e2e).
- When tests need git, they create throwaway repos; in sandboxes set
  `GIT_CONFIG_GLOBAL` to a clean config so URL rewrites/identity don't leak in.

## iOS app (`ios/`)

- `ios/` is its own git repository (ignored by this one). Commit iOS
  changes there.
- The web client and the iOS app share most screens (composer, sidebar,
  chat). When a bug report or request does not say which one it is about,
  ask before touching code. A fix on the wrong platform is wasted work.

## Remote REST API (`src/server/api/`)

- Off by default. `kanna --api --api-key=<k1,k2>` (or `--api-key-file=<path>`,
  one key per line) mounts `/api/v1`. Pair with the existing `--remote` to
  reach it off-loopback. `--api` without keys is a startup error — the API
  has no session, origin check or login in front of it, so an unkeyed one
  would be wide open.
- `routes.ts` calls the same `EventStore` and `AgentCoordinator` the socket
  does, then `broadcastSnapshots()`, so a chat created over HTTP shows up in
  a connected browser straight away. It deliberately does *not* reuse
  ws-router's `handleCommand`, which is bound to a socket — when you change
  the semantics of `chat.send`, `chat.delete` or `project.open` there, check
  whether the matching route needs the same change — including the analytics
  event, which the routes emit to the same reporter.
- Anything a request can name that the harness looks up later must be
  validated at the route. `provider` in particular: an unknown one only
  surfaces when the turn is set up, and for a queued prompt that is after the
  202, in `dequeueAndStartQueuedMessage` — which removes the queued message
  before the catalog lookup throws, so the prompt would be acknowledged and
  then silently dropped.
- Prompts are async: `POST /chats/:id/messages` answers 202 and the caller
  polls `GET /chats/:id`. A turn runs far longer than any HTTP client will
  wait. `queued: true` means it landed behind a running turn.
- The route claims `/api/v1` even when the API is unmounted, answering a JSON
  404 — otherwise the SPA fallback returns index.html with a 200 and a client
  cannot tell the API is off (same reason `/__cloud` 404s explicitly).
- A valid key substitutes for the `--password` session on `/api/v1` only;
  every other `/api/` route still needs the cookie. Raw cloud-tunnel traffic
  (`requestClass === "untrusted"`) still sees nothing but `/health` and `/ws`,
  so the API is not reachable through a paired machine's tunnel by design.
- `/health` reports `api`, so a second `kanna --api` against an already-running
  instance can tell that its flags will not take effect: it exits 1 asking for
  a restart when that instance has no API, and warns that this run's keys were
  not applied when it does.

## Cloud contract

- `src/shared/cloud-api.ts` is the wire contract with the hosted control
  plane/proxy (kanna-site, a separate private repo that deploys
  independently). It is **append-only**: never remove or rename a field or
  constant; add optional fields only — machines in the wild must keep working.
  The file is mirrored verbatim at `kanna-site/src/shared/cloud-api.ts`; keep
  the two copies identical when changing either.
- The machine side lives in `src/server/cloud/` (identity file, control-plane
  client, tunnel supervisor, request guard). The hosted proxy sees proxied
  HTTP but never WebSocket frames — the browser's WS connects directly to the
  machine's tunnel.
- `bun run test:cloud` runs the cross-repo wire e2e against a local
  `wrangler dev` of `../kanna-site` (skips if the sibling repo is missing).
