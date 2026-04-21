# pm2 Update Reloader Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the launchd-based dev deploy on macOS with pm2, and abstract the in-app update button behind swappable checker + reloader interfaces so the pm2 reload pipeline (git pull → build → `pm2 reload`) can coexist with the current npm-registry self-update path.

**Architecture:** New `src/server/update-strategy.ts` defines `UpdateChecker` and `UpdateReloader` interfaces with a factory that selects impls from the `KANNA_RELOADER` env var. `UpdateManager` swaps its `fetchLatestVersion` + `installVersion` deps for `checker` + `reloader`. The supervisor-exit + npm-install path becomes a concrete `SupervisorExitReloader` + `NpmChecker` (default, zero behavior change). The pm2 path adds `GitChecker` + `Pm2Reloader`, wired via a templated `scripts/pm2.config.cjs` and a rewritten `scripts/deploy.sh`.

**Tech Stack:** Bun, TypeScript, `bun:test`, pm2 (programmatic API via the `pm2` npm package), git, envsubst.

**Design doc:** `docs/plans/2026-04-21-pm2-update-reloader-design.md`

---

## Preconditions

- Worktree at `.worktrees/pm2-reloader`, branch `feature/pm2-reloader`.
- `bun install` already run, baseline `bun test` = 586 pass / 0 fail.
- Work is dev-only scope — end-user npm install path must remain default.

Run all test commands from the worktree root: `/Users/cuongtran/Desktop/repo/kanna/.worktrees/pm2-reloader`.

---

## Task 1: Create `UpdateChecker` + `NpmChecker` (TDD)

**Files:**
- Create: `src/server/update-strategy.ts`
- Create: `src/server/update-strategy.test.ts`

**Step 1: Write the failing tests**

```ts
// src/server/update-strategy.test.ts
import { describe, expect, test } from "bun:test"
import { NpmChecker } from "./update-strategy"

describe("NpmChecker", () => {
  test("reports update available when latest is newer", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => "0.13.0",
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "0.13.0", updateAvailable: true })
  })

  test("reports no update when versions match", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.13.0",
      fetchLatestVersion: async () => "0.13.0",
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "0.13.0", updateAvailable: false })
  })

  test("propagates fetch errors", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => { throw new Error("registry down") },
    })
    await expect(checker.check()).rejects.toThrow("registry down")
  })
})
```

**Step 2: Run test to verify failure**

Run: `bun test src/server/update-strategy.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```ts
// src/server/update-strategy.ts
import { compareVersions } from "./cli-runtime"
import { PACKAGE_NAME } from "../shared/branding"

export interface UpdateChecker {
  check(): Promise<{ latestVersion: string | null; updateAvailable: boolean }>
}

export interface UpdateReloader {
  reload(): Promise<void>
}

export interface NpmCheckerDeps {
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
}

export class NpmChecker implements UpdateChecker {
  constructor(private deps: NpmCheckerDeps) {}

  async check() {
    const latestVersion = await this.deps.fetchLatestVersion(PACKAGE_NAME)
    const updateAvailable = compareVersions(this.deps.currentVersion, latestVersion) < 0
    return { latestVersion, updateAvailable }
  }
}
```

**Step 4: Run test to verify passing**

Run: `bun test src/server/update-strategy.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "feat(update-strategy): add UpdateChecker interface and NpmChecker impl"
```

---

## Task 2: `SupervisorExitReloader` (TDD)

**Files:**
- Modify: `src/server/update-strategy.ts`
- Modify: `src/server/update-strategy.test.ts`

**Step 1: Add failing tests**

```ts
// append to src/server/update-strategy.test.ts
import { SupervisorExitReloader } from "./update-strategy"

describe("SupervisorExitReloader", () => {
  test("installs target version then signals UI restart exit", async () => {
    const calls: Array<{ packageName: string; version: string }> = []
    let exitCode: number | null = null
    const reloader = new SupervisorExitReloader({
      targetVersion: () => "0.13.0",
      installVersion: (packageName, version) => {
        calls.push({ packageName, version })
        return { ok: true, errorCode: null, userTitle: null, userMessage: null }
      },
      exit: (code) => { exitCode = code },
    })

    await reloader.reload()
    expect(calls).toEqual([{ packageName: "kanna-code", version: "0.13.0" }])
    expect(exitCode).toBe(76)
  })

  test("throws with structured error when install fails", async () => {
    const reloader = new SupervisorExitReloader({
      targetVersion: () => "0.13.0",
      installVersion: () => ({
        ok: false,
        errorCode: "version_not_live_yet",
        userTitle: "Update not live yet",
        userMessage: "This update is still propagating. Try again in a few minutes.",
      }),
      exit: () => {},
    })

    await expect(reloader.reload()).rejects.toMatchObject({
      message: "This update is still propagating. Try again in a few minutes.",
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
    })
  })

  test("throws when target version cannot be resolved", async () => {
    const reloader = new SupervisorExitReloader({
      targetVersion: () => null,
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
      exit: () => {},
    })
    await expect(reloader.reload()).rejects.toThrow(/target version/i)
  })
})
```

**Step 2: Run to verify failure**

Run: `bun test src/server/update-strategy.test.ts`
Expected: FAIL — `SupervisorExitReloader` not exported.

**Step 3: Implement**

Add to `src/server/update-strategy.ts`:

```ts
import type { UpdateInstallErrorCode } from "../shared/types"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { CLI_UI_UPDATE_RESTART_EXIT_CODE } from "./restart"

export class UpdateInstallError extends Error {
  constructor(
    message: string,
    public readonly errorCode: UpdateInstallErrorCode | null,
    public readonly userTitle: string | null,
  ) {
    super(message)
    this.name = "UpdateInstallError"
  }
}

export interface SupervisorExitReloaderDeps {
  targetVersion: () => string | null
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  exit: (code: number) => void
}

export class SupervisorExitReloader implements UpdateReloader {
  constructor(private deps: SupervisorExitReloaderDeps) {}

  async reload() {
    const version = this.deps.targetVersion()
    if (!version) {
      throw new UpdateInstallError(
        "Unable to determine target version.",
        "install_failed",
        "Update failed",
      )
    }
    const result = this.deps.installVersion(PACKAGE_NAME, version)
    if (!result.ok) {
      throw new UpdateInstallError(
        result.userMessage ?? "Unable to install the latest version.",
        result.errorCode,
        result.userTitle,
      )
    }
    this.deps.exit(CLI_UI_UPDATE_RESTART_EXIT_CODE)
  }
}
```

**Step 4: Verify passing**

Run: `bun test src/server/update-strategy.test.ts`
Expected: PASS (6 tests total).

**Step 5: Commit**

```bash
git add src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "feat(update-strategy): add SupervisorExitReloader wrapping current install+exit"
```

---

## Task 3: `createUpdateStrategy` factory (TDD env matrix, supervisor-only for now)

**Files:**
- Modify: `src/server/update-strategy.ts`
- Modify: `src/server/update-strategy.test.ts`

**Step 1: Failing tests**

```ts
// append
import { createUpdateStrategy } from "./update-strategy"

describe("createUpdateStrategy", () => {
  const baseDeps = {
    currentVersion: "0.12.0",
    fetchLatestVersion: async () => "0.13.0",
    installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
    latestVersionHint: () => "0.13.0",
    exit: () => {},
  }

  test("defaults to npm + supervisor-exit when env unset", () => {
    const strategy = createUpdateStrategy({ reloaderEnv: undefined, ...baseDeps })
    expect(strategy.checker).toBeInstanceOf(NpmChecker)
    expect(strategy.reloader).toBeInstanceOf(SupervisorExitReloader)
  })

  test("uses npm + supervisor-exit when env=supervisor", () => {
    const strategy = createUpdateStrategy({ reloaderEnv: "supervisor", ...baseDeps })
    expect(strategy.checker).toBeInstanceOf(NpmChecker)
    expect(strategy.reloader).toBeInstanceOf(SupervisorExitReloader)
  })

  test("throws on unknown reloader value", () => {
    expect(() => createUpdateStrategy({ reloaderEnv: "bogus", ...baseDeps })).toThrow(/unknown.*reloader/i)
  })
})
```

**Step 2: Run — verify failure.** `bun test src/server/update-strategy.test.ts`.

**Step 3: Implement**

Add to `src/server/update-strategy.ts`:

```ts
export interface CreateUpdateStrategyDeps {
  reloaderEnv: string | undefined
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  latestVersionHint: () => string | null
  exit: (code: number) => void
  repoDir?: string
}

export function createUpdateStrategy(deps: CreateUpdateStrategyDeps): {
  checker: UpdateChecker
  reloader: UpdateReloader
} {
  const mode = deps.reloaderEnv ?? "supervisor"
  if (mode === "supervisor") {
    return {
      checker: new NpmChecker({
        currentVersion: deps.currentVersion,
        fetchLatestVersion: deps.fetchLatestVersion,
      }),
      reloader: new SupervisorExitReloader({
        targetVersion: deps.latestVersionHint,
        installVersion: deps.installVersion,
        exit: deps.exit,
      }),
    }
  }
  throw new Error(`Unknown KANNA_RELOADER value: ${mode}`)
}
```

(pm2 branch added in Task 8.)

**Step 4: Run — verify passing.** All 9 tests pass.

**Step 5: Commit**

```bash
git add src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "feat(update-strategy): add createUpdateStrategy factory keyed on KANNA_RELOADER"
```

---

## Task 4: Refactor `UpdateManager` to depend on `checker` + `reloader` (TDD)

**Files:**
- Modify: `src/server/update-manager.ts`
- Modify: `src/server/update-manager.test.ts`

**Step 1: Rewrite tests first**

Replace the contents of `src/server/update-manager.test.ts` with fake checker + reloader fixtures. Preserve all four existing scenarios (`detects available updates`, `bypasses cache when force is true`, `surfaces install failures without clearing the running version`, `always exposes an available reload action in dev mode`) but injecting fakes rather than `fetchLatestVersion`/`installVersion`.

```ts
import { describe, expect, test } from "bun:test"
import { UpdateManager } from "./update-manager"
import { UpdateInstallError, type UpdateChecker, type UpdateReloader } from "./update-strategy"

class FakeChecker implements UpdateChecker {
  calls = 0
  constructor(private results: Array<{ latestVersion: string | null; updateAvailable: boolean }>) {}
  async check() {
    const result = this.results[Math.min(this.calls, this.results.length - 1)]
    this.calls += 1
    return result
  }
}

class FakeReloader implements UpdateReloader {
  calls = 0
  constructor(private onReload: () => Promise<void> = async () => {}) {}
  async reload() {
    this.calls += 1
    await this.onReload()
  }
}

describe("UpdateManager", () => {
  test("detects available updates", async () => {
    const manager = new UpdateManager({
      currentVersion: "0.12.0",
      checker: new FakeChecker([{ latestVersion: "0.13.0", updateAvailable: true }]),
      reloader: new FakeReloader(),
    })
    const snapshot = await manager.checkForUpdates({ force: true })
    expect(snapshot.status).toBe("available")
    expect(snapshot.updateAvailable).toBe(true)
    expect(snapshot.latestVersion).toBe("0.13.0")
    expect(snapshot.installAction).toBe("restart")
    expect(snapshot.reloadRequestedAt).toBeNull()
  })

  test("bypasses cache when force is true", async () => {
    const checker = new FakeChecker([
      { latestVersion: "0.12.1", updateAvailable: true },
      { latestVersion: "0.13.0", updateAvailable: true },
    ])
    const manager = new UpdateManager({
      currentVersion: "0.12.0",
      checker,
      reloader: new FakeReloader(),
    })
    await manager.checkForUpdates()
    await manager.checkForUpdates({ force: true })
    expect(checker.calls).toBe(2)
    expect(manager.getSnapshot().latestVersion).toBe("0.13.0")
  })

  test("surfaces reloader failures without clearing the running version", async () => {
    const reloader = new FakeReloader(async () => {
      throw new UpdateInstallError(
        "This update is still propagating. Try again in a few minutes.",
        "version_not_live_yet",
        "Update not live yet",
      )
    })
    const manager = new UpdateManager({
      currentVersion: "0.12.0",
      checker: new FakeChecker([{ latestVersion: "0.13.0", updateAvailable: true }]),
      reloader,
    })
    await manager.checkForUpdates({ force: true })
    const result = await manager.installUpdate()
    expect(result).toEqual({
      ok: false,
      action: "restart",
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
      userMessage: "This update is still propagating. Try again in a few minutes.",
    })
    expect(reloader.calls).toBe(1)
    expect(manager.getSnapshot().status).toBe("error")
    expect(manager.getSnapshot().currentVersion).toBe("0.12.0")
  })

  test("always exposes an available reload action in dev mode", async () => {
    const manager = new UpdateManager({
      currentVersion: "0.12.0",
      checker: new FakeChecker([{ latestVersion: "9.9.9", updateAvailable: true }]),
      reloader: new FakeReloader(),
      devMode: true,
    })
    expect(manager.getSnapshot()).toMatchObject({
      status: "available",
      updateAvailable: true,
      installAction: "restart",
      reloadRequestedAt: null,
    })
    const result = await manager.installUpdate()
    expect(result).toEqual({
      ok: true,
      action: "restart",
      errorCode: null,
      userTitle: null,
      userMessage: null,
    })
    expect(manager.getSnapshot().status).toBe("restart_pending")
    expect(typeof manager.getSnapshot().reloadRequestedAt).toBe("number")
  })
})
```

**Step 2: Run — verify failure**

Run: `bun test src/server/update-manager.test.ts`
Expected: FAIL — `UpdateManager` still expects `fetchLatestVersion` / `installVersion`.

**Step 3: Rewrite `UpdateManager`**

Replace `src/server/update-manager.ts`:

```ts
import type { UpdateInstallResult, UpdateSnapshot } from "../shared/types"
import { UpdateInstallError, type UpdateChecker, type UpdateReloader } from "./update-strategy"

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000

export interface UpdateManagerDeps {
  currentVersion: string
  checker: UpdateChecker
  reloader: UpdateReloader
  devMode?: boolean
}

export class UpdateManager {
  private readonly deps: UpdateManagerDeps
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>()
  private snapshot: UpdateSnapshot
  private checkPromise: Promise<UpdateSnapshot> | null = null
  private installPromise: Promise<UpdateInstallResult> | null = null

  constructor(deps: UpdateManagerDeps) {
    this.deps = deps
    this.snapshot = {
      currentVersion: deps.currentVersion,
      latestVersion: deps.devMode ? `${deps.currentVersion}-dev` : null,
      status: deps.devMode ? "available" : "idle",
      updateAvailable: Boolean(deps.devMode),
      lastCheckedAt: deps.devMode ? Date.now() : null,
      error: null,
      installAction: "restart",
      reloadRequestedAt: null,
    }
  }

  getSnapshot() { return this.snapshot }

  onChange(listener: (snapshot: UpdateSnapshot) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async checkForUpdates(options: { force?: boolean } = {}) {
    if (this.deps.devMode) return this.snapshot
    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") return this.snapshot
    if (this.checkPromise) return this.checkPromise
    if (!options.force && this.snapshot.lastCheckedAt && Date.now() - this.snapshot.lastCheckedAt < UPDATE_CACHE_TTL_MS) {
      return this.snapshot
    }

    this.setSnapshot({ ...this.snapshot, status: "checking", error: null, reloadRequestedAt: null })

    const checkPromise = this.runCheck()
    this.checkPromise = checkPromise
    try { return await checkPromise }
    finally { if (this.checkPromise === checkPromise) this.checkPromise = null }
  }

  async installUpdate(): Promise<UpdateInstallResult> {
    if (this.deps.devMode) {
      this.setSnapshot({ ...this.snapshot, status: "updating", error: null, reloadRequestedAt: null })
      this.setSnapshot({
        ...this.snapshot,
        status: "restart_pending",
        updateAvailable: false,
        error: null,
        reloadRequestedAt: Date.now(),
      })
      return { ok: true, action: "restart", errorCode: null, userTitle: null, userMessage: null }
    }

    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") {
      return { ok: this.snapshot.updateAvailable, action: "restart", errorCode: null, userTitle: null, userMessage: null }
    }

    if (this.installPromise) return this.installPromise

    const installPromise = this.runInstall()
    this.installPromise = installPromise
    try { return await installPromise }
    finally { if (this.installPromise === installPromise) this.installPromise = null }
  }

  private async runCheck() {
    try {
      const { latestVersion, updateAvailable } = await this.deps.checker.check()
      const nextSnapshot: UpdateSnapshot = {
        ...this.snapshot,
        latestVersion,
        updateAvailable,
        status: updateAvailable ? "available" : "up_to_date",
        lastCheckedAt: Date.now(),
        error: null,
        reloadRequestedAt: null,
      }
      this.setSnapshot(nextSnapshot)
      return nextSnapshot
    } catch (error) {
      const nextSnapshot: UpdateSnapshot = {
        ...this.snapshot,
        status: "error",
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        reloadRequestedAt: null,
      }
      this.setSnapshot(nextSnapshot)
      return nextSnapshot
    }
  }

  private async runInstall(): Promise<UpdateInstallResult> {
    if (!this.snapshot.updateAvailable) {
      const snapshot = await this.checkForUpdates({ force: true })
      if (!snapshot.updateAvailable) {
        return { ok: false, action: "restart", errorCode: null, userTitle: null, userMessage: null }
      }
    }

    this.setSnapshot({ ...this.snapshot, status: "updating", error: null, reloadRequestedAt: null })

    try {
      await this.deps.reloader.reload()
    } catch (error) {
      const installError = error instanceof UpdateInstallError ? error : null
      const message = error instanceof Error ? error.message : String(error)
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: installError?.message ?? message,
        reloadRequestedAt: null,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: installError?.errorCode ?? "install_failed",
        userTitle: installError?.userTitle ?? "Update failed",
        userMessage: installError?.message ?? message,
      }
    }

    this.setSnapshot({
      ...this.snapshot,
      currentVersion: this.snapshot.latestVersion ?? this.snapshot.currentVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: Date.now(),
    })
    return { ok: true, action: "restart", errorCode: null, userTitle: null, userMessage: null }
  }

  private setSnapshot(snapshot: UpdateSnapshot) {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}
```

**Step 4: Verify passing**

Run: `bun test src/server/update-manager.test.ts`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add src/server/update-manager.ts src/server/update-manager.test.ts
git commit -m "refactor(update-manager): depend on UpdateChecker + UpdateReloader abstractions"
```

---

## Task 5: Wire `server.ts` + `cli.ts` to the factory

**Files:**
- Modify: `src/server/server.ts:105-112`
- Modify: `src/server/cli.ts` (where UpdateManager deps flow from)

**Step 1: Update `server.ts`**

Replace the `new UpdateManager({ ... })` block with factory wiring:

```ts
import { createUpdateStrategy } from "./update-strategy"

// inside startKannaServer, where update manager is built:
const updateManager = options.update
  ? (() => {
      const strategy = createUpdateStrategy({
        reloaderEnv: process.env.KANNA_RELOADER,
        currentVersion: options.update.version,
        fetchLatestVersion: options.update.fetchLatestVersion,
        installVersion: options.update.installVersion,
        latestVersionHint: () => managerRef.current?.getSnapshot().latestVersion ?? null,
        exit: (code) => process.exit(code),
        repoDir: process.env.KANNA_REPO_DIR,
      })
      const manager = new UpdateManager({
        currentVersion: options.update.version,
        checker: strategy.checker,
        reloader: strategy.reloader,
        devMode: getRuntimeProfile() === "dev",
      })
      managerRef.current = manager
      return manager
    })()
  : null
```

Declare `const managerRef: { current: UpdateManager | null } = { current: null }` just above — `latestVersionHint` needs a forward reference into the manager's own snapshot.

**Step 2: Update `cli.ts`**

The existing `exit: (code) => process.exit(code)` path in the factory would exit the child directly and bypass `cli.ts`'s graceful shutdown (which calls `result.stop()` then exits). To preserve that, replace `exit` wiring with a signal into the existing `resolveExitAction("ui_restart")` listener — the `restart_pending` snapshot already drives that. So: in `SupervisorExitReloader`, instead of calling `process.exit` directly, rely on the UpdateManager's own `restart_pending` transition.

Change plan: `SupervisorExitReloader` does NOT call `exit` itself. Remove `exit` from `SupervisorExitReloaderDeps` and its test. `UpdateManager.installUpdate` already sets `restart_pending` after reload resolves, and `cli.ts:25-29` already listens for that and calls `resolveExitAction("ui_restart")` which drives the graceful shutdown path.

Roll back Task 2's `exit` dep: remove from `SupervisorExitReloaderDeps`, `createUpdateStrategy`, tests. Run `bun test src/server/update-strategy.test.ts` + `bun test src/server/update-manager.test.ts` — all pass.

Then in `server.ts` wiring, drop `exit` from factory deps. Commit each sub-step.

**Step 3: Verify full test suite passes**

Run: `bun test`
Expected: 586 pass, 0 fail (same baseline).

Run: `bun run check`
Expected: no TypeScript errors, build succeeds.

**Step 4: Commit**

```bash
git add src/server/server.ts src/server/cli.ts src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "refactor(server): wire UpdateManager through createUpdateStrategy factory"
```

---

## Task 6: Add `pm2` dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`

**Step 1: Install**

Run: `bun add pm2@latest`
Expected: `pm2` added to `dependencies`.

**Step 2: Verify build still works**

Run: `bun run check`
Expected: no errors.

Run: `bun test`
Expected: 586 pass.

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): add pm2 for dev reloader"
```

---

## Task 7: `GitChecker` (TDD)

**Files:**
- Modify: `src/server/update-strategy.ts`
- Modify: `src/server/update-strategy.test.ts`

**Step 1: Failing tests**

Create `GitChecker` with injected `runGit: (args: string[]) => Promise<string>` for stubbing.

```ts
// append to test file
import { GitChecker } from "./update-strategy"

describe("GitChecker", () => {
  const makeRunGit = (responses: Record<string, string>) => async (args: string[]) => {
    const key = args.join(" ")
    if (!(key in responses)) throw new Error(`unexpected git call: ${key}`)
    return responses[key]
  }

  test("reports update when HEAD differs from upstream", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: makeRunGit({
        "fetch origin main": "",
        "rev-parse HEAD": "abc123def456\n",
        "rev-parse origin/main": "deadbeef99887\n",
      }),
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "deadbee", updateAvailable: true })
  })

  test("reports no update when HEAD matches upstream", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: makeRunGit({
        "fetch origin main": "",
        "rev-parse HEAD": "abc123def456\n",
        "rev-parse origin/main": "abc123def456\n",
      }),
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "abc123d", updateAvailable: false })
  })

  test("propagates git fetch errors", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: async () => { throw new Error("fetch failed: network") },
    })
    await expect(checker.check()).rejects.toThrow(/fetch failed/)
  })
})
```

**Step 2: Run — verify failure.** `bun test src/server/update-strategy.test.ts`.

**Step 3: Implement**

Add to `src/server/update-strategy.ts`:

```ts
export interface GitCheckerDeps {
  repoDir: string
  branch: string
  runGit: (args: string[]) => Promise<string>
}

export class GitChecker implements UpdateChecker {
  constructor(private deps: GitCheckerDeps) {}

  async check() {
    await this.deps.runGit(["fetch", "origin", this.deps.branch])
    const headRaw = await this.deps.runGit(["rev-parse", "HEAD"])
    const upstreamRaw = await this.deps.runGit(["rev-parse", `origin/${this.deps.branch}`])
    const head = headRaw.trim()
    const upstream = upstreamRaw.trim()
    return {
      latestVersion: upstream.slice(0, 7),
      updateAvailable: head !== upstream,
    }
  }
}
```

Also export a default `runGit` helper using `Bun.spawn` (see Task 8 for the shared spawn helper; keep this task scoped to the class — the factory will wire in a real `runGit` in Task 8).

**Step 4: Run — verify passing.** All strategy tests green.

**Step 5: Commit**

```bash
git add src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "feat(update-strategy): add GitChecker for pm2 mode update detection"
```

---

## Task 8: `Pm2Reloader` + pm2 branch in factory (TDD)

**Files:**
- Modify: `src/server/update-strategy.ts`
- Modify: `src/server/update-strategy.test.ts`

**Step 1: Failing tests**

Design the reloader with all side effects injected: `runCommand(command: string, args: string[]): Promise<void>`, `triggerPm2Reload(processName: string): Promise<void>`, and `lockfileChanged(repoDir: string): Promise<boolean>`.

```ts
import { Pm2Reloader, UpdateInstallError } from "./update-strategy"

describe("Pm2Reloader", () => {
  function makeReloader(overrides: Partial<{
    lockfileChanged: boolean
    commandErrors: Record<string, string>
    reloadError: Error | null
  }> = {}) {
    const calls: string[] = []
    const reloader = new Pm2Reloader({
      repoDir: "/tmp/repo",
      processName: "kanna",
      runCommand: async (command, args) => {
        const line = [command, ...args].join(" ")
        calls.push(line)
        if (overrides.commandErrors?.[line]) {
          throw new Error(overrides.commandErrors[line])
        }
      },
      lockfileChanged: async () => overrides.lockfileChanged ?? false,
      triggerPm2Reload: async () => {
        calls.push("pm2.reload kanna")
        if (overrides.reloadError) throw overrides.reloadError
      },
    })
    return { reloader, calls }
  }

  test("runs git pull, build, then pm2 reload when lockfile unchanged", async () => {
    const { reloader, calls } = makeReloader({ lockfileChanged: false })
    await reloader.reload()
    expect(calls).toEqual([
      "git pull --ff-only",
      "bun run build",
      "pm2.reload kanna",
    ])
  })

  test("inserts bun install when lockfile changed", async () => {
    const { reloader, calls } = makeReloader({ lockfileChanged: true })
    await reloader.reload()
    expect(calls).toEqual([
      "git pull --ff-only",
      "bun install",
      "bun run build",
      "pm2.reload kanna",
    ])
  })

  test("aborts before reload when git pull fails", async () => {
    const { reloader, calls } = makeReloader({
      commandErrors: { "git pull --ff-only": "merge conflict in src/foo.ts" },
    })
    await expect(reloader.reload()).rejects.toThrow(/git pull failed/i)
    expect(calls).toEqual(["git pull --ff-only"])
  })

  test("aborts before reload when build fails", async () => {
    const { reloader, calls } = makeReloader({
      commandErrors: { "bun run build": "tsc error TS2345" },
    })
    await expect(reloader.reload()).rejects.toThrow(/build failed/i)
    expect(calls).toEqual(["git pull --ff-only", "bun run build"])
  })

  test("surfaces pm2 reload failures", async () => {
    const { reloader } = makeReloader({ reloadError: new Error("pm2 daemon not running") })
    await expect(reloader.reload()).rejects.toThrow(/pm2 reload failed/i)
  })
})

describe("createUpdateStrategy pm2 branch", () => {
  test("returns GitChecker + Pm2Reloader for KANNA_RELOADER=pm2", () => {
    const strategy = createUpdateStrategy({
      reloaderEnv: "pm2",
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => "ignored",
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
      latestVersionHint: () => null,
      repoDir: "/tmp/repo",
    })
    expect(strategy.checker).toBeInstanceOf(GitChecker)
    expect(strategy.reloader).toBeInstanceOf(Pm2Reloader)
  })

  test("throws when pm2 mode selected without repoDir", () => {
    expect(() =>
      createUpdateStrategy({
        reloaderEnv: "pm2",
        currentVersion: "0.12.0",
        fetchLatestVersion: async () => "ignored",
        installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
        latestVersionHint: () => null,
      }),
    ).toThrow(/KANNA_REPO_DIR/)
  })
})
```

**Step 2: Run — verify failure.**

**Step 3: Implement**

Add to `src/server/update-strategy.ts`:

```ts
export interface Pm2ReloaderDeps {
  repoDir: string
  processName: string
  runCommand: (command: string, args: string[]) => Promise<void>
  lockfileChanged: () => Promise<boolean>
  triggerPm2Reload: (processName: string) => Promise<void>
}

export class Pm2Reloader implements UpdateReloader {
  constructor(private deps: Pm2ReloaderDeps) {}

  async reload() {
    await this.step("git pull", ["git", "pull", "--ff-only"])
    if (await this.deps.lockfileChanged()) {
      await this.step("bun install", ["bun", "install"])
    }
    await this.step("bun run build", ["bun", "run", "build"])
    try {
      await this.deps.triggerPm2Reload(this.deps.processName)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UpdateInstallError(
        `pm2 reload failed: ${message}`,
        "install_failed",
        "Update failed",
      )
    }
  }

  private async step(label: string, argv: string[]) {
    const [command, ...args] = argv
    try {
      await this.deps.runCommand(command, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UpdateInstallError(
        `${label} failed: ${message}`,
        "install_failed",
        "Update failed",
      )
    }
  }
}
```

And extend `createUpdateStrategy`:

```ts
if (mode === "pm2") {
  if (!deps.repoDir) {
    throw new Error("KANNA_RELOADER=pm2 requires KANNA_REPO_DIR to be set")
  }
  const repoDir = deps.repoDir
  return {
    checker: new GitChecker({
      repoDir,
      branch: "main",
      runGit: (args) => runCommandCapture("git", args, repoDir),
    }),
    reloader: new Pm2Reloader({
      repoDir,
      processName: "kanna",
      runCommand: (command, args) => runCommandThrow(command, args, repoDir),
      lockfileChanged: () => detectLockfileChange(repoDir),
      triggerPm2Reload,
    }),
  }
}
```

Helpers in the same file:

- `runCommandCapture(command, args, cwd)` — `Bun.spawn({ cmd: [command, ...args], cwd, stdout: "pipe", stderr: "pipe" })`, awaits exit, returns stdout; throws on non-zero with stderr tail (last 500 chars).
- `runCommandThrow(command, args, cwd)` — same but void return.
- `detectLockfileChange(repoDir)` — `git diff --name-only HEAD@{1} HEAD -- bun.lock package.json`; non-empty output → true. (HEAD@{1} = pre-pull ref from reflog.)
- `triggerPm2Reload(name)` — wraps `import("pm2")` + `pm2.connect` + `pm2.reload` + `pm2.disconnect` in a promise.

**Step 4: Run — verify passing.** All strategy tests + integration.

**Step 5: Commit**

```bash
git add src/server/update-strategy.ts src/server/update-strategy.test.ts
git commit -m "feat(update-strategy): add Pm2Reloader with git-pull+build+pm2.reload pipeline"
```

---

## Task 9: Create `scripts/pm2.config.cjs.tmpl`

**Files:**
- Create: `scripts/pm2.config.cjs.tmpl`
- Modify: `.gitignore` (add `scripts/pm2.config.cjs` — the rendered output).

**Step 1: Write template**

```js
// scripts/pm2.config.cjs.tmpl
module.exports = {
  apps: [
    {
      name: "kanna",
      script: "./src/server/cli.ts",
      interpreter: "bun",
      cwd: "${REPO_DIR}",
      env: {
        KANNA_RELOADER: "pm2",
        KANNA_REPO_DIR: "${REPO_DIR}",
        KANNA_DISABLE_SELF_UPDATE: "1",
        KANNA_CLI_MODE: "child",
      },
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 5000,
    },
  ],
}
```

**Step 2: Add rendered file to `.gitignore`**

Append:

```
scripts/pm2.config.cjs
```

**Step 3: Commit**

```bash
git add scripts/pm2.config.cjs.tmpl .gitignore
git commit -m "feat(dev): add pm2 ecosystem template for local dev deploy"
```

---

## Task 10: Rewrite `scripts/deploy.sh`

**Files:**
- Modify: `scripts/deploy.sh`

**Step 1: Replace content**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_LINK="$HOME/.bun/install/global/node_modules/kanna-code"
PM2_NAME="kanna"
PM2_TEMPLATE="$REPO_DIR/scripts/pm2.config.cjs.tmpl"
PM2_CONFIG="$REPO_DIR/scripts/pm2.config.cjs"

cd "$REPO_DIR"

if [[ ! -L "$GLOBAL_LINK" ]]; then
  echo "→ Linking $GLOBAL_LINK → $REPO_DIR"
  rm -rf "$GLOBAL_LINK"
  mkdir -p "$(dirname "$GLOBAL_LINK")"
  ln -s "$REPO_DIR" "$GLOBAL_LINK"
fi

if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]] || [[ bun.lock -nt node_modules ]]; then
  echo "→ bun install"
  bun install
fi

echo "→ bun run build"
bun run build

if ! command -v pm2 >/dev/null 2>&1; then
  echo "→ bun install -g pm2"
  bun install -g pm2
fi

if ! command -v envsubst >/dev/null 2>&1; then
  echo "✗ envsubst not found (install gettext: brew install gettext)" >&2
  exit 1
fi

echo "→ render $PM2_CONFIG"
REPO_DIR="$REPO_DIR" envsubst '${REPO_DIR}' < "$PM2_TEMPLATE" > "$PM2_CONFIG"

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "→ pm2 reload $PM2_NAME"
  pm2 reload "$PM2_CONFIG" --update-env
else
  echo "→ pm2 start $PM2_NAME"
  pm2 start "$PM2_CONFIG"
fi

pm2 save
echo "✓ kanna running under pm2"
```

**Step 2: Syntax check**

Run: `bash -n scripts/deploy.sh`
Expected: exit 0.

**Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(dev): swap launchd for pm2 in deploy.sh"
```

---

## Task 11: Manual verification

**No files.** Checklist only.

**Step 1:** Unload the old launchd plist once:
```bash
launchctl bootout gui/$(id -u)/io.silentium.kanna || true
```

**Step 2:** Run deploy in the worktree:
```bash
cd /Users/cuongtran/Desktop/repo/kanna/.worktrees/pm2-reloader
./scripts/deploy.sh
pm2 list
```
Expected: `kanna` shows `online`.

**Step 3:** Happy path — commit a small, safe change (e.g., a comment in `src/shared/branding.ts`), push the branch, then click "Update" in the running UI. Verify:
- UI transitions through `checking` → `available` → `updating` → `restart_pending`.
- pm2 logs (`pm2 logs kanna --lines 50`) show `git pull`, `bun run build`, then fresh process startup.
- UI reconnects and reflects the change.

**Step 4:** Failure path — introduce a deliberate TypeScript syntax error on the branch, push, click Update. Verify:
- UI shows red error banner with stderr tail from `bun run build`.
- `pm2 list` shows `kanna` still `online` serving the old build.
- Fix the error, push, click Update again → recovers.

**Step 5:** Regression — `pm2 delete kanna`, then in a plain terminal run `kanna` (symlinked to worktree build). Supervisor path should still respond to update button as before (npm-registry check). This verifies unset `KANNA_RELOADER` keeps old behavior.

**Step 6:** Commit the verification notes (optional): if anything unexpected was found, document in the plan's "Results" section.

---

## Final checks before PR

Run:

```bash
bun run check   # tsc + vite build
bun test
```

Expected: 0 TypeScript errors, all tests pass (at least 586 + the new ones from Tasks 1-3, 7, 8 — roughly 601-610 total).

Then follow `superpowers:finishing-a-development-branch` to close out.
