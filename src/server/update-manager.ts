import { Clock, Context, Deferred, Effect, Layer, Option, Result, Scope, Stream, SubscriptionRef } from "effect"
import type { UpdateInstallResult, UpdateSnapshot } from "../shared/types"
import { isNightlyVersion } from "../shared/types"
import { PACKAGE_NAME } from "../shared/branding"
import { compareVersions, type PackageRegistryError, type UpdateInstallAttemptResult } from "./cli-runtime"
import type { MainCommitLookupError, NightlyInstallResult } from "./nightly"

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000

export interface UpdateManagerDeps {
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Effect.Effect<string, PackageRegistryError>
  /** The commit main is at, for nightly installs (see server/nightly.ts). */
  fetchLatestNightlySha?: Effect.Effect<string, MainCommitLookupError>
  installVersion: (packageName: string, version: string) => Effect.Effect<UpdateInstallAttemptResult>
  /** Build main from source and install it globally (see server/nightly.ts). */
  installNightly?: Effect.Effect<NightlyInstallResult>
  devMode?: boolean
  trackEvent?: (eventName: string, properties?: Record<string, unknown>) => Effect.Effect<void>
}

/**
 * Kanna's self-update: checks npm (and GitHub, for a nightly install) for a
 * newer build, installs one when the user asks, and then reports
 * `restart_pending` so the CLI restarts into it (cli.ts).
 *
 * A check, or an install, already running is shared: a second caller waits
 * for the same result instead of starting another. The work runs in the
 * layer's scope, so a caller that gives up does not cancel it for the rest.
 *
 * `changes` emits each snapshot after the current one, never the current one
 * itself; read that with `snapshot`.
 */
export class UpdateManager extends Context.Service<UpdateManager, {
  readonly snapshot: Effect.Effect<UpdateSnapshot>
  readonly changes: Stream.Stream<UpdateSnapshot>
  readonly checkForUpdates: (options?: { readonly force?: boolean }) => Effect.Effect<UpdateSnapshot>
  readonly installUpdate: Effect.Effect<UpdateInstallResult>
  /**
   * Build main from GitHub and restart into it. Uses the same busy/restart
   * plumbing as installUpdate; the stamped "-nightly.<sha>" version keeps the
   * base version's ordering, so the next published release upgrades a nightly
   * back to stable through the normal update path.
   */
  readonly installNightly: Effect.Effect<UpdateInstallResult>
  /**
   * Reinstall the latest published release even when the version number
   * matches the running one — the way back from a nightly build without
   * waiting for the next release.
   */
  readonly installStable: Effect.Effect<UpdateInstallResult>
}>()("@kanna/server/UpdateManager") {
  static readonly layer = (deps: UpdateManagerDeps) => Layer.effect(this, makeUpdateManager(deps))
}

function restartResult(ok: boolean): UpdateInstallResult {
  return { ok, action: "restart", errorCode: null, userTitle: null, userMessage: null }
}

function isBusy(snapshot: UpdateSnapshot) {
  return snapshot.status === "updating" || snapshot.status === "restart_pending"
}

/**
 * One run of `work` at a time, in `scope`; callers that arrive while it runs
 * wait for its result. Cleared when the run ends, so the next call starts a
 * fresh one.
 */
function makeSharedRun<A>(scope: Scope.Scope) {
  let running: Option.Option<Deferred.Deferred<A>> = Option.none()
  return {
    current: () => running,
    run: (work: Effect.Effect<A>) => Effect.gen(function* () {
      const deferred = yield* Deferred.make<A>()
      running = Option.some(deferred)
      // Cleared before the waiters wake: one of them may start the next run.
      const clear = Effect.sync(() => {
        if (Option.isSome(running) && running.value === deferred) running = Option.none()
      })
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.exit(restore(work)).pipe(
          Effect.tap(() => clear),
          Effect.flatMap((exit) => Deferred.done(deferred, exit)),
        )).pipe(Effect.forkIn(scope))
      return yield* Deferred.await(deferred)
    }),
  }
}

const makeUpdateManager = Effect.fn("UpdateManager.make")(function* (deps: UpdateManagerDeps) {
  yield* Effect.annotateCurrentSpan("currentVersion", deps.currentVersion)
  const scope = yield* Effect.scope
  const startedAt = yield* Clock.currentTimeMillis
  const ref = yield* SubscriptionRef.make<UpdateSnapshot>({
    currentVersion: deps.currentVersion,
    latestVersion: deps.devMode ? `${deps.currentVersion}-dev` : null,
    status: deps.devMode ? "available" : "idle",
    updateAvailable: Boolean(deps.devMode),
    lastCheckedAt: deps.devMode ? startedAt : null,
    error: null,
    installAction: "restart",
    reloadRequestedAt: null,
  })
  const current = SubscriptionRef.get(ref)
  const patch = (changes: Partial<UpdateSnapshot>) => SubscriptionRef.update(ref, (snapshot) => ({ ...snapshot, ...changes }))
  const track = (eventName: string, properties?: Record<string, unknown>) =>
    deps.trackEvent ? deps.trackEvent(eventName, properties) : Effect.void
  const checks = makeSharedRun<UpdateSnapshot>(scope)
  // One slot for all three installs: a stable install and a nightly one
  // must not run at the same time.
  const installs = makeSharedRun<UpdateInstallResult>(scope)

  const checkNightly = Effect.fn("UpdateManager.checkNightly")(function* () {
    const currentVersion = (yield* current).currentVersion
    if (!isNightlyVersion(currentVersion)) return undefined
    const failed = (error: string) => Effect.map(Clock.currentTimeMillis, (now): UpdateSnapshot["nightly"] => ({
      status: "error",
      latestCommitSha: null,
      lastCheckedAt: now,
      error,
    }))
    if (!deps.fetchLatestNightlySha) return yield* failed("This server cannot check nightly builds.")
    const installedSha = currentVersion.match(/-nightly\.([a-f0-9]{7,40})$/i)?.[1].toLowerCase()
    if (!installedSha) return yield* failed("The installed nightly has no valid commit ID.")
    const latest = yield* Effect.result(deps.fetchLatestNightlySha)
    if (Result.isFailure(latest)) return yield* failed(latest.failure.message)
    const latestCommitSha = latest.success.toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(latestCommitSha)) return yield* failed("GitHub returned an invalid commit ID.")
    const nightly: UpdateSnapshot["nightly"] = {
      status: latestCommitSha.startsWith(installedSha) ? "up_to_date" : "available",
      latestCommitSha,
      lastCheckedAt: yield* Clock.currentTimeMillis,
      error: null,
    }
    return nightly
  })

  const runCheck = Effect.fn("UpdateManager.runCheck")(function* () {
    // A failure from either service must not discard the other service's result.
    const [release, nightly] = yield* Effect.all(
      [Effect.result(deps.fetchLatestVersion(PACKAGE_NAME)), checkNightly()],
      { concurrency: "unbounded" },
    )
    const snapshot = yield* current
    // A check can finish after an install starts. Keep the install's status.
    if (isBusy(snapshot)) return snapshot
    const now = yield* Clock.currentTimeMillis
    if (Result.isFailure(release)) {
      const next: UpdateSnapshot = {
        ...snapshot,
        status: "error",
        lastCheckedAt: now,
        error: release.failure.message,
        reloadRequestedAt: null,
        nightly,
      }
      yield* SubscriptionRef.set(ref, next)
      yield* track("update_failed", { latest_version: next.latestVersion })
      return next
    }
    const latestVersion = release.success
    const updateAvailable = compareVersions(snapshot.currentVersion, latestVersion) < 0
    const next: UpdateSnapshot = {
      ...snapshot,
      latestVersion,
      updateAvailable,
      status: updateAvailable ? "available" : "up_to_date",
      lastCheckedAt: now,
      error: null,
      reloadRequestedAt: null,
      nightly,
    }
    yield* SubscriptionRef.set(ref, next)
    yield* track("update_checked", { latest_version: latestVersion })
    return next
  })

  const checkForUpdates = Effect.fn("UpdateManager.checkForUpdates")(function* (options: { readonly force?: boolean } = {}) {
    const snapshot = yield* current
    if (deps.devMode || isBusy(snapshot)) return snapshot
    const running = checks.current()
    if (Option.isSome(running)) return yield* Deferred.await(running.value)
    const now = yield* Clock.currentTimeMillis
    if (!options.force && snapshot.lastCheckedAt && now - snapshot.lastCheckedAt < UPDATE_CACHE_TTL_MS) {
      return snapshot
    }

    yield* SubscriptionRef.set(ref, {
      ...snapshot,
      status: "checking",
      error: null,
      reloadRequestedAt: null,
      nightly: isNightlyVersion(snapshot.currentVersion) ? {
        status: "checking",
        latestCommitSha: snapshot.nightly?.latestCommitSha ?? null,
        lastCheckedAt: snapshot.nightly?.lastCheckedAt ?? null,
        error: null,
      } : undefined,
    })
    return yield* checks.run(runCheck())
  })

  /** Install the newest release `fetchLatestVersion` reported, checking first if none is known. */
  const runInstall = Effect.fn("UpdateManager.runInstall")(function* () {
    if (!(yield* current).updateAvailable) {
      const checked = yield* checkForUpdates({ force: true })
      if (!checked.updateAvailable) return restartResult(false)
    }

    yield* patch({ status: "updating", error: null, reloadRequestedAt: null })

    const targetVersion = (yield* current).latestVersion
    if (!targetVersion) {
      yield* patch({ status: "error", error: "Unable to determine which version to install.", reloadRequestedAt: null })
      yield* track("update_failed", { latest_version: null })
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Update failed",
        userMessage: "Kanna could not determine which version to install.",
      } satisfies UpdateInstallResult
    }

    const installed = yield* deps.installVersion(PACKAGE_NAME, targetVersion)
    if (!installed.ok) {
      yield* patch({ status: "error", error: installed.userMessage ?? "Unable to install the latest version.", reloadRequestedAt: null })
      yield* track("update_failed", { latest_version: targetVersion })
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
      } satisfies UpdateInstallResult
    }

    yield* patch({
      currentVersion: targetVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: yield* Clock.currentTimeMillis,
    })
    yield* track("update_installed", { latest_version: targetVersion })
    return restartResult(true)
  })

  const runNightlyInstall = Effect.fn("UpdateManager.runNightlyInstall")(function* () {
    if (!deps.installNightly) {
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Nightly update unavailable",
        userMessage: "This build cannot install nightly versions.",
      } satisfies UpdateInstallResult
    }

    yield* patch({ status: "updating", error: null, reloadRequestedAt: null })

    const installed = yield* deps.installNightly
    if (!installed.ok) {
      yield* patch({ status: "error", error: installed.userMessage ?? "Unable to build the nightly version.", reloadRequestedAt: null })
      yield* track("update_nightly_failed", {})
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
      } satisfies UpdateInstallResult
    }

    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(ref, (snapshot): UpdateSnapshot => ({
      ...snapshot,
      currentVersion: installed.version ?? snapshot.currentVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: now,
    }))
    yield* track("update_nightly_installed", { nightly_version: installed.version })
    return restartResult(true)
  })

  const runStableReinstall = Effect.fn("UpdateManager.runStableReinstall")(function* () {
    yield* patch({ status: "updating", error: null, reloadRequestedAt: null })

    const latest = yield* Effect.result(deps.fetchLatestVersion(PACKAGE_NAME))
    if (Result.isFailure(latest)) {
      yield* patch({
        status: "error",
        error: `Could not look up the latest release: ${latest.failure.message}`,
        reloadRequestedAt: null,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Update failed",
        userMessage: "Kanna could not look up the latest published release.",
      } satisfies UpdateInstallResult
    }
    const latestVersion = latest.success

    const installed = yield* deps.installVersion(PACKAGE_NAME, latestVersion)
    if (!installed.ok) {
      yield* patch({ status: "error", error: installed.userMessage ?? "Unable to install the latest version.", reloadRequestedAt: null })
      yield* track("update_failed", { latest_version: latestVersion })
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
      } satisfies UpdateInstallResult
    }

    yield* patch({
      currentVersion: latestVersion,
      latestVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: yield* Clock.currentTimeMillis,
    })
    yield* track("update_stable_reinstalled", { latest_version: latestVersion })
    return restartResult(true)
  })

  /** Dev mode restarts into the same checkout: there is nothing to install. */
  const devRestart = Effect.gen(function* () {
    yield* patch({
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: yield* Clock.currentTimeMillis,
    })
    return restartResult(true)
  })

  /** Joins a running install, or starts `work` when none is running. */
  const install = (work: Effect.Effect<UpdateInstallResult>, busyResult: (snapshot: UpdateSnapshot) => UpdateInstallResult) =>
    Effect.gen(function* () {
      const snapshot = yield* current
      if (isBusy(snapshot)) return busyResult(snapshot)
      const running = installs.current()
      if (Option.isSome(running)) return yield* Deferred.await(running.value)
      return yield* installs.run(work)
    })

  const installUpdate = deps.devMode
    ? Effect.gen(function* () {
      yield* track("update_installed", { latest_version: (yield* current).latestVersion })
      yield* patch({ status: "updating", error: null, reloadRequestedAt: null })
      return yield* devRestart
    })
    : install(runInstall(), (snapshot) => restartResult(snapshot.updateAvailable))

  const installNightly = deps.devMode
    ? Effect.gen(function* () {
      yield* track("update_nightly_installed", { nightly_version: `${(yield* current).currentVersion}-dev` })
      return yield* devRestart
    })
    : install(runNightlyInstall(), () => restartResult(false))

  const installStable = deps.devMode
    ? devRestart
    : install(runStableReinstall(), () => restartResult(false))

  return {
    snapshot: current,
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    checkForUpdates,
    installUpdate: installUpdate.pipe(Effect.withSpan("UpdateManager.installUpdate")),
    installNightly: installNightly.pipe(Effect.withSpan("UpdateManager.installNightly")),
    installStable: installStable.pipe(Effect.withSpan("UpdateManager.installStable")),
  }
})
