import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { runTest } from "./effect/testing"
import { PackageRegistryError } from "./cli-runtime"
import { MainCommitLookupError } from "./nightly"
import { UpdateManager, type UpdateManagerDeps } from "./update-manager"
import type { UpdateSnapshot } from "../shared/types"

const NIGHTLY_SHA = `abc1234${"0".repeat(33)}`

const installed = () => Effect.succeed({ ok: true, errorCode: null, userTitle: null, userMessage: null })

const registryError = (message: string) =>
  new PackageRegistryError({ packageName: "kanna-code", message, cause: new Error(message) })

/** The real service, built from its layer for the rest of the test. */
const makeManager = (deps: UpdateManagerDeps) =>
  Effect.map(Layer.build(UpdateManager.layer(deps)), (context) => Context.get(context, UpdateManager))

function nightlyDeps(overrides: Partial<UpdateManagerDeps> = {}): UpdateManagerDeps {
  return {
    currentVersion: "0.69.0-nightly.abc1234",
    fetchLatestVersion: () => Effect.succeed("0.69.0"),
    fetchLatestNightlySha: Effect.succeed(NIGHTLY_SHA),
    installVersion: installed,
    ...overrides,
  }
}

function recordEvents() {
  const events: Array<{ name: string; properties?: Record<string, unknown> }> = []
  const trackEvent = (name: string, properties?: Record<string, unknown>) => Effect.sync(() => {
    events.push({ name, properties })
  })
  return { events, trackEvent }
}

describe("nightly update checks", () => {
  test.each([
    [NIGHTLY_SHA, "up_to_date"],
    [`def5678${"0".repeat(33)}`, "available"],
  ])("compares the installed commit with %s", (latestSha, status) => runTest(Effect.gen(function* () {
    const manager = yield* makeManager(nightlyDeps({ fetchLatestNightlySha: Effect.succeed(latestSha) }))
    const snapshot = yield* manager.checkForUpdates()
    expect(snapshot.nightly).toMatchObject({ status, latestCommitSha: latestSha, error: null })
    expect(snapshot.nightly?.lastCheckedAt).toBeNumber()
    expect(snapshot.status).toBe("up_to_date")
    expect(snapshot.updateAvailable).toBe(false)
  })))

  test("shows checking while GitHub responds and shares concurrent checks", () => runTest(Effect.gen(function* () {
    const response = yield* Deferred.make<string>()
    let calls = 0
    const manager = yield* makeManager(nightlyDeps({
      fetchLatestNightlySha: Effect.suspend(() => {
        calls += 1
        return Deferred.await(response)
      }),
    }))
    const first = yield* Effect.forkChild(manager.checkForUpdates())
    const second = yield* Effect.forkChild(manager.checkForUpdates({ force: true }))
    yield* Effect.yieldNow
    expect((yield* manager.snapshot).nightly?.status).toBe("checking")
    yield* Deferred.succeed(response, NIGHTLY_SHA)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(calls).toBe(1)
    expect((yield* manager.snapshot).nightly?.status).toBe("up_to_date")
  })))

  test("caches GitHub checks and lets Check again detect a new commit", () => runTest(Effect.gen(function* () {
    let calls = 0
    const manager = yield* makeManager(nightlyDeps({
      fetchLatestNightlySha: Effect.sync(() => {
        calls += 1
        return calls === 1 ? NIGHTLY_SHA : `def5678${"0".repeat(33)}`
      }),
    }))
    yield* manager.checkForUpdates()
    yield* manager.checkForUpdates()
    expect(calls).toBe(1)
    yield* manager.checkForUpdates({ force: true })
    expect(calls).toBe(2)
    expect((yield* manager.snapshot).nightly?.status).toBe("available")
  })))

  test("clears the previous result if GitHub becomes unavailable", () => runTest(Effect.gen(function* () {
    let fail = false
    const manager = yield* makeManager(nightlyDeps({
      fetchLatestNightlySha: Effect.suspend(() => fail
        ? Effect.fail(new MainCommitLookupError({ repo: "jakemor/kanna", message: "GitHub returned 403", cause: 403 }))
        : Effect.succeed(NIGHTLY_SHA)),
    }))
    yield* manager.checkForUpdates()
    fail = true
    const snapshot = yield* manager.checkForUpdates({ force: true })
    expect(snapshot.nightly).toMatchObject({ status: "error", latestCommitSha: null, error: "GitHub returned 403" })
    expect(snapshot.status).toBe("up_to_date")
  })))

  test("keeps the nightly result if npm fails", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager(nightlyDeps({ fetchLatestVersion: () => Effect.fail(registryError("npm unavailable")) }))
    const snapshot = yield* manager.checkForUpdates()
    expect(snapshot.nightly?.status).toBe("up_to_date")
    expect(snapshot.status).toBe("error")
    expect(snapshot.error).toBe("npm unavailable")
  })))

  test("does not query GitHub for stable installs", () => runTest(Effect.gen(function* () {
    let calls = 0
    const manager = yield* makeManager(nightlyDeps({
      currentVersion: "0.69.0",
      fetchLatestNightlySha: Effect.sync(() => {
        calls += 1
        return NIGHTLY_SHA
      }),
    }))
    const snapshot = yield* manager.checkForUpdates()
    expect(calls).toBe(0)
    expect(snapshot.nightly).toBeUndefined()
  })))

  test("reports unknown status when the installed commit is invalid", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager(nightlyDeps({ currentVersion: "0.69.0-nightly.invalid" }))
    expect((yield* manager.checkForUpdates()).nightly?.status).toBe("error")
  })))

  test("does not replace restart status when an earlier check finishes", () => runTest(Effect.gen(function* () {
    const response = yield* Deferred.make<string>()
    const manager = yield* makeManager(nightlyDeps({
      fetchLatestNightlySha: Deferred.await(response),
      installNightly: Effect.succeed({
        ok: true, errorCode: null, userTitle: null, userMessage: null, version: "0.69.0-nightly.def5678",
      }),
    }))
    const checking = yield* Effect.forkChild(manager.checkForUpdates())
    yield* Effect.yieldNow
    yield* manager.installNightly
    yield* Deferred.succeed(response, NIGHTLY_SHA)
    yield* Fiber.join(checking)
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("restart_pending")
    expect(snapshot.currentVersion).toBe("0.69.0-nightly.def5678")
  })))
})

describe("UpdateManager", () => {
  test("tracks update lifecycle events", () => runTest(Effect.gen(function* () {
    const { events, trackEvent } = recordEvents()
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: installed,
      trackEvent,
    })

    yield* manager.checkForUpdates({ force: true })
    yield* manager.installUpdate

    expect(events).toEqual([
      {
        name: "update_checked",
        properties: {
          latest_version: "0.13.0",
        },
      },
      {
        name: "update_installed",
        properties: {
          latest_version: "0.13.0",
        },
      },
    ])
  })))

  test("detects available updates", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: installed,
    })

    const snapshot = yield* manager.checkForUpdates({ force: true })

    expect(snapshot.status).toBe("available")
    expect(snapshot.updateAvailable).toBe(true)
    expect(snapshot.latestVersion).toBe("0.13.0")
    expect(snapshot.installAction).toBe("restart")
    expect(snapshot.reloadRequestedAt).toBeNull()
  })))

  test("bypasses cache when force is true", () => runTest(Effect.gen(function* () {
    let calls = 0
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.sync(() => {
        calls += 1
        return calls === 1 ? "0.12.1" : "0.13.0"
      }),
      installVersion: installed,
    })

    yield* manager.checkForUpdates()
    yield* manager.checkForUpdates({ force: true })

    expect(calls).toBe(2)
    expect((yield* manager.snapshot).latestVersion).toBe("0.13.0")
  })))

  test("surfaces install failures without clearing the running version", () => runTest(Effect.gen(function* () {
    let installedVersion: string | null = null
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: (_packageName, version) => Effect.sync(() => {
        installedVersion = version
        return {
          ok: false,
          errorCode: "version_not_live_yet" as const,
          userTitle: "Update not live yet",
          userMessage: "This update is still propagating. Try again in a few minutes.",
        }
      }),
    })

    const result = yield* manager.installUpdate

    expect(result).toEqual({
      ok: false,
      action: "restart",
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
      userMessage: "This update is still propagating. Try again in a few minutes.",
    })
    expect(installedVersion === "0.13.0").toBe(true)
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("error")
    expect(snapshot.currentVersion).toBe("0.12.0")
  })))

  test("an install with nothing newer to install installs nothing", () => runTest(Effect.gen(function* () {
    let installs = 0
    const manager = yield* makeManager({
      currentVersion: "0.13.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: () => Effect.sync(() => {
        installs += 1
        return { ok: true, errorCode: null, userTitle: null, userMessage: null }
      }),
    })

    expect((yield* manager.installUpdate).ok).toBe(false)
    expect(installs).toBe(0)
    expect((yield* manager.snapshot).status).toBe("up_to_date")
  })))

  test("installs started together share one install", () => runTest(Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    let installs = 0
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: () => Effect.gen(function* () {
        installs += 1
        yield* Deferred.await(release)
        return { ok: true, errorCode: null, userTitle: null, userMessage: null }
      }),
    })

    const updating = yield* manager.changes.pipe(
      Stream.filter((snapshot) => snapshot.status === "updating"),
      Stream.runHead,
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    const first = yield* Effect.forkChild(manager.installUpdate)
    const second = yield* Effect.forkChild(manager.installUpdate)
    yield* Fiber.join(updating)
    // Another kind of install while this one runs: the manager is busy.
    expect((yield* manager.installStable).ok).toBe(false)
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(first)).ok).toBe(true)
    expect((yield* Fiber.join(second)).ok).toBe(true)
    expect(installs).toBe(1)
  })))

  test("installNightly builds main and moves to restart_pending with the stamped version", () => runTest(Effect.gen(function* () {
    const { events, trackEvent } = recordEvents()
    const manager = yield* makeManager({
      currentVersion: "0.56.7",
      fetchLatestVersion: () => Effect.succeed("0.56.7"),
      installVersion: installed,
      installNightly: Effect.succeed({
        ok: true,
        errorCode: null,
        userTitle: null,
        userMessage: null,
        version: "0.56.7-nightly.abc1234",
      }),
      trackEvent,
    })

    const result = yield* manager.installNightly

    expect(result.ok).toBe(true)
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("restart_pending")
    expect(snapshot.currentVersion).toBe("0.56.7-nightly.abc1234")
    expect(typeof snapshot.reloadRequestedAt).toBe("number")
    expect(events).toEqual([
      { name: "update_nightly_installed", properties: { nightly_version: "0.56.7-nightly.abc1234" } },
    ])
  })))

  test("installNightly surfaces build failures without touching the running version", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.56.7",
      fetchLatestVersion: () => Effect.succeed("0.56.7"),
      installVersion: installed,
      installNightly: Effect.succeed({
        ok: false,
        errorCode: "install_failed",
        userTitle: "Nightly update failed",
        userMessage: "Nightly build step failed.",
        version: null,
      }),
    })

    const result = yield* manager.installNightly

    expect(result.ok).toBe(false)
    expect(result.userTitle).toBe("Nightly update failed")
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("error")
    expect(snapshot.currentVersion).toBe("0.56.7")
  })))

  test("installNightly reports unavailable when the build hook is missing", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.56.7",
      fetchLatestVersion: () => Effect.succeed("0.56.7"),
      installVersion: installed,
    })

    const result = yield* manager.installNightly
    expect(result.ok).toBe(false)
    expect(result.userTitle).toBe("Nightly update unavailable")
  })))

  test("installStable reinstalls the latest release even when versions match", () => runTest(Effect.gen(function* () {
    // The way back from a nightly build: the stripped nightly version equals
    // the published release, so the normal update path would refuse.
    let installedVersion: string | null = null
    const manager = yield* makeManager({
      currentVersion: "0.56.7-nightly.abc1234",
      fetchLatestVersion: () => Effect.succeed("0.56.7"),
      installVersion: (_packageName, version) => Effect.sync(() => {
        installedVersion = version
        return { ok: true, errorCode: null, userTitle: null, userMessage: null }
      }),
    })

    const result = yield* manager.installStable

    expect(result.ok).toBe(true)
    expect(installedVersion === "0.56.7").toBe(true)
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("restart_pending")
    expect(snapshot.currentVersion).toBe("0.56.7")
  })))

  test("installStable reports a registry that can't be reached", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.56.7-nightly.abc1234",
      fetchLatestVersion: () => Effect.fail(registryError("registry returned 503")),
      installVersion: installed,
    })

    const result = yield* manager.installStable

    expect(result).toMatchObject({ ok: false, errorCode: "install_failed", userTitle: "Update failed" })
    expect(yield* manager.snapshot).toMatchObject({ status: "error", error: "Could not look up the latest release: registry returned 503" })
  })))

  test("always exposes an available reload action in dev mode", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("9.9.9"),
      installVersion: installed,
      devMode: true,
    })

    expect(yield* manager.snapshot).toMatchObject({
      status: "available",
      updateAvailable: true,
      installAction: "restart",
      reloadRequestedAt: null,
    })

    const result = yield* manager.installUpdate
    expect(result).toEqual({
      ok: true,
      action: "restart",
      errorCode: null,
      userTitle: null,
      userMessage: null,
    })
    const snapshot = yield* manager.snapshot
    expect(snapshot.status).toBe("restart_pending")
    expect(typeof snapshot.reloadRequestedAt).toBe("number")
  })))

  test("changes emits each later snapshot, not the current one", () => runTest(Effect.gen(function* () {
    const manager = yield* makeManager({
      currentVersion: "0.12.0",
      fetchLatestVersion: () => Effect.succeed("0.13.0"),
      installVersion: installed,
    })
    const seen = yield* manager.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
    yield* Effect.yieldNow
    yield* manager.checkForUpdates({ force: true })
    const statuses = Array.from(yield* Fiber.join(seen), (snapshot: UpdateSnapshot) => snapshot.status)
    expect(statuses).toEqual(["checking", "available"])
  })))
})
