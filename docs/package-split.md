# Kanna package split — plan

Status: proposed, not started. Written 2026-07-30.

Refactor Kanna from one app into a stack of independently viable packages plus a
thin product layer, in a single repo. **Kanna's behavior must not change.** The
test of success is that hosting the client on a Cloudflare Worker, moving chat
recordkeeping to a Durable Object, and running the harness in a sandbox becomes a
matter of swapping four injected implementations — with zero edits inside the
packages.

## Non-goals

- No product changes. No new features, no UI changes, no protocol changes beyond
  what a boundary mechanically requires.
- Not publishing the packages to npm initially. They are workspace packages; the
  `kanna-code` tarball stays a single installable CLI.
- Not building the Cloudflare deployment. This plan makes it possible, cheaply.
  Someone still has to write the drivers.

---

## 1. What the current code already tells us

Four measured facts drove every boundary below.

1. **`src/shared/types.ts` (2011 lines) is imported by 113 client files and 44
   server files.** It is the keystone, and it is four unrelated vocabularies
   glued together: the transcript/tool model, the provider catalog, session
   read-models, git snapshots, and Kanna's own settings/auth/update types.
2. **`src/server/diff-store.ts` (2580 lines) has zero references to `chatId`,
   `EventStore`, or `StoreState`.** The git client is already a standalone
   library wearing a server file's clothes. Cheapest, highest-confidence
   extraction — do it early to prove the model.
3. **`src/shared/` has no `node:` imports, and no client file imports from
   `src/server/`.** The isomorphic boundary is already enforced by convention;
   it just isn't packaged.
4. **`src/export-viewer/main.tsx` renders a full transcript from a JSON blob**
   using `ChatTranscriptViewport` + `processTranscriptMessages` +
   `TranscriptRenderOptionsProvider`, with no socket, no store, no server. The
   chat-UI library boundary is proven, not proposed.

Counter-facts — where the coupling actually is:

- **`src/shared/branding.ts` is imported in 28 files across every layer.** It
  hardcodes `~/.kanna`, the app name, and reads the version out of
  `package.json`. No package is independently viable while it imports Kanna's
  identity. De-branding is the single largest mechanical change here and it
  gates everything else.
- **`src/server/agent.ts` (2297 lines) interleaves the Claude SDK adapter with
  session bookkeeping** through the streaming loop (~60 `this.store.*` calls).
  This is the only genuinely hard extraction. Codex, Cursor, and Pi already
  return clean `HarnessTurn`s.
- **`src/server/ws-router.ts` (1619 lines) types every socket as Bun's
  `ServerWebSocket<ClientState>`,** and `SnapshotBroadcastFilter` (line 89) is a
  struct of named per-topic booleans (`includeSidebar`, …) that hardcodes the
  topic set into the broadcaster.

---

## 2. The principle

**A package boundary is a promise that the two sides can version
independently.** Where two things must change together, a boundary is pure
cost — indirection, release choreography, type gymnastics — and buys nothing.

Draw boundaries only along axes that vary independently:

| Axis | Varies when… | Package |
|---|---|---|
| Which agent runs | claude/codex/cursor/pi, next harness | `harness` |
| Where chat state lives | JSONL file → Durable Object → Postgres | `session` |
| Where the repo lives | local FS → sandbox → remote | `git` |
| What the product looks like | Kanna → someone else's UI | `chat-ui` |
| Where it runs | Bun local → Worker + DO + Sandbox | `server` / app |

The vocabulary those share — transcript entries, normalized tool calls, the wire
schema — can't live in any of them, so it becomes the bottom package.

**Six packages plus the app.**

---

## 3. The packages

### `@kanna/protocol` — the language everyone speaks

*ELI5: nouns ("a tool call looks like this"), verbs ("send a message", "commit
these files"), and the cables that carry them. The only package that runs in the
browser tab and on the server simultaneously — both sides must agree byte for
byte.*

Isomorphic, zero runtime dependencies. ~3.6k lines.

Contents:
- Domain model: `TranscriptEntry` union, `NormalizedToolCall` + normalization +
  hydration, provider/model catalog data, context-window math, message preview.
- Harness contract: `HarnessEvent`, `HarnessTurn`, `HarnessToolRequest`.
- Wire schema: core topics (`chat`, `sidebar`, `project-git`, `terminal`),
  their commands and snapshots, envelope types and guards.
- Transport mechanics: subscription registry, signature-based push dedupe, ack
  correlation, reconnect/heartbeat/backoff.

Moves here:

| From | Notes |
|---|---|
| `src/shared/types.ts` | minus the app-only block (~327 lines, see below) |
| `src/shared/tools.ts` | |
| `src/shared/{json,message-preview,provider-preferences,assert}.ts` | |
| `src/shared/protocol.ts` | |
| `src/server/harness-types.ts` | |
| `src/client/lib/parseTranscript.ts` | moves *down* out of the client — pure hydration the export path needs too |
| `src/client/app/derived.ts` | |
| `src/client/app/socket.ts` | the client end of the transport |
| `src/server/ws-router.ts` — broadcast/subscription half (~300 of 1619 lines) | the server end |

**Why schema and mechanics are one package, not three.** Adding a single command
today touches the command union, the snapshot union, the handler, and the client
method. Those are one edit. Three packages would create a version matrix in which
a client and server can disagree about the wire — the exact failure this design
exists to prevent. You can never usefully run these at different versions.

**Why the snapshot types live here and not in `session`/`git`.** `ChatSnapshot`,
`SidebarData`, and `ChatDiffSnapshot` are wire types, not implementation types —
which is why they already sit in `shared/types.ts` today. `session` doesn't own
`ChatSnapshot`; it *derives* one. Putting them here means `session` and `git`
depend on the contract they satisfy and the arrow never points back.

The one real refactor: `SnapshotBroadcastFilter` becomes a topic predicate
instead of a struct of named booleans.

### `@kanna/harness` — the camera crew

*ELI5: knows how to point four different cameras at your repo and produce one
uniform tape. Each camera has its own weird plug; this hides that.*

Node/Bun. Depends on `protocol` only.

Contents: the four adapters behind one `HarnessTurn`; skill discovery; provider
CLI auth + install; usage-limit parsing; attribution; handoff context; the
small-model utility calls (titles, commit messages, quick responses).

Moves here: `agent.ts`'s Claude half (~900 lines: `normalizeClaudeStreamMessage`,
the `query()` loop, `claudeToolset`), `codex-app-server.ts`,
`codex-app-server-protocol.ts`, `cursor-cli.ts`, `pi-agent.ts`,
`harness-skills.ts`, `provider-auth.ts`, `usage-limits.ts`, `attribution.ts`,
`handoff.ts`, `session-artifacts.ts`, `provider-catalog.ts`,
`llm-provider.ts`, `quick-response.ts`, `generate-title.ts`,
`generate-commit-message.ts`.

**Harness stays a pure producer.** It emits `HarnessEvent`s and never writes
session state. That is what keeps it usable standalone:

```ts
for await (const e of runTurn({ provider: "codex", cwd, prompt })) { … }
```

**Why the LLM utilities live here rather than in their own package** (733 lines
across 4 files): they only needed separating to stop `git` depending on `harness`
for commit messages. Dependency inversion is cheaper than a package — see below.

### `@kanna/session` — the tape library

*ELI5: every chat, every turn, every message, filed and retrievable. Doesn't care
whether the tapes are on a shelf or in a database — that drawer is swappable.*

Storage-agnostic. Depends on `protocol`.

Contents: event-sourced chats/projects/turns/queue/read-state, transcript append
+ compaction, the read-model derivations, and the turn coordinator that binds a
`HarnessTurn` to store writes.

Moves here: `event-store.ts`, `events.ts`, `read-models.ts`, `transcript.ts`,
`touched-file-backfill.ts`, and `AgentCoordinator`'s store-writing half (turn
lifecycle, queue, steer, fork, cancel).

**All filesystem access goes behind a `StorageDriver`.** `JsonlFileDriver` is the
default and preserves today's `~/.kanna/data` layout exactly. This is the seam
that makes the Durable Object swap a config change.

### `@kanna/git` — the editing bench

*ELI5: diffs, branches, commits, merges, pushes, GitHub. Completely uninterested
in chats or AI — you could build a plain git GUI on it.*

Process-agnostic. Depends on `protocol`.

Moves here: `diff-store.ts`, `github.ts`, `worktree-snapshot.ts`,
`shared/git-url.ts`.

Three adjustments:
- `Bun.spawn` goes behind a `CommandRunner` so it can exec into a sandbox.
- `projectId` becomes an opaque `repoKey` (it's already just a cache key).
- `generateCommitMessage` takes an injected
  `CommitMessageWriter = (diff, ctx) => Promise<string>` instead of importing an
  LLM client. The app wires harness's implementation in. Standalone users
  implement it in five lines or do without.

**Not moving here:** `worktree-probe.ts`. That decides *which* repos to re-scan
based on chat activity — app scheduling policy, not git. It imports `StoreState`
and stays with the app.

### `@kanna/chat-ui` — the television set

*ELI5: renders a transcript and takes input. Pure display — hand it data, it
draws; it never fetches anything itself.*

React. Depends on `protocol`. No socket, no global store, no branding —
props and context only.

Moves here: `components/messages/*`, `components/ui/*` (as
`@kanna/chat-ui/primitives`), `KannaTranscript.tsx`,
`ChatPage/ChatTranscriptViewport.tsx`, `ChatInput.tsx`, `widgets/GitWidgets.tsx`,
`chat-ui/git/*`, `ContextWindowMeter.tsx`, `TranscriptMinimap.tsx`,
`lib/thread-sections.ts`, `lib/contextWindow.ts`, `lib/formatters.ts`.

Two leaks to invert: `components/messages/` currently imports
`chat-ui/ChatPreferenceControls` and `ChatPage/toolPayloadStore`.

`src/export-viewer` becomes the package's own example/fixture — it already
proves the boundary works.

### `@kanna/server` — the studio switchboard

*ELI5: accepts connections, checks credentials, routes each request to the crew /
library / bench, pushes updates back out. Plumbing, not product.*

Contents: HTTP routes (`/ws`, `/health`, `/auth/*`, `/api/*`, static), auth,
uploads, terminals, and the wiring that composes harness + session + git behind
the protocol handlers.

Moves here: `server.ts`, `auth.ts`, `uploads.ts`, `terminal-manager.ts`,
`ws-router.ts`'s handler half, `local-http-servers.ts`, `external-open.ts`,
`paths.ts`.

**The rule that keeps this boundary honest:** `@kanna/server` may not import
`kanna`, and may not know the app's name, version, or data directory. If a change
wants to violate that, it belongs in the app. If you find yourself adding a third
exception, delete the boundary and fold server into the app — the Cloudflare
story survives, it just becomes "reimplement ~800 lines of wiring against the
same five packages."

**Why `terminal-manager.ts` lives here rather than its own package** (414
lines): a PTY multiplexer isn't a product anyone adopts on its own, and it's the
component most likely replaced wholesale in a sandbox deployment. Its wire types
are in `protocol`; the implementation is a host concern.

### `kanna` — the channel

Everything that makes it Kanna: CLI, updater, nightly, instance lock, cloud
tunnel + pairing, onboarding, setup wizard, settings, keybindings, analytics,
machine name, share/export, command palette, sidebar composition,
`worktree-probe` scheduling, project discovery, the React app shell.

Stays: `cli.ts`, `cli-runtime.ts`, `cli-supervisor.ts`, `restart.ts`,
`nightly.ts`, `instance.ts`, `update-manager.ts`, `machine-name.ts`,
`analytics.ts`, `app-settings.ts`, `keybindings.ts`, `discovery.ts`,
`worktree-probe.ts`, `skills.ts`, `share.ts`, `standalone-export.ts`,
`project-quick-actions.ts`, `cloud/*`, and the client's `app/`, `settings/`,
`auth/`, `cloud/`, `command-palette/`, `KannaSidebar.tsx`, stores, hooks.

---

## 4. App-owned protocol topics

`protocol` owns the core topics: `chat`, `sidebar`, `project-git`, `terminal`.

Kanna's own topics — `app-settings`, `update`, `keybindings`, `provider-auth`,
`usage-limits`, `llm-provider`, `skills` — are roughly 327 lines of
`shared/types.ts` (lines 1064–1390) that stay in the app and get composed into
the union it hands the broker.

This works because the broker is a registry that never switches on topic type.
Only handlers switch, and handlers live in `server`/`kanna`. It keeps
"onboarding/settings stay Kanna-only" intact without needing a package for it.

---

## 5. Repo layout

```
kanna/
├── package.json            # workspace root
├── packages/
│   ├── protocol/
│   ├── harness/
│   ├── session/
│   ├── git/
│   ├── chat-ui/
│   └── server/
└── apps/
    └── kanna/              # publishes as kanna-code
        ├── bin/kanna
        ├── src/server/
        ├── src/client/
        └── src/export-viewer/
```

Bun workspaces. Packages are `@kanna/*`, private, TypeScript source consumed
directly (no per-package build step during development).

---

## 6. The four seams

Everything in section 8 reduces to these.

| Seam | Owner | Local (today) | Worker / DO / Sandbox |
|---|---|---|---|
| `StorageDriver` | `session` | JSONL + compaction in `~/.kanna/data` | DO SQLite |
| `Socket` | `protocol` | Bun `ServerWebSocket` | DO WebSocket (hibernation) |
| `CommandRunner` | `git`, `harness` | `Bun.spawn` | sandbox exec RPC |
| `AppConfig` | all | `~/.kanna`, `kanna-code@x.y.z` | injected per deployment |

`AppConfig` replaces `src/shared/branding.ts`. It is constructor-injected, never
imported. This is phase 1 and it gates everything.

---

## 7. Where each package can physically run

Capability, not preference — this determines the hosting options.

| Package | Needs | Browser | CF Worker | Durable Object | Container/VM | Node/Bun local |
|---|---|---|---|---|---|---|
| `protocol` | nothing | ✅ | ✅ | ✅ | ✅ | ✅ |
| `chat-ui` | a DOM | ✅ | ❌ | ❌ | ❌ | ❌ |
| `session` | storage driver | ~ | ~ | ✅ SQLite | ✅ files | ✅ files |
| `git` | run `git` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `harness` | spawn CLIs | ❌ | ❌ | ❌ | ✅ | ✅ |
| `server` | HTTP + WS | ❌ | ✅ | ✅ | ✅ | ✅ |
| `kanna` CLI | a machine | ❌ | ❌ | ❌ | ✅ | ✅ |

The hard line: **`harness` and `git` shell out to real binaries.** No refactor
puts them in a Worker. Any serverless topology needs a container somewhere.

---

## 8. Hosting topologies

### A. Local all-in-one — what ships today

```
   ┌── your laptop ──────────────────────────────────┐
   │  browser tab            bun process             │
   │  ┌───────────┐   WS    ┌──────────────────────┐ │
   │  │ chat-ui   │◄───────►│ server               │ │
   │  │ protocol  │         │ session → ~/.kanna   │ │
   │  └───────────┘         │ harness → spawns CLI │ │
   │                        │ git     → spawns git │ │
   │                        │ protocol             │ │
   │                        └──────────────────────┘ │
   └─────────────────────────────────────────────────┘
```

Zero seams swapped. Must keep working identically — it is the product.
Electron/Tauri is the same picture with the tab replaced by an app window.

### B. Local + tunnel — Kanna Cloud today

```
   phone / other laptop          hosted proxy            your laptop
   ┌───────────┐              ┌──────────────┐        ┌──────────────┐
   │ chat-ui   │──── HTTP ───►│ control plane│───────►│ server       │
   │ protocol  │              │ (kanna-site) │        │ session      │
   │           │═════ WS ═════════════════════════════►│ harness/git │
   └───────────┘   (direct to tunnel; the proxy       └──────────────┘
                    never sees WS frames)
```

Still zero seams swapped. A reachability trick, not an architecture change.

### C. Fully hosted — Worker + Durable Object + Sandbox

```
    browser                Cloudflare edge                   compute
 ┌────────────┐      ┌─────────────────────────┐      ┌──────────────────┐
 │ chat-ui    │      │  Worker                 │      │  Container /     │
 │ protocol   │◄─WS─►│  ├ server (handlers)    │─RPC─►│  Sandbox         │
 │            │      │  ├ protocol             │      │  ├ harness       │
 └────────────┘      │  └ static assets        │      │  ├ git           │
                     │                         │      │  └ protocol      │
                     │  Durable Object         │      │                  │
                     │  ├ session              │◄─────┤  repo checkout   │
                     │  ├ protocol             │      └──────────────────┘
                     │  └ SQLite (transcripts) │
                     └─────────────────────────┘
```

Seams swapped: all four.

**Honest scope.** The refactor makes this possible *without touching the six
packages*, which is the win. It is not free: you still write the DO storage
driver (~300 lines), the sandbox exec runner (~200), a real multi-tenant auth
model, and you must answer "where does the repo live between turns" — sandbox
filesystems are ephemeral, so either keep a warm sandbox per chat or re-clone.
Weeks, not days. None of that work reaches into `harness`, `session`, or `git`.

### D. Team server — VPS or Docker

```
   many browsers          one box (docker / EC2 / fly.io)
   ┌───────────┐         ┌─────────────────────────────────┐
   │ chat-ui   │◄──WS───►│ server                          │
   │ protocol  │         │ session → /data (volume)        │
   └───────────┘         │ harness → spawns CLIs           │
   ┌───────────┐         │ git     → /workspaces/*         │
   │ chat-ui   │◄──WS───►│ protocol                        │
   └───────────┘         └─────────────────────────────────┘
```

Topology A with a different `AppConfig` data dir. The new work is multi-tenancy
— today one machine means one user. App-level concern, not a package one.

### E. Hybrid — hosted brain, your compute

```
   browser              hosted (Worker + DO)          your machine
 ┌───────────┐        ┌────────────────────┐       ┌─────────────────┐
 │ chat-ui   │◄─WS───►│ server (routing)   │◄─WS──►│ agent daemon    │
 │ protocol  │        │ session (all chats)│       │ ├ harness       │
 └───────────┘        │ protocol           │       │ ├ git           │
                      └────────────────────┘       │ └ protocol      │
                                                   │ your repos      │
   history + sidebar in the cloud;                 │ your API keys   │
   code + credentials never leave your box         └─────────────────┘
```

Works because `session` never touches a repo and `harness`/`git` never touch
chat state — the split already exists in the code. Your laptop can be closed and
your history is still there. Probably the most commercially interesting shape,
and the one where the cloud earns its keep without taking on the liability of
running other people's code.

### F. Headless — no UI at all

```
   CI job / Slack bot / cron
   ┌──────────────────────────────┐
   │ harness  ← run a turn        │
   │ git      ← branch, commit, PR│
   │ session  ← optional record   │
   │ protocol                     │
   └──────────────────────────────┘
        no server, no chat-ui, no kanna
```

The acid test for whether the packages are really independent. If `harness`
needs `server` to boot, the boundary was fake.

### What actually differs

| | A local | B tunnel | C hosted | D team box | E hybrid | F headless |
|---|---|---|---|---|---|---|
| `StorageDriver` | files | files | **DO SQLite** | files | **DO SQLite** | files / none |
| `Socket` | Bun WS | Bun WS | **DO WS** | Bun WS | Bun WS ×2 | — |
| `CommandRunner` | spawn | spawn | **sandbox RPC** | spawn | spawn | spawn |
| `AppConfig` | `~/.kanna` | `~/.kanna` | **per-tenant** | `/data` | mixed | caller's |
| **Packages changed** | — | — | **none** | — | **none** | **none** |

That bottom row is the entire argument for this refactor.

---

## 9. System diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  kanna  (the product — unchanged)                                        │
│  CLI · updater · cloud tunnel + pair · onboarding · settings ·           │
│  keybindings · analytics · command palette · sidebar · share/export      │
│  worktree-probe scheduling · project discovery                          │
└──────┬────────────────────────────────────────────────────┬──────────────┘
       │                                                    │
       ▼                                                    ▼
┌─────────────────────┐                        ┌─────────────────────────────┐
│   @kanna/chat-ui    │                        │      @kanna/server          │
│ transcript·composer │                        │ HTTP·auth·static·terminals  │
│ tools·diffs·git panel│                       │ handlers · wiring           │
│ primitives (subpath)│                        └──┬─────────┬─────────┬──────┘
└──────────┬──────────┘                           │         │         │
           │                    ┌─────────────────┘         │         └────────┐
           │                    ▼                           ▼                  ▼
           │        ┌────────────────────┐   ┌──────────────────┐  ┌───────────────────┐
           │        │    @kanna/git      │   │  @kanna/session  │  │  @kanna/harness   │
           │        │ status·diff·branch │   │ chats·turns·queue│  │ claude│codex│     │
           │        │ commit·merge·sync  │   │ transcripts      │  │ cursor│pi         │
           │        │ GitHub             │   │ read-models      │  │ skills·auth·usage │
           │        └─────────┬──────────┘   │ turn coordinator │  │ llm utilities     │
           │                  │              └────────┬─────────┘  └─────────┬─────────┘
           │       seam: CommandRunner    seam: StorageDriver    seam: CommandRunner
           │       (spawn │ sandbox)      (JSONL │ DO SQLite)    (spawn │ sandbox)
           │                  │                    │                      │
           └──────────────────┴────────────────────┴──────────────────────┘
                                        │
                                        ▼
       ┌───────────────────────────────────────────────────────────────┐
       │                     @kanna/protocol                            │
       │  TranscriptEntry · tool normalize/hydrate · provider catalog  │
       │  HarnessEvent/HarnessTurn · topics · commands · snapshots     │
       │  envelopes · subscription broker · reconnecting client        │
       │  ISOMORPHIC · ZERO RUNTIME DEPS · the one thing all sides share│
       └───────────────────────────────────────────────────────────────┘
```

---

## 10. Migration phases

Each phase is independently shippable with zero behavior change. `bun run check`
and `bun test` must pass at every phase boundary.

- [ ] **Phase 0 — workspace skeleton.**
  Bun workspaces, `packages/*` + `apps/kanna`, tsconfig path aliases. No files
  move. Verifies the toolchain (Vite, Bun test, tsc) before anything is at risk.

- [ ] **Phase 1 — de-brand.**
  `src/shared/branding.ts` → an injected `AppConfig` (`appName`, `cliCommand`,
  `packageName`, `version`, `dataRoot`, `logPrefix`). 28 files. No package is
  viable until this lands, so it goes first. Pure mechanical change; highest
  ratio of unlock to risk.

- [ ] **Phase 2 — `@kanna/protocol`.**
  Move `shared/*`, `harness-types.ts`, `parseTranscript.ts`, `derived.ts`,
  `socket.ts`, and the broadcast/subscription half of `ws-router.ts`. Leave
  Kanna's app-only topics (types.ts:1064–1390) in the app and compose them into
  the union. Generalize `SnapshotBroadcastFilter` to a topic predicate. Abstract
  `ServerWebSocket` to a minimal `Socket` interface.

- [ ] **Phase 3 — `@kanna/git`.**
  Near-mechanical (zero chat coupling, already verified). Introduce
  `CommandRunner`, rename `projectId` → `repoKey`, invert
  `generateCommitMessage` to an injected `CommitMessageWriter`. Do this early:
  it is the cheapest real proof that the model holds.

- [ ] **Phase 4 — `@kanna/session`.**
  Move `event-store.ts`, `events.ts`, `read-models.ts`, `transcript.ts`,
  `touched-file-backfill.ts`. Introduce `StorageDriver` with `JsonlFileDriver`
  preserving today's on-disk layout byte for byte. Migration safety matters
  most here — existing `~/.kanna/data` must load unchanged.

- [ ] **Phase 5 — `@kanna/harness`.**
  Move the three clean adapters, skills, provider auth, usage, attribution,
  handoff, LLM utilities. Then the hard part: split `agent.ts` into a Claude
  adapter that only emits `HarnessEvent`s and a turn coordinator (→ `session`)
  that does the ~60 store writes. Budget the most time here.

- [ ] **Phase 6 — `@kanna/chat-ui`.**
  Move `components/messages/*`, `components/ui/*`, the transcript viewport,
  composer, git panel. Invert the two `messages/` → app leaks. Re-point
  `src/export-viewer` at the package as its example.

- [ ] **Phase 7 — `@kanna/server`.**
  Whatever is left that isn't the product: HTTP routes, auth, uploads,
  terminals, handler wiring. Enforce the "may not import `kanna`" rule with a
  lint rule or a test.

---

## 11. Testing

Tests already sit next to their modules, so they move with the code. Rough split
of today's 116 test files:

| Package | ≈ files | Notable |
|---|---|---|
| `protocol` | 12 | `types.test.ts`, `tools.test.ts`, `parseTranscript.test.ts`, `socket.test.ts` |
| `harness` | 22 | `agent.test.ts` (2483 lines) splits: adapter tests here, coordinator tests → session |
| `session` | 16 | `event-store.test.ts`, `read-models.test.ts` |
| `git` | 12 | `diff-store.test.ts`, `github.test.ts` |
| `chat-ui` | 14 | `KannaTranscript.test.tsx`, message component tests |
| `server` | 8 | terminal, auth, routes |
| `kanna` (app) | 32 | cloud, cli-runtime, update, settings, integration |

`ws-router.test.ts` (2322 lines) stays with the app as the end-to-end contract
test — this is the "kanna tests it all put together" file.

Each package gets its own `bun test` target; the root runs all of them.

---

## 12. Risks and hazards

**Publishing.** Today `package.json#files` ships raw `src/server/` and Bun
executes the TypeScript directly. That stops working the moment imports cross
workspace boundaries. The app build must bundle workspace deps into `dist/`
(`bun build --target=bun`) before publish. Decide this in phase 0, not phase 7 —
it changes what `prepublishOnly` looks like.

**`agent.ts`.** The only extraction that is genuinely hard. The Claude SDK
adapter and the store writes interleave through the streaming loop. Everything
else in this plan is moving files and adjusting imports; this one needs care and
its 2483 lines of tests as a harness.

**On-disk compatibility.** Phase 4 must not change the `~/.kanna/data` layout.
Existing users' chats have to load. Snapshot compaction and the JSONL format are
load-bearing.

**Boundary rot at `server` / `kanna`.** The loosest seam. Enforce mechanically
(lint rule or test asserting no `kanna` import from `@kanna/server`) or it will
dissolve within a month.

**Scope creep.** Every phase will surface things worth improving. Don't. The
value of "zero behavior change" is that any regression is unambiguously a
refactor bug.

---

## 13. Open decisions

1. **Publish the packages to npm, or keep them private workspace deps?**
   Recommendation: private initially. Publishing commits you to semver on six
   surfaces before they've settled. Revisit after the split lands.

2. **Does `@kanna/server` survive as its own package, or fold into the app?**
   Keep it, police it (section 3). If the "no `kanna` import" rule needs a third
   exception, fold it — the Cloudflare story survives either way.

3. **Which hosting topology are we actually aiming at?**
   The refactor is worth doing for A alone (it's a cleanup). But if the target is
   E (hybrid — hosted history, local execution), that shapes `session`'s driver
   interface, since it implies session is remote while harness is local. Worth
   deciding before phase 4.
