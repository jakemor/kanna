import type { UpdateInstallResult, UpdateSnapshot } from "../shared/types"
import { PACKAGE_NAME } from "../shared/branding"
import { compareVersions, type UpdateInstallAttemptResult } from "./cli-runtime"

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000

export interface UpdateManagerDeps {
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
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
    })

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

  private async runCheck() {
    try {
      const latestVersion = await this.deps.fetchLatestVersion(PACKAGE_NAME)
      const updateAvailable = compareVersions(this.snapshot.currentVersion, latestVersion) < 0
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
