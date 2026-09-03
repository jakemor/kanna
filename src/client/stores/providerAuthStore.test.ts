import { describe, expect, test } from "bun:test"
import type { AuthServiceSnapshot, ProviderAuthSnapshot } from "../../shared/types"
import { getSetupLaunchAction } from "./providerAuthStore"

function service(
  id: AuthServiceSnapshot["service"],
  authStatus: AuthServiceSnapshot["authStatus"],
): AuthServiceSnapshot {
  return {
    service: id,
    label: id,
    installed: authStatus !== "not_installed",
    version: null,
    latestVersion: null,
    authStatus,
    account: null,
    statusDetail: null,
    checkedAt: 1,
    installState: "idle",
    installError: null,
    login: { phase: "idle" },
  }
}

function snapshotWith(status: AuthServiceSnapshot["authStatus"]): ProviderAuthSnapshot {
  return {
    services: (["claude", "codex", "cursor", "opencode", "gh", "openrouter"] as const).map((id) =>
      service(id, status),
    ),
  }
}

const FLAGS = {
  setupLoaded: true,
  setupShown: false,
  setupCompleted: false,
  setupDismissed: false,
}

describe("getSetupLaunchAction", () => {
  test("waits for the machine's settings before deciding anything", () => {
    // A fresh browser starts with every flag false; acting on that would
    // re-run onboarding per browser instead of per machine.
    const unloaded = { ...FLAGS, setupLoaded: false }
    expect(getSetupLaunchAction(null, unloaded)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("signed_in"), unloaded)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("signed_out"), unloaded)).toBe("wait")
  })

  test("a machine that finished setup never re-onboards a new browser", () => {
    const completed = { ...FLAGS, setupShown: true, setupCompleted: true }
    expect(getSetupLaunchAction(null, completed)).toBe("none")
    // Even with services since signed out, a completed machine stays quiet.
    expect(getSetupLaunchAction(snapshotWith("signed_out"), completed)).toBe("none")
  })

  test("first-ever launch opens instantly, before any probe resolves", () => {
    expect(getSetupLaunchAction(null, FLAGS)).toBe("open")
    expect(getSetupLaunchAction(snapshotWith("unknown"), FLAGS)).toBe("open")
  })

  test("completed or dismissed setups never auto-launch", () => {
    expect(getSetupLaunchAction(null, { ...FLAGS, setupCompleted: true })).toBe("none")
    expect(getSetupLaunchAction(null, { ...FLAGS, setupDismissed: true })).toBe("none")
  })

  test("after a first showing, launches wait for the probe round", () => {
    const shown = { ...FLAGS, setupShown: true }
    expect(getSetupLaunchAction(null, shown)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("unknown"), shown)).toBe("wait")
    // Resolved with something missing → re-open; fully connected → stay quiet.
    expect(getSetupLaunchAction(snapshotWith("signed_out"), shown)).toBe("open")
    expect(getSetupLaunchAction(snapshotWith("signed_in"), shown)).toBe("none")
  })
})
