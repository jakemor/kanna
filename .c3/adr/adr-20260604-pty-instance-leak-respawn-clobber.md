---
id: adr-20260604-pty-instance-leak-respawn-clobber
c3-seal: 754218fd9463aa15da3a90f90b923227503dcaa05d61aed016c5552de2bd53c3
title: pty-instance-leak-respawn-clobber
type: adr
goal: 'Stop the claude-pty driver from leaking a live PTY child that has become invisible to both the in-memory `PtyInstanceRegistry` (UI "PTY instances" panel) and the on-disk `ClaudePtyRegistry` (crash-reap list). Two concrete defects are fixed: (1) when a chat re-spawns its claude session (each `--resume <sessionId>` turn/wake/rotation reuses the same `chatId` and `sessionId`), the OLD handle''s deferred `cleanupResources()` clobbers the NEW handle''s registry entries because both registries key on the shared `chatId`/`sessionId`; (2) `killPgroup(pid)` reaps via `process.kill(-pid)`, which silently no-ops when the PTY child is not its own process-group leader (under PM2 the child inherits the server''s pgid) — and would SIGKILL the entire kanna app if the pgid ever matched. After this change a stale handle never overwrites a live handle''s registry state, and reap kills the actual process subtree by pid.'
status: implemented
date: "2026-06-04"
---

## Goal

Stop the claude-pty driver from leaking a live PTY child that has become invisible to both the in-memory `PtyInstanceRegistry` (UI "PTY instances" panel) and the on-disk `ClaudePtyRegistry` (crash-reap list). Two concrete defects are fixed: (1) when a chat re-spawns its claude session (each `--resume <sessionId>` turn/wake/rotation reuses the same `chatId` and `sessionId`), the OLD handle's deferred `cleanupResources()` clobbers the NEW handle's registry entries because both registries key on the shared `chatId`/`sessionId`; (2) `killPgroup(pid)` reaps via `process.kill(-pid)`, which silently no-ops when the PTY child is not its own process-group leader (under PM2 the child inherits the server's pgid) — and would SIGKILL the entire kanna app if the pgid ever matched. After this change a stale handle never overwrites a live handle's registry state, and reap kills the actual process subtree by pid.

## Context

Observed in session `5f78aa43-3e2e-416a-8e75-608d4e41c30c` (a Workflow run with 19 `schedule_wakeup` re-entries + OAuth rotations). The chat re-spawned its claude PTY six times for the same session `1f75b42a` (pids 30405→34743→36078→37288→38830→41506). Server log proves the race: `pty spawned pid 41506` (94715, registers) precedes `pty.exited resolved pid 38830 → drainTerminate → cleanupResources` (94745) for the OLD handle of the SAME sessionId. The old handle's `upsert(chatId,{phase:"exited"})` (in-memory, keyed by chatId) marked the live chat exited → pruned after the 60 s exited-TTL → UI showed 0; its `unregister(sessionId)` (on-disk, keyed by sessionId) deleted the live pid's reap entry → orphan invisible. `41506` itself never closed (blocked mid-turn on never-returning `until … sleep 30` Bash loops, so the idle reaper never fired). Separately, `ps` confirmed `pid 41506` had `PGID 51937` (the shared PM2/server group, 11 members) — NOT its own leader — so process group `41506` was empty and `kill(-41506)` was a no-op. `closeClaudeSession` (c3-210, agent.ts) tears the old session down fire-and-forget and immediately spawns the replacement, which is what opens the overlap window. Affected topology is entirely within c3-225 (`driver.ts`, `pty-instance-registry.ts`, `pid-registry.adapter.ts`, `pty-process.adapter.ts`); the orphan-reap and live-status surfaces are owned here.

## Decision

Make registry teardown identity-scoped to the handle that owns the entry, and make reap kill by process subtree rather than by group:

1. **On-disk `ClaudePtyRegistry` keyed by `pid`, not `sessionId`.** `register` dedupes on `pid`; `unregister(pid)` removes only the matching pid. `--resume` makes `sessionId` non-unique across concurrent re-spawns, so pid is the only stable identity. The driver passes `pty.pid` to `unregister`.
2. **In-memory `PtyInstanceRegistry` guarded by pid on teardown.** Add `markExitedIfCurrent(chatId, pid, patch)`: only apply the `phase:"exited"` patch when the live entry's `pid` still equals the closing handle's pid. A stale handle whose pid was already overwritten by the replacement spawn is a no-op.
3. **Reap by subtree, never by group.** Replace `killPgroup(pid)`'s blind `process.kill(-pid)` with a descendant-walk kill (collect the pid + all descendants via `ps`, SIGKILL leaves-first). This reaps the claude child AND its detached `nohup` shell loops, never no-ops on non-leader children, and can never signal the server's own group.

This is the right fit: it keeps the registries as thin read-models (no lifecycle redesign), fixes the exact clobber and the exact mis-targeted kill, and the subtree walk reuses the same `ps` primitive `pty-memory-sampler.adapter.ts` already shells, so it stays inside the `.adapter.ts` IO seal.

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-225 | component | Owns the PTY transport, both registries, and the reap path being changed | Review Contract "Live-status registry upserts" surface + Change Safety; add reap/teardown identity guard |
| c3-210 | component | closeClaudeSession re-spawn-without-await opens the overlap window; consumes registry state | Review-only: no signature change required, confirm fire-and-forget close stays compatible |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-colocated-bun-test | New behavior (pid-keyed registry, guarded teardown, subtree reap) needs tests beside each changed source | comply |
| ref-provider-adapter | Changes are internal to the Claude PTY adapter; HarnessEvent stream + prompt surfaces unchanged | comply |
| ref-event-sourcing | Registries are derived read-models, not the event log; no change to log-before-broadcast | review |
| ref-tool-hydration | Cited by c3-210, listed in Affected Topology as review-only. This leak fix touches neither tool hydration nor the canUseTool/MCP-tool surface it governs | N.A - tool hydration untouched; c3-210 is review-only, no edits to its tool surfaces |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-colocated-bun-test | Each touched file (pid-registry.adapter.ts, pty-instance-registry.ts, driver.ts, pty-process.adapter.ts) has a colocated *.test.ts that must cover the new paths | comply |
| rule-strong-typing | New API (unregister(pid:number), markExitedIfCurrent, descendant-kill helper) must use named types, no any at the boundary | comply |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| on-disk registry | ClaudePtyRegistry: dedupe register by pid; change unregister(sessionId) → unregister(pid:number); reap unchanged | src/server/claude-pty/pid-registry.adapter.ts |
| reap kill | Replace killPgroup body with subtree-collect-and-SIGKILL (pid + descendants via ps); export killProcessTree; reapStale + agent.ts killPtyInstance call it | src/server/claude-pty/pid-registry.adapter.ts, src/server/agent.ts |
| in-memory registry | Add markExitedIfCurrent(chatId, pid, patch) guarded upsert | src/server/claude-pty/pty-instance-registry.ts |
| driver teardown | cleanupResources uses markExitedIfCurrent(chatId, pty.pid, …) and unregister(pty.pid); guard when pty unassigned (early spawn failure) | src/server/claude-pty/driver.ts |
| tests | pid-keyed register/unregister + clobber-race; markExitedIfCurrent stale-pid no-op; subtree kill collects descendants; driver teardown does not clobber a newer pid | src/server/claude-pty/pid-registry.test.ts, pty-instance-registry.test.ts, driver.test.ts |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| c3-225 Contract | Update "Live-status registry upserts" row to note teardown is pid-guarded (stale handle never clobbers live entry) | c3x write c3-225 --section Contract |
| c3-225 Change Safety | Add row: "Stale re-spawn handle clobbers live registry entry / reap no-ops on non-leader pid" with grep + bun test detection | c3x write c3-225 --section "Change Safety" |
| N.A - no CLI underlay | This ADR changes runtime code only, not c3x commands/validators/schema | N.A - runtime-only change |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| pid-registry.test.ts | Asserts unregister(stale pid) keeps the live pid entry; register dedupes by pid | src/server/claude-pty/pid-registry.test.ts |
| pty-instance-registry.test.ts | Asserts markExitedIfCurrent(chatId, stalePid) is a no-op when live pid differs | src/server/claude-pty/pty-instance-registry.test.ts |
| driver.test.ts | Asserts an old handle's cleanupResources does not flip a chat to exited after a newer pid registered | src/server/claude-pty/driver.test.ts |
| pid-registry.test.ts (kill) | Asserts killProcessTree collects + signals pid + descendants, never -pid | src/server/claude-pty/pid-registry.test.ts |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| setsid the PTY child at spawn so pid==pgid and kill(-pid) works | Bun.Terminal/Bun.spawn does not expose a session-leader option in the deployed Bun; observed children inherit the server pgid. Relying on an unenforced setsid is exactly the false assumption that caused the leak. |
| Serialize close-then-spawn in closeClaudeSession (await old teardown before re-spawn) | Fixes the timing but not the root identity bug; an await on the 2 s+3 s SIGKILL escalation would stall every wake/rotation turn for seconds, regressing latency, and any future async gap reopens the race. |
| Keep sessionId key, add a generation counter | Adds a parallel identity to the pid that already uniquely identifies the OS process; pid is the natural key and is what reap needs anyway. |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Subtree walk misses a reparented descendant (orphaned after parent death) | Collect descendants BEFORE signalling the parent, then SIGKILL the whole set leaves-first | pid-registry.test.ts: tree fixture asserts all collected pids signalled |
| unregister(pid) signature change breaks a caller | Only caller is driver.ts; grep confirms; type change is compile-checked | bun run check-all / tsc; grep -rn "\.unregister(" src/server |
| Guarded teardown skips a legitimate exit (entry pid already cleared) | markExitedIfCurrent treats "no entry" as nothing-to-do (already removed) and only skips when a DIFFERENT pid owns the entry | pty-instance-registry.test.ts no-op + still-exits cases |
| ps invocation differs across macOS/Linux | Reuse the same ps -A -o pid=,ppid= form the memory sampler adapter already ships and tests | pty-memory-sampler.adapter.test.ts parity; new kill test |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/claude-pty/pid-registry.test.ts | pass (pid-key register/unregister + subtree kill) |
| bun test src/server/claude-pty/pty-instance-registry.test.ts | pass (markExitedIfCurrent guard) |
| bun test src/server/claude-pty/driver.test.ts | pass (no stale clobber) |
| bun run lint | 0 errors, warnings ≤ cap |
| grep -rn "process.kill(-" src/server/claude-pty | only inside killProcessTree guard, or absent |
