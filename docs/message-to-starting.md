# Message To `Starting...`

This documents the path from a user submitting a prompt to the transcript showing the `Starting...` processing row.

## High-level sequence

1. The composer calls `handleSend(...)` in `src/client/app/useKannaState.ts`.
2. The client immediately inserts an optimistic `user_prompt` entry into local state.
3. The client sends a `chat.send` websocket command.
4. The server handles `chat.send` in `src/server/ws-router.ts`, which delegates to `AgentCoordinator.send(...)` in `src/server/agent.ts`.
5. If this is a new chat, the server creates the chat before starting the turn.
6. `startTurnForChat(...)` runs the preflight work:
   - sets provider if missing
   - persists plan mode
   - applies an optimistic title for the first message in a new chat
   - appends the real `user_prompt` transcript entry
   - records `turn_started`
7. The server boots the provider turn:
   - Claude: creates or reuses the Claude session, then sends the prompt
   - Codex: starts the Codex session, then starts the turn
8. The server registers the turn in `activeTurns` with runtime status:
   - Claude: `running`
   - Codex: `starting`
9. `AgentCoordinator` calls `onStateChange()`.
10. The server broadcasts fresh snapshots through `broadcastSnapshots()` in `src/server/ws-router.ts`.
11. `deriveChatSnapshot(...)` in `src/server/read-models.ts` merges persisted transcript data with the in-memory active runtime status.
12. The client chat subscription receives the new `ChatSnapshot`.
13. `useKannaState(...)` resolves `runtime.status` from that snapshot.
14. `ChatPage.tsx` renders `<ProcessingMessage status="starting" />` when `state.isProcessing` is true and `runtime.status === "starting"`.
15. `ProcessingMessage.tsx` maps `starting` to the label `Starting...`.

## Important implication

The optimistic user message does not control `Starting...`.

`Starting...` only appears after the server has:

- accepted the `chat.send` command
- started the turn
- registered the active runtime as `starting`
- rebroadcast a chat snapshot
- had the client receive and render that snapshot

Any latency in that chain increases the gap between the optimistic prompt and the loading row.

## Instrumentation added

### Client

`src/client/app/useKannaState.ts` now creates a per-send `clientTraceId` and logs these checkpoints:

- `handle_send_called`
- `optimistic_prompt_added`
- `chat_send_ack_received`
- `chat_snapshot_received`
- `runtime_status_starting`
- `starting_render_committed`
- `starting_not_observed`

Enable client profiling in the browser console:

```js
sessionStorage.setItem("kanna:profile-send-to-starting", "1")
```

Reload after setting it. Logs appear in the browser console with the prefix:

```text
[kanna/send->starting][client]
```

### Server

`src/server/agent.ts` and `src/server/ws-router.ts` now log the server-side checkpoints for the same `clientTraceId`:

- `chat_send.received`
- `chat_send.chat_created`
- `start_turn.begin`
- `start_turn.provider_set`
- `start_turn.plan_mode_set`
- `start_turn.optimistic_title_set`
- `start_turn.user_prompt_appended`
- `start_turn.turn_started_recorded`
- `start_turn.provider_boot.begin`
- `start_turn.session_ready`
- `start_turn.provider_boot.ready`
- `start_turn.active_turn_registered`
- `start_turn.state_change_emitted`
- `start_turn.claude_prompt_sent`
- `chat_send.ready_for_ack`
- `ws.snapshot_sent`
- `ws.chat_send_ack`

Enable server profiling before starting Kanna:

```bash
KANNA_PROFILE_SEND_TO_STARTING=1 bun run ./src/server/cli.ts
```

Server logs appear with the prefix:

```text
[kanna/send->starting][server]
```

## How to read the timeline

For one send attempt, match client and server logs by `traceId`.

The main buckets are:

- Client preflight: `handle_send_called` -> `optimistic_prompt_added`
- Websocket roundtrip: `optimistic_prompt_added` -> `chat_send_ack_received`
- Server pre-turn work: `chat_send.received` -> `start_turn.turn_started_recorded`
- Provider startup: `start_turn.provider_boot.begin` -> `start_turn.provider_boot.ready`
- Snapshot propagation: `start_turn.state_change_emitted` / `ws.snapshot_sent` -> `chat_snapshot_received`
- UI commit: `runtime_status_starting` -> `starting_render_committed`

If the delay is growing over time, the likely suspects are:

- websocket command backlog
- event-store writes for transcript append / turn events
- provider session startup
- snapshot broadcast cost
- client snapshot reconciliation or render cost
