---
id: adr-20260421-pm2-update-reloader
title: pm2-update-reloader
type: adr
status: implemented
date: "2026-04-21T00:00:00Z"
---

# pm2-update-reloader
## Goal

Replace macOS launchd supervision with pm2 for the dev deploy path, and wire the in-app Update button to trigger a pm2-reload pipeline (git pull → build → `pm2 reload`). Abstract the update mechanism so the existing npm/self-update path and the new git/pm2 path coexist and can be swapped without touching `UpdateManager` or server wiring.

## Decision

Introduced two interfaces in `src/server/update-strategy.ts`:

- `UpdateChecker.check()` — returns `{ latestVersion, updateAvailable }`
- `UpdateReloader.reload()` — performs install / reload, throws `UpdateInstallError` on failure

Shipped two implementations of each, wired by a factory `createUpdateStrategy` keyed on `KANNA_RELOADER`:

| Mode | Checker | Reloader | Default? |
|------|---------|----------|----------|
| `supervisor` (or unset) | `NpmChecker` (npm registry) | `SupervisorExitReloader` (install → restart_pending → process exit 76 → parent respawn) | yes |
| `pm2` | `GitChecker` (git fetch → HEAD vs origin/branch) | `Pm2Reloader` (git pull → cond. bun install → bun run build → `pm2.reload`) | opt-in |

`UpdateManager` depends only on the interfaces; no knowledge of npm/git/pm2.

## Env Vars

- `KANNA_RELOADER` — `supervisor` (default) or `pm2`
- `KANNA_REPO_DIR` — required when `KANNA_RELOADER=pm2`; absolute path to the git worktree pm2 runs from
- `KANNA_PM2_PROCESS_NAME` — optional; defaults to `kanna`; must match the `name:` field in the pm2 ecosystem config

## Ops

- `scripts/pm2.config.cjs.tmpl` — templated pm2 ecosystem file (envsubst renders `${REPO_DIR}` + `${PM2_NAME}` into `scripts/pm2.config.cjs`, which is gitignored)
- `scripts/deploy.sh` — now installs pm2 if missing, renders the config, and runs `pm2 reload` (or `pm2 start` on first run). Drops `launchctl kickstart`.

## Work Breakdown

Done across 11 tasks (see `docs/plans/2026-04-21-pm2-update-reloader.md`): interfaces + npm/supervisor impl → factory → UpdateManager refactor → server wiring → pm2 dep → GitChecker → Pm2Reloader → pm2 ecosystem template → deploy.sh rewrite → manual verification.

## Risks

- `detectLockfileChange` returns `true` on any git error (fresh clone, no `HEAD@{1}`) — conservatively over-installs rather than skipping a needed `bun install`.
- pm2 self-reload race: pm2 signals the current process immediately; `cli.ts` may exit with 0 instead of 76 if pm2's SIGTERM wins over the `restart_pending` listener. Harmless because `autorestart: true` restarts regardless of exit code.
- `branch: "main"` is hardcoded in the factory's `GitChecker` wiring; dev-only scope, low risk.
- pm2 is a `devDependency`, lazy-imported only in pm2 mode — end users on the supervisor path never pull it.
