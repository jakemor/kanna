# Runtime portability — running Kanna's server off Bun

Status: phases 1–3 and most of 5 done (branch `portable-platform`); the rest
proposed. Written 2026-10-22, against `effect-migration` at 4972a9a.

Goal: most of the server (router, event store, orchestrator, provider
adapters, git logic, terminals' multiplexing) runs unchanged in a pure-JS
host, specifically a Cloudflare Durable Object. The agent CLIs, git and the
repo live in a container. Kanna on a laptop keeps working exactly as it does
today: that is the same code with local layers.

This builds on `docs/package-split.md` (which seams, which packages) and
`docs/effect-migration.md` (how services are written). The Effect migration
already did the hard part: almost every module that does IO is an Effect
that asks for a service. This doc says which services, split how, and what
still goes around them.

---

## 1. Three places, not one

Today one Bun process is three things at once, and every module reaches all
three through the same `FileSystem`, `Bun.spawn` and `process.env`:

| Place | What it holds | Today | Hosted |
|---|---|---|---|
| **Host** | the running server: sockets, HTTP, timers, fibers | Bun process | Durable Object |
| **Kanna state** | `~/.kanna/data`: event logs, transcripts, payload sidecars, media, settings, keybindings, usage cache, cloud identity, icon cache | files | DO SQLite (+ R2 for media/blobs) |
| **Machine** | repos, `git`/`gh`, the agent CLIs and their credentials (`~/.claude`, `~/.codex`, …), PTYs, local ports | the same laptop | a container |

The preparation work is making the code say which place it is talking to.
Once it does, each place is a set of layers, and a deployment is a choice of
layers.

```
               ┌──────────── Host (Bun today, DO later) ────────────┐
 browser ─WS──►│ ClientSocket ─► ws-router ─► orchestrator / agent  │
               │                     │              │               │
               │              KannaStore        Machine services    │
               └─────────────────┬───────────────────┬──────────────┘
                                 │                   │
                    files │ DO SQLite     local Bun │ RPC to runner
                                                     │
                                         ┌───────────▼────────────┐
                                         │ container: kanna-runner │
                                         │ BunServices over RPC    │
                                         │ git · claude · codex …  │
                                         └─────────────────────────┘
```

## 2. Where to cut the machine off: processes, not harnesses

There are two candidate cuts between the DO and the container.

**Harness-level** (package-split's topology C/E): the adapters run in the
container and stream `HarnessEvent`s back.

**Process-level** (recommended): the adapters stay in the host; only the
*process* (its stdin/stdout/stderr, exit, kill, PTY resize) and the
*machine's files* cross the wire.

Why process-level:

- The adapters are already stdio protocol parsers. Codex is JSON-RPC over
  `codex app-server` stdio, Cursor and Grok are stream-json from a CLI,
  Claude is the SDK's stream-json control protocol over the `claude` CLI.
  None of that needs the machine; it needs bytes.
- Everything that calls back into Kanna (permission prompts, ask-user, Kanna
  MCP tools that create chats or schedules, the orchestrator) stays next to
  the event store. A harness-level cut would put a second wire under each of
  those callbacks.
- `diff-store`, `github*`, `worktree-*`, `project-icons` run `git`/`gh` as
  processes and read repo files. Same cut, no git-specific protocol.
- It is one generic seam (Effect's own `ChildProcessSpawner` + `FileSystem`)
  instead of a bespoke protocol per subsystem.

The cost is chattiness: `git status` on a large repo is several spawns, each
now a round trip. That is a latency budget question (DO and container in the
same region, one multiplexed socket), not a design one. If a hot path turns
out to need it, that one call can become a higher-level runner RPC later
without changing the model.

Two exceptions are harness-shaped and run in the container regardless:

- **Pi** runs `@mariozechner/pi-coding-agent` in-process and executes its
  own tools (bash, edits). Either run it as a process in its RPC mode, or
  host the Pi adapter inside the runner and stream `HarnessEvent`s. Spike.
- **Claude** — see §5.

## 3. The services

Effect 4 already defines the machine-level services, and
`@effect/platform-bun`'s `BunServices.layer` already provides them:
`FileSystem`, `Path`, `ChildProcessSpawner` (`effect/process`), `Crypto`,
`Terminal`, `Stdio`. Kanna uses `FileSystem` and `Path` today (42 files) and
`ChildProcessSpawner` nowhere.

### 3.1 Machine (container-side capabilities)

| Service | Covers | Local layer | Remote layer |
|---|---|---|---|
| `Machine` (new tag) | `FileSystem`, `Path`, `ChildProcessSpawner` *for the machine* | `BunServices` | `RemoteMachine` (RPC client) |
| `PtySpawner` (new) | `Bun.Terminal` + `Bun.spawn` for terminals and provider login | Bun.Terminal | RPC client |
| `MachineInfo` (new) | `homedir`, `platform`, `env`, `hostname`, `which` | `node:os` / `process` / `Bun.which` | runner reports once at connect |
| `MachinePorts` (new) | `local-http-servers` (lsof/ps), port tunnels | execFile | runner, or unsupported |

The important bit is a **separate tag for the machine's file system**.
Today Kanna state and repo files both go through the one
`FileSystem.FileSystem`. In the hosted world those are different backends
(SQLite vs. container disk), so a module that reads `.git/HEAD` and a module
that appends a transcript must ask for different things. With separate tags
the type checker tracks which modules touch the machine, and a mixed module
shows up as a module that needs both.

### 3.2 Kanna state (host-side storage)

Not a fake file system. Emulating `fs` over SQLite would carry every file
assumption (append, rename-over, byte-offset reads, directory listings)
into a backend where they are the wrong shape. Instead, domain stores:

| Service | Today's files | Notes |
|---|---|---|
| `EventLog` | `*.jsonl` event logs + snapshot compaction | append, read-from-snapshot, compact |
| `TranscriptStore` | `transcripts/<chatId>.jsonl` + `.payloads.jsonl` | append entries; payload by key (today a byte span), slim/rewrite |
| `MediaStore` | `media/<chatId>/*`, uploads | put/get bytes by key → R2 hosted |
| `DocumentStore` | `settings.json`, keybindings, usage-limits, llm-provider, cloud identity, sidebar order | small JSON docs, read/write/watch |

Each gets a file layer that keeps today's `~/.kanna/data` layout byte for
byte (required: existing chats must load) and, later, a SQLite layer.
Effect ships `SqlClient`; a DO-SQLite client is a small layer over
`ctx.storage.sql`.

Watching: keybindings and settings watch their files for edits made outside
Kanna. Hosted, nothing outside edits them, so the SQLite layer's `changes`
stream is just its own writes.

### 3.3 Host

| Service | Replaces | Local | DO |
|---|---|---|---|
| `ClientSocket` (interface) | `ServerWebSocket<ClientState>` (60 uses in ws-router) | Bun WS | DO WebSocket (hibernation) |
| HTTP handler | `Bun.serve({ fetch })` in server.ts | Bun.serve calls it | DO `fetch` calls it |
| `KannaMcpEndpoint` | `Bun.serve` on a localhost port in kanna-mcp.ts | localhost port | DO route + token; runner proxies `localhost:N` to it |
| `AppConfig` | `shared/branding.ts` constants, `getDataRootDir(homedir())` | `~/.kanna` | per tenant |

`kanna-mcp.ts` already uses the MCP SDK's web-standard transport, so only
its listener moves. The CLI in the container still needs a URL it can
reach: the runner exposes a local port that forwards to the host.

`chat-window-route.ts`'s `Bun.gzipSync` becomes `CompressionStream`.

## 4. What goes around the services today

Measured on this branch (non-test files under `src/server`):

| Leak | Count | Where |
|---|---|---|
| `Bun.spawn` / `node:child_process` | 11 + 8 sites | process-utils (`runCommand`: the git/gh path for diff-store, github, worktree), cli-process (Cursor, Grok), codex-app-server, provider-auth, skills, project-icons, terminal-manager, local-http-servers, performance-log, nightly, cli-supervisor |
| `Bun.Terminal` | 13 | terminal-manager, provider-auth |
| direct `node:fs` | 17 files | event-store, transcript-payloads (sync byte-offset reads), read-models (`statSync`), paths, process-utils, share, png-thumbnail, provider-auth, instance-socket, kanna-display-tools, kanna-visualization-tool, harness-skills, diff-store, worktree-snapshot, project-icons |
| `homedir()` | 24 files | |
| `process.env` / `platform` | 24 files | |
| `Bun.serve` | 2 | server.ts, kanna-mcp.ts |
| `ServerWebSocket` | ws-router, ws-transport | |
| `Bun.file` | 11 | http-file-routes, provider-auth, … |

Some of these are deliberate, per the migration notes: `FileSystem.stat`
rounds mtimes, so a few modules keep `node:fs` `stat`. Those become methods
on the store or machine service (`statPrecise`) rather than direct imports.

## 5. Claude

Claude runs through `@anthropic-ai/claude-agent-sdk`'s `query()` in
`agent.ts`. Two routes off Bun, both already supported by the SDK:

1. **`spawnClaudeCodeProcess`** (`sdk.d.ts`: "to run in VMs/containers").
   Kanna supplies a `SpawnedProcess` built on the machine's
   `ChildProcessSpawner`. Smallest change in `agent.ts`. Risk: `sdk.mjs`
   imports `fs`, `child_process`, `os` and reads `~/.claude` itself. In a DO
   those are Workers' virtual `node:fs` (per request, not persistent) and a
   stub `child_process`. Spike whether `query()` with a custom spawner gets
   through without touching them.
2. **`@anthropic-ai/claude-agent-sdk/browser`** — `query()` over a
   WebSocket or SSE with no node imports, and it still takes `canUseTool`,
   `hooks` and `mcpServers` (so Kanna tools stay in-process in the host).
   Options like `cwd`, `model`, `resume`, `systemPrompt`, `settings` then
   become the CLI launch in the container. That splits today's options
   object into "launch spec" (runner side) and "session callbacks" (host
   side). Need to confirm what the container end of that socket must speak.

Either way, prepare by splitting the `query()` options in `agent.ts` into
those two halves now. It costs nothing locally and makes both routes a
layer swap.

## 6. Local vs. hosted, by module

| Group | Modules | Needs |
|---|---|---|
| Pure, portable now | orchestrator, events, schedules, chat-commands, attribution, handoff, provider-catalog, kanna-tool-*, codex-app-server-protocol, harness-instructions, visualization-*, background-tasks, port-tunnels | nothing |
| Kanna state | event-store, transcript-payloads, transcript-media, transcript-slim, read-models, app-settings, keybindings, usage-limits (cache file), llm-provider, uploads, share, cloud/identity, performance-log (file) | stores (§3.2) |
| Machine | diff-store, git, github*, worktree-*, project-icons, harness-skills, skills, discovery, provider-auth, claude-executable, http-file-routes, terminal-manager, local-http-servers, codex/cursor/grok adapters, quick-response, generate-* | Machine (§3.1) |
| Transport | server.ts, ws-router, ws-transport, chat-window-route, kanna-mcp | Host (§3.3) |
| Local product only | cli*, nightly, update-manager, restart, instance(-socket), mac-app, editor-detection, terminal-detection, external-open, machine-name, cloud tunnel, performance-log `ps` | stays on Bun; not loaded in a hosted build |

The last row matters: a hosted entry point composes a different set of
layers and simply never imports those modules. `server.ts`'s
`Layer.mergeAll(...)` becomes two composition roots sharing one list of
portable layers.

## 7. Phases

Each phase ships on its own with no behaviour change; `bun run check` and
`bun test` pass at each boundary. Phases 1–4 are useful even if nothing is
ever hosted: they make every IO edge fakeable in tests.

- [x] **1. Guardrail.** `src/server/platform/portability.test.ts` fails if
  a server module outside `platform/bun/` and the `kanna` process entry
  points imports an OS-bound module (`bun`, `node:fs`, `node:child_process`,
  `node:os`, `node:net`, `node:process`, `default-shell`, …), touches
  `Bun.*`, `process.*` or Bun's `import.meta.dir`, or imports the Bun
  bindings themselves (`effect/runtime`, `platform/bun`) outside the few
  composition roots it names.
- [x] **2. Processes and PTYs.** Kanna's own `ProcessSpawner` and
  `PtySpawner` (`platform/`), not Effect's `ChildProcessSpawner`: their Bun
  bindings are today's `Bun.spawn` / `Bun.Terminal` code moved verbatim, so
  kill semantics, exit codes and error messages didn't change. git, gh,
  Codex, Cursor, Grok, skills, provider logins and terminals all go through
  them. Claude's SDK still spawns `claude` itself (§5).
- [x] **3. `Machine` and `HostProcess`.** `Machine`: home, platform, env,
  hostname, `which`, the user's shell, `signalProcess`. `HostProcess`: the
  server's own pid, parent, memory and CPU. `AppConfig` (de-branding) is not
  done; `branding.ts` still names `~/.kanna`, but every caller passes the
  home directory in.
- [ ] **4. Split the file systems.** Until then a hosted binding can route
  one `FileSystem` by path (the data dir to DO storage, the rest to the
  runner). Transcript and payload reads now use async `FileSystem` effects;
  `retainTranscript(chatId)` loads and pins the cached headers for a scoped
  reader. Snapshot derivations stay synchronous in memory. Folder timestamps
  and the cloudflared existence check are async too; `FileSystemExtras.sync`
  has been removed. Introduce the `Machine` file-system tag and move machine
  modules onto it, then put state behind domain stores whose file layers
  keep today's on-disk layout.
- [~] **5. Host seams.** Done: `HttpHost` + `ClientSocket` (server.ts,
  ws-router, kanna-mcp); `startKannaServerEffect` needs only the platform
  services, with the built assets passed in (`assetDirs`), and
  `server-bun.ts` is the Bun composition root; the router, agent
  coordinator and Kanna tools take the platform from their caller. Not
  done: one `(Request) => Effect<Response>` handler a DO's `fetch` can
  call without `listen`; splitting Claude's `query()` options (§5).
- [ ] **6. Runner + RPC.** `kanna runner`: a small Bun entry that serves
  `FileSystem`, `ChildProcessSpawner`, `PtySpawner`, `MachineInfo` as an
  `effect/rpc` group over one WebSocket (streams for stdio and PTY output).
  A `RemoteMachine` layer implements the same services as an RPC client.
  **Prove it locally first**: run Kanna on Bun with `RemoteMachine` pointed
  at a runner on the same laptop. Every test of the machine modules can run
  against both layers.
- [ ] **7. Spikes, in parallel with 4–6.** (a) Claude via
  `spawnClaudeCodeProcess` vs. browser SDK in workerd. (b) Pi in a process
  or in the runner. (c) Bundle the portable layer set for workerd with
  `nodejs_compat` and see what fails to load (`node:path` and `node:crypto`
  are supported; `node:fs` is a virtual per-request FS; `child_process` is a
  stub).
- [ ] **8. DO host.** SQLite store layers, DO WebSocket `ClientSocket`,
  `fetch` entry, alarms for schedules and background tasks, runner
  connection management. This is the first phase that writes
  Cloudflare-specific code.

## 8. Things to decide

1. **One runner per what?** Per user, per project, per chat? The repo has
   to persist between turns. A warm container per project with a volume is
   the simplest model that matches today's "a project is a directory".
2. **Tenancy.** Today one server is one user. A DO per user keeps that true
   and avoids multi-tenant state inside the event store.
3. **Credentials.** Agent CLI logins live on the machine (`~/.claude`,
   `~/.codex`). Provider-auth's login flows already run on a PTY, so they
   work through `PtySpawner` unchanged; storing the resulting credentials in
   a persistent container volume is a deployment decision.
4. **Topology E** (hosted history, user's own laptop as the runner) falls
   out of phase 6 for free: the runner is the same program wherever it runs.
   That may be a better first hosted product than a managed container.
