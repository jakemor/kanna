# Kanna

A web-first chat UI for using Claude Code in style. Remote access coming soon.

## Quickstart

```bash
bun install -g kanna-code
```

Then run from anywhere:

```bash
kanna
```

## Features

- **Project-first sidebar** — chats grouped under projects, with status indicators (idle, running, waiting, failed)
- **Local project discovery** — auto-discovers projects from `~/.claude/projects`
- **Rich transcript rendering** — user messages, assistant responses, collapsible tool call groups, plan mode dialogs, and interactive prompts
- **Plan mode** — review and approve agent plans before execution
- **Persistent local history** — refresh-safe routes backed by JSONL event logs and compacted snapshots
- **Auto-generated titles** — chat titles generated in the background via Claude Haiku
- **Session resumption** — resume agent sessions with full context preservation
- **WebSocket-driven** — real-time subscription model with reactive state broadcasting

## Architecture

```
Browser (React + Zustand)
    ↕  WebSocket
Bun Server (HTTP + WS)
    ├── WSRouter ─── subscription & command routing
    ├── AgentCoordinator ─── Claude Agent SDK turn management
    ├── EventStore ─── JSONL persistence + snapshot compaction
    └── ReadModels ─── derived views (sidebar, chat, projects)
    ↕  stdio
Claude Agent SDK (local process)
    ↕
Local File System (~/.kanna/data/, project dirs)
```

**Key patterns:** Event sourcing for all state mutations. CQRS with separate write (event log) and read (derived snapshots) paths. Reactive broadcasting — subscribers get pushed fresh snapshots on every state change. Agent coordination with tool gating for user-approval flows.

## Requirements

- [Bun](https://bun.sh)
- A working Claude Agent SDK environment

## Install

```bash
bun install
```

## Run

```bash
bun run build
bun run start
```

Or use the CLI directly:

```bash
kanna
```

Flags:

```bash
bun run start -- --no-open
bun run start -- --port 4000
```

Default URL: `http://localhost:3210`

## Development

```bash
bun run dev
```

Or run client and server separately:

```bash
bun run dev:client   # http://localhost:5174
bun run dev:server   # http://localhost:3211
```

## Scripts

| Command              | Description                  |
| -------------------- | ---------------------------- |
| `bun run build`      | Build for production         |
| `bun run check`      | Typecheck + build            |
| `bun run dev`        | Run client + server together |
| `bun run dev:client` | Vite dev server only         |
| `bun run dev:server` | Bun backend only             |
| `bun run start`      | Start production server      |

## Project Structure

```
src/
├── client/          React UI layer
│   ├── app/         App router, pages, central state hook, socket client
│   ├── components/  Messages, chat chrome, dialogs, buttons, inputs
│   ├── hooks/       Theme, standalone mode detection
│   ├── stores/      Zustand stores (chat input persistence)
│   └── lib/         Formatters, path utils, transcript parsing
├── server/          Bun backend
│   ├── cli.ts       CLI entry point & browser launcher
│   ├── server.ts    HTTP/WS server setup & static serving
│   ├── agent.ts     AgentCoordinator (Claude SDK turn management)
│   ├── ws-router.ts WebSocket message routing & subscriptions
│   ├── event-store.ts  JSONL persistence, replay & compaction
│   ├── discovery.ts Auto-discover projects from ~/.claude/projects
│   ├── read-models.ts  Derive view models from event state
│   └── events.ts    Event type definitions
└── shared/          Shared between client & server
    ├── types.ts     Core data types
    ├── protocol.ts  WebSocket message protocol
    ├── ports.ts     Port configuration
    └── branding.ts  App name, data directory paths
```

## Data

All state is stored locally at `~/.kanna/data/`:

| File             | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `projects.jsonl` | Project open/remove events                |
| `chats.jsonl`    | Chat create/rename/delete events          |
| `messages.jsonl` | Transcript message entries                |
| `turns.jsonl`    | Agent turn start/finish/cancel events     |
| `snapshot.json`  | Compacted state snapshot for fast startup |

Event logs are append-only JSONL. On startup, Kanna replays the log tail after the last snapshot, then compacts if the logs exceed 2 MB.
