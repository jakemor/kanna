# Refactor TODO

Tracking list for the refactors proposed on 2026-04-21.

Use `[x]` when an item is complete. Add any follow-up notes directly under the item when work starts.

## Pending

- [x] Tunnel/share flag cleanup
  Commits: `77e934f`, `d0eef25`
  Scope: `src/shared/share.ts`, `src/server/cli-runtime.ts`, `src/server/share.ts`
  Goals:
  - Merge `awaitQuickTunnelUrl` and `awaitNamedTunnelReady` into a single `awaitTunnelReady(...)` helper.
  - Extract shared host/remote incompatibility checks into one `assertNoHostOverride(...)` guard used by `--share` and `--cloudflared`.
  - Remove duplicate `isTokenShareMode` branching in `startShareTunnel`.
  Expected impact: less duplicated tunnel lifecycle and CLI parsing logic; no behavior change intended.
  Status: completed on 2026-04-21.

- [x] Sidebar project order persistence simplification
  Commit: `1167a18`
  Scope: `src/server/events.ts`, `src/server/event-store.ts`, `src/server/read-models.ts`, snapshot/compaction plumbing
  Goals:
  - Replace `sidebar_project_order_set` event-sourcing with a small dedicated preference file such as `sidebar-order.json`.
  - Remove sidebar order from replay, `StoreState`, and compaction snapshot handling.
  - Keep restart/load behavior aligned with other preference storage patterns such as keybindings and LLM provider config.
  Expected impact: less event plumbing and lower blast radius for preference corruption.
  Status: completed on 2026-04-21.

- [x] Model ID normalization consolidation
  Commit: `db77356`
  Scope: `src/shared/types.ts`, `src/client/stores/chatPreferencesStore.ts`, related server call sites
  Goals:
  - Derive Claude model normalization from the shared `PROVIDERS` catalog instead of a separate switch mapping.
  - Move Codex model normalization into shared code alongside Claude normalization.
  - Replace `isClaudeOpusModelId` string-prefix logic with declarative model metadata if practical.
  Expected impact: one source of truth for model normalization and capability checks.
  Status: completed on 2026-04-21.

- [x] WS router command handler extraction
  Status: completed on 2026-07-18 — `handleChatGitCommand` collapses 14 git cases; skills subsystem extracted to `skills.ts`; broadcast semantics are explicit per command (no fallthrough broadcast).
  Scope: `src/server/ws-router.ts`
  Goals:
  - Extract the repeated “resolve project, call diff store, ack, maybe broadcast” flow into a helper.
  - Collapse the repeated git-related command cases onto that helper.
  - Make broadcast semantics explicit and consistent (`return` vs `break`).
  Expected impact: smaller router, lower risk of inconsistent broadcast behavior.

- [x] Shared profiling/logging helper extraction
  Status: resolved on 2026-07-18 by removing the send-to-starting profiling scaffolding entirely (client and server) rather than consolidating it.
  Scope: `src/server/event-store.ts`, `src/server/ws-router.ts`
  Goals:
  - Move duplicated `KANNA_PROFILE_SEND_TO_STARTING` env-var checks and logging formatting into a shared profiling module.
  - Let call sites pass per-event details such as `traceId` and `startedAt`.
  Expected impact: one profiling format and one implementation path.

- [ ] Tool call type-system registry refactor
  Progress 2026-07-18: `HydratedToolCall` and the 15 per-kind aliases are now derived from `NormalizedToolCall` via `HydratedToolCallOf<K>`; the remaining work is deriving `NormalizedToolCall` itself from a registry.
  Commits: `3f50f10`, `f997856`
  Scope: `src/shared/types.ts`, plus any affected rendering/type consumers
  Goals:
  - Replace the parallel tool-call type hierarchies with a registry/map-driven type definition.
  - Derive `ToolCallKind`, `NormalizedToolCall`, and `HydratedToolCall` from that registry.
  - Reduce the number of places touched when adding a new tool call kind.
  Expected impact: major type boilerplate reduction; moderate refactor risk.

- [x] chatPreferencesStore normalization reduction
  Status: completed on 2026-07-18 — generic `PROVIDER_NORMALIZERS` record replaces the per-provider clone/normalize/compare copies (730 → 484 lines, tests unchanged). Follow-up also completed 2026-07-18: normalizers and the providerDefaults deep-merge moved to `src/shared/provider-preferences.ts`, shared by `app-settings.ts` (server), `chatPreferencesStore.ts`, and `appSettingsStore.ts` — the server-side duplicates are gone.
  Commit: `db77356`
  Scope: `src/client/stores/chatPreferencesStore.ts`
  Goals:
  - Replace broad always-on legacy normalization with a one-time migration toward the current schema.
  - Remove old persisted-state branches once migration guarantees the current shape.
  - Consolidate provider preference normalization paths where possible.
  Expected impact: substantially smaller store logic with clearer current-state handling.
