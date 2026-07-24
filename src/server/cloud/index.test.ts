import { describe, expect, test } from "bun:test"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import type { CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { createCloudRuntime } from "./index"

const DIRECT_IDENTITY: CloudIdentity = {
  controlUrl: DEFAULT_CLOUD_CONTROL_URL,
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-box",
  appOrigin: "https://jakemor-box.kanna.sh",
  tunnelToken: "",
  tunnelHost: "3210-sbx123.e2b.app",
  enabled: true,
  mode: "direct",
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(2)
  }
}

describe("createCloudRuntime direct mode", () => {
  test("start() runs the heartbeat loop, never a tunnel connector; stop() marks offline", async () => {
    const heartbeats: CloudHeartbeatRequest[] = []
    let offlines = 0
    const apiClient: CloudApiClient = {
      controlUrl: DEFAULT_CLOUD_CONTROL_URL,
      pair: async () => {
        throw new Error("not used")
      },
      heartbeat: async (_token, update) => {
        heartbeats.push(update)
      },
      markOffline: async () => {
        offlines += 1
      },
      removeMachine: async () => {},
    }

    const runtime = createCloudRuntime(DIRECT_IDENTITY, {
      apiClient,
      supervisorDeps: {
        startTunnelImpl: () => {
          throw new Error("direct mode must not start a tunnel connector")
        },
      },
      heartbeatDeps: { sleepImpl: () => new Promise(() => {}) },
    })

    const ups: string[] = []
    runtime.start({ localUrl: "http://localhost:3210", onTunnelUp: (kind) => ups.push(kind) })
    await waitFor(() => heartbeats.length === 1)
    expect(heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
    expect(ups).toEqual(["started"])

    // Idempotent start.
    runtime.start({ localUrl: "http://localhost:3210" })
    expect(heartbeats.length).toBe(1)

    await runtime.stop()
    expect(offlines).toBe(1)
  })
})
