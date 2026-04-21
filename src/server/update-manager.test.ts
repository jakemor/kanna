import { describe, expect, test } from "bun:test"
import { UpdateManager } from "./update-manager"
import { UpdateInstallError, type UpdateChecker, type UpdateReloader } from "./update-strategy"

class FakeChecker implements UpdateChecker {
  calls = 0
  constructor(private results: Array<{ latestVersion: string; updateAvailable: boolean }>) {}
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

  test("falls back to generic errorCode/userTitle when reloader throws a plain Error", async () => {
    const reloader = new FakeReloader(async () => {
      throw new Error("random failure")
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
      errorCode: "install_failed",
      userTitle: "Update failed",
      userMessage: "random failure",
    })
    expect(manager.getSnapshot().status).toBe("error")
    expect(manager.getSnapshot().error).toBe("random failure")
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
