import { Effect, Stream, SubscriptionRef } from "effect"
import type { UpdateInstallResult, UpdateSnapshot } from "../shared/types"
import type { UpdateManager } from "./update-manager"

const NOT_INSTALLED: UpdateInstallResult = { ok: false, action: "restart", errorCode: null, userTitle: null, userMessage: null }

/**
 * An in-memory `UpdateManager` for tests that hand one to the router or the
 * CLI. `check` and `install` stand in for the real check and install, and
 * return the snapshot or result to report; `set` changes the snapshot as if
 * the manager had.
 */
export function makeFakeUpdateManager(initial: UpdateSnapshot, options: {
  check?: (snapshot: UpdateSnapshot, force: boolean) => UpdateSnapshot
  install?: UpdateInstallResult
} = {}) {
  const ref = Effect.runSync(SubscriptionRef.make(initial))
  const install = Effect.succeed(options.install ?? NOT_INSTALLED)
  const updateManager: UpdateManager["Service"] = {
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    checkForUpdates: (checkOptions = {}) =>
      SubscriptionRef.updateAndGet(ref, (snapshot) => options.check?.(snapshot, Boolean(checkOptions.force)) ?? snapshot),
    installUpdate: install,
    installNightly: install,
    installStable: install,
  }
  return {
    updateManager,
    set: (snapshot: UpdateSnapshot) => SubscriptionRef.set(ref, snapshot),
  }
}
