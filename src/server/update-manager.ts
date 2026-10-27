import type { UpdateInstallResult, UpdateSnapshot } from "../shared/types"
import { isNightlyVersion } from "../shared/types"
import { PACKAGE_NAME } from "../shared/branding"
import { compareVersions, type UpdateInstallAttemptResult } from "./cli-runtime"
import type { NightlyInstallResult } from "./nightly"

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000

export interface UpdateManagerDeps {
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  fetchLatestNightlySha?: () => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  /** Build main from source and install it globally (see server/nightly.ts). */
  installNightly?: () => Promise<NightlyInstallResult>
  devMode?: boolean
  trackEvent?: (eventName: string, properties?: Record<string, unknown>) => void
  /**
   * Runs next to each check without being awaited: the cloudflared updater
   * rides along here (cloudflared-updater.ts) and adds no time to the check.
   */
  onCheck?: () => void
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

  getSnapshot() {
    return this.snapshot
  }

  onChange(listener: (snapshot: UpdateSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async checkForUpdates(options: { force?: boolean } = {}) {
    if (this.deps.devMode) {
      return this.snapshot
    }

    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") {
      return this.snapshot
    }

    if (this.checkPromise) {
      return this.checkPromise
    }

    if (!options.force && this.snapshot.lastCheckedAt && Date.now() - this.snapshot.lastCheckedAt < UPDATE_CACHE_TTL_MS) {
      return this.snapshot
    }

    this.setSnapshot({
      ...this.snapshot,
      status: "checking",
      error: null,
      reloadRequestedAt: null,
      nightly: isNightlyVersion(this.snapshot.currentVersion) ? {
        status: "checking",
        latestCommitSha: this.snapshot.nightly?.latestCommitSha ?? null,
        lastCheckedAt: this.snapshot.nightly?.lastCheckedAt ?? null,
        error: null,
      } : undefined,
    })

    try {
      this.deps.onCheck?.()
    } catch {}
    const checkPromise = this.runCheck()
    this.checkPromise = checkPromise

    try {
      return await checkPromise
    } finally {
      if (this.checkPromise === checkPromise) {
        this.checkPromise = null
      }
    }
  }

  async installUpdate(): Promise<UpdateInstallResult> {
    if (this.deps.devMode) {
      this.deps.trackEvent?.("update_installed", {
        latest_version: this.snapshot.latestVersion,
      })
      this.setSnapshot({
        ...this.snapshot,
        status: "updating",
        error: null,
        reloadRequestedAt: null,
      })

      this.setSnapshot({
        ...this.snapshot,
        status: "restart_pending",
        updateAvailable: false,
        error: null,
        reloadRequestedAt: Date.now(),
      })

      return {
        ok: true,
        action: "restart",
        errorCode: null,
        userTitle: null,
        userMessage: null,
      }
    }

    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") {
      return {
        ok: this.snapshot.updateAvailable,
        action: "restart",
        errorCode: null,
        userTitle: null,
        userMessage: null,
      }
    }

    if (this.installPromise) {
      return this.installPromise
    }

    const installPromise = this.runInstall()
    this.installPromise = installPromise

    try {
      return await installPromise
    } finally {
      if (this.installPromise === installPromise) {
        this.installPromise = null
      }
    }
  }

  /**
   * Build main from GitHub and restart into it. Uses the same busy/restart
   * plumbing as installUpdate; the stamped "-nightly.<sha>" version keeps the
   * base version's ordering, so the next published release upgrades a nightly
   * back to stable through the normal update path.
   */
  async installNightly(): Promise<UpdateInstallResult> {
    if (this.deps.devMode) {
      this.deps.trackEvent?.("update_nightly_installed", { nightly_version: `${this.snapshot.currentVersion}-dev` })
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
      return { ok: false, action: "restart", errorCode: null, userTitle: null, userMessage: null }
    }
    if (this.installPromise) {
      return this.installPromise
    }

    const installPromise = this.runNightlyInstall()
    this.installPromise = installPromise
    try {
      return await installPromise
    } finally {
      if (this.installPromise === installPromise) {
        this.installPromise = null
      }
    }
  }

  /**
   * Reinstall the latest published release even when the version number
   * matches the running one — the way back from a nightly build without
   * waiting for the next release.
   */
  async installStable(): Promise<UpdateInstallResult> {
    if (this.deps.devMode) {
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
      return { ok: false, action: "restart", errorCode: null, userTitle: null, userMessage: null }
    }
    if (this.installPromise) {
      return this.installPromise
    }

    const installPromise = this.runStableReinstall()
    this.installPromise = installPromise
    try {
      return await installPromise
    } finally {
      if (this.installPromise === installPromise) {
        this.installPromise = null
      }
    }
  }

  private async runNightlyInstall(): Promise<UpdateInstallResult> {
    if (!this.deps.installNightly) {
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Nightly update unavailable",
        userMessage: "This build cannot install nightly versions.",
      }
    }

    this.setSnapshot({
      ...this.snapshot,
      status: "updating",
      error: null,
      reloadRequestedAt: null,
    })

    const installed = await this.deps.installNightly()
    if (!installed.ok) {
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: installed.userMessage ?? "Unable to build the nightly version.",
        reloadRequestedAt: null,
      })
      this.deps.trackEvent?.("update_nightly_failed", {})
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
      }
    }

    this.setSnapshot({
      ...this.snapshot,
      currentVersion: installed.version ?? this.snapshot.currentVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: Date.now(),
    })
    this.deps.trackEvent?.("update_nightly_installed", {
      nightly_version: installed.version,
    })
    return { ok: true, action: "restart", errorCode: null, userTitle: null, userMessage: null }
  }

  private async runStableReinstall(): Promise<UpdateInstallResult> {
    this.setSnapshot({
      ...this.snapshot,
      status: "updating",
      error: null,
      reloadRequestedAt: null,
    })

    let latestVersion: string
    try {
      latestVersion = await this.deps.fetchLatestVersion(PACKAGE_NAME)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: `Could not look up the latest release: ${message}`,
        reloadRequestedAt: null,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Update failed",
        userMessage: "Kanna could not look up the latest published release.",
      }
    }

    const installed = this.deps.installVersion(PACKAGE_NAME, latestVersion)
    if (!installed.ok) {
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: installed.userMessage ?? "Unable to install the latest version.",
        reloadRequestedAt: null,
      })
      this.deps.trackEvent?.("update_failed", {
        latest_version: latestVersion,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
      }
    }

    this.setSnapshot({
      ...this.snapshot,
      currentVersion: latestVersion,
      latestVersion,
      status: "restart_pending",
      updateAvailable: false,
      error: null,
      reloadRequestedAt: Date.now(),
    })
    this.deps.trackEvent?.("update_stable_reinstalled", {
      latest_version: latestVersion,
    })
    return { ok: true, action: "restart", errorCode: null, userTitle: null, userMessage: null }
  }

  private async checkNightly(): Promise<UpdateSnapshot["nightly"]> {
    if (!isNightlyVersion(this.snapshot.currentVersion)) return undefined
    try {
      if (!this.deps.fetchLatestNightlySha) throw new Error("This server cannot check nightly builds.")
      const installedSha = this.snapshot.currentVersion.match(/-nightly\.([a-f0-9]{7,40})$/i)?.[1].toLowerCase()
      if (!installedSha) throw new Error("The installed nightly has no valid commit ID.")
      const latestCommitSha = (await this.deps.fetchLatestNightlySha()).toLowerCase()
      if (!/^[a-f0-9]{40}$/.test(latestCommitSha)) throw new Error("GitHub returned an invalid commit ID.")
      return {
        status: latestCommitSha.startsWith(installedSha) ? "up_to_date" : "available",
        latestCommitSha,
        lastCheckedAt: Date.now(),
        error: null,
      }
    } catch (error) {
      return {
        status: "error",
        latestCommitSha: null,
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async runCheck() {
    // A failure from either service must not discard the other service's result.
    const [release, nightly] = await Promise.allSettled([
      this.deps.fetchLatestVersion(PACKAGE_NAME),
      this.checkNightly(),
    ])
    // A check can finish after an install starts. Keep the install's status.
    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") return this.snapshot
    const nightlySnapshot = nightly.status === "fulfilled" ? nightly.value : undefined
    try {
      if (release.status === "rejected") throw release.reason
      const latestVersion = release.value
      const updateAvailable = compareVersions(this.snapshot.currentVersion, latestVersion) < 0
      const nextSnapshot: UpdateSnapshot = {
        ...this.snapshot,
        latestVersion,
        updateAvailable,
        status: updateAvailable ? "available" : "up_to_date",
        lastCheckedAt: Date.now(),
        error: null,
        reloadRequestedAt: null,
        nightly: nightlySnapshot,
      }
      this.setSnapshot(nextSnapshot)
      this.deps.trackEvent?.("update_checked", {
        latest_version: latestVersion,
      })
      return nextSnapshot
    } catch (error) {
      const nextSnapshot: UpdateSnapshot = {
        ...this.snapshot,
        status: "error",
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        reloadRequestedAt: null,
        nightly: nightlySnapshot,
      }
      this.setSnapshot(nextSnapshot)
      this.deps.trackEvent?.("update_failed", {
        latest_version: this.snapshot.latestVersion,
      })
      return nextSnapshot
    }
  }

  private async runInstall(): Promise<UpdateInstallResult> {
    if (!this.snapshot.updateAvailable) {
      const snapshot = await this.checkForUpdates({ force: true })
      if (!snapshot.updateAvailable) {
        return {
          ok: false,
          action: "restart",
          errorCode: null,
          userTitle: null,
          userMessage: null,
        }
      }
    }

    this.setSnapshot({
      ...this.snapshot,
      status: "updating",
      error: null,
      reloadRequestedAt: null,
    })

    const targetVersion = this.snapshot.latestVersion
    if (!targetVersion) {
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: "Unable to determine which version to install.",
        reloadRequestedAt: null,
      })
      this.deps.trackEvent?.("update_failed", {
        latest_version: null,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: "install_failed",
        userTitle: "Update failed",
        userMessage: "Kanna could not determine which version to install.",
      }
    }

    const installed = this.deps.installVersion(PACKAGE_NAME, targetVersion)
    if (!installed.ok) {
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: installed.userMessage ?? "Unable to install the latest version.",
        reloadRequestedAt: null,
      })
      this.deps.trackEvent?.("update_failed", {
        latest_version: targetVersion,
      })
      return {
        ok: false,
        action: "restart",
        errorCode: installed.errorCode,
        userTitle: installed.userTitle,
        userMessage: installed.userMessage,
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
    this.deps.trackEvent?.("update_installed", {
      latest_version: targetVersion,
    })
    return {
      ok: true,
      action: "restart",
      errorCode: null,
      userTitle: null,
      userMessage: null,
    }
  }

  private setSnapshot(snapshot: UpdateSnapshot) {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
