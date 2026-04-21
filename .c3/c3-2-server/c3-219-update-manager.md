---
id: c3-219
title: update-manager
type: component
category: feature
parent: c3-2
goal: Detect newer kanna-code versions, expose update state to the UI, and reload the app via a swappable strategy (npm/supervisor default, git/pm2 opt-in).
uses:
    - ref-cqrs-read-models
    - ref-strong-typing
c3-version: 4
---

# update-manager
## Goal

Detect newer kanna-code versions, expose update state to the UI, and reload the app via a swappable strategy (npm/supervisor default, git/pm2 opt-in).
## Container Connection

Keeps users aware of new versions without an external updater, and lets operators swap the reload mechanism (supervisor-exit vs pm2-reload) without changing client or server wiring.
## Dependencies

| Direction | What | From/To |
|-----------|------|---------|
| IN (uses) | `UpdateChecker` / `UpdateReloader` interfaces (in `update-strategy.ts`) | self |
| OUT (provides) | Update status projection | c3-207 |
| OUT (provides) | `restart_pending` signal consumed by CLI restart path | c3-201, c3-220 |
## Code References

| File | Purpose |
|------|---------|
| `src/server/update-manager.ts` | State machine; depends on `UpdateChecker` + `UpdateReloader` interfaces. Surfaces structured errors via `UpdateInstallError`. |
| `src/server/update-strategy.ts` | Interfaces + `NpmChecker` / `GitChecker` / `SupervisorExitReloader` / `Pm2Reloader` + `createUpdateStrategy` factory (keyed on `KANNA_RELOADER`). |
| `src/server/update-manager.test.ts` | Unit tests for the manager against fake checker/reloader. |
| `src/server/update-strategy.test.ts` | Unit tests for all checkers, reloaders, and factory branches. |

## Strategy Matrix

| `KANNA_RELOADER` | Checker | Reloader | Extra env |
|------------------|---------|----------|-----------|
| unset / `supervisor` | `NpmChecker` | `SupervisorExitReloader` (install + exit 76) | — |
| `pm2` | `GitChecker` | `Pm2Reloader` (git pull → build → pm2 reload) | `KANNA_REPO_DIR` (required), `KANNA_PM2_PROCESS_NAME` (optional, default `kanna`) |

## Related Refs

| Ref | How It Serves Goal |
|-----|-------------------|
| ref-cqrs-read-models | Exposes update state as a projection |
| ref-strong-typing | All side effects flow through typed DI interfaces — no `any`, no globals |

## Layer Constraints

This component operates within these boundaries:

**MUST:**
- Focus on single responsibility within its domain
- Cite refs for patterns instead of re-implementing
- Hand off cross-component concerns to container
- Keep `UpdateManager` free of strategy-specific knowledge (all branching lives in `createUpdateStrategy`)

**MUST NOT:**
- Import directly from other containers (use container linkages)
- Define system-wide configuration (context responsibility)
- Orchestrate multiple peer components (container responsibility)
- Redefine patterns that exist in refs
- Hardcode npm/git/pm2 behavior in `update-manager.ts` — extend via a new `UpdateChecker`/`UpdateReloader` pair
