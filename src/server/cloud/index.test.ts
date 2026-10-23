import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import type { StartedShareTunnel } from "../share"
import type { CloudIdentity } from "./identity"
import { createCloudRuntime } from "./index"
import { captureLogs, makeFakeCloudApiClient, settle, waitFor } from "./testing"

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

const TUNNEL_IDENTITY: CloudIdentity = {
  ...DIRECT_IDENTITY,
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  mode: undefined,
}

function createFakeApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  let offlines = 0
  const client = makeFakeCloudApiClient({
    heartbeat: (_token, update) => Effect.sync(() => {
      heartbeats.push(update)
    }),
    markOffline: () => Effect.sync(() => {
      offlines += 1
    }),
  })
  return { client, heartbeats, offlines: () => offlines }
}

describe("createCloudRuntime direct mode", () => {
  test("start runs the heartbeat loop, never a tunnel connector; stop marks offline", async () => {
    const api = createFakeApi()
    const runtime = createCloudRuntime(DIRECT_IDENTITY, {
      apiClient: api.client,
      supervisorDeps: {
        startTunnelImpl: () => {
          throw new Error("direct mode must not start a tunnel connector")
        },
      },
    })

    const ups: string[] = []
    await runTest(Effect.gen(function* () {
      yield* runtime.start({ localUrl: "http://localhost:3210", onTunnelUp: (kind) => ups.push(kind) })
      yield* waitFor(() => api.heartbeats.length === 1)
      expect(api.heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
      expect(ups).toEqual(["started"])

      // Idempotent start.
      yield* runtime.start({ localUrl: "http://localhost:3210" })
      expect(api.heartbeats.length).toBe(1)

      yield* runtime.stop
      expect(api.offlines()).toBe(1)
    }).pipe(Effect.provide(captureLogs().layer)))
  })
})

describe("createCloudRuntime tunnel mode", () => {
  test("stop takes the connector down, then marks offline", async () => {
    const api = createFakeApi()
    const events: string[] = []
    const startTunnelImpl = async (): Promise<StartedShareTunnel> => ({
      publicUrl: null,
      stop: () => events.push("connector stopped"),
    })
    const runtime = createCloudRuntime(TUNNEL_IDENTITY, {
      apiClient: makeFakeCloudApiClient({
        heartbeat: api.client.heartbeat,
        markOffline: () => Effect.sync(() => {
          events.push("marked offline")
        }),
      }),
      supervisorDeps: { startTunnelImpl },
    })

    await runTest(Effect.gen(function* () {
      yield* runtime.start({ localUrl: "http://localhost:3210" })
      yield* waitFor(() => api.heartbeats.length === 1)
      yield* runtime.stop
      expect(events).toEqual(["connector stopped", "marked offline"])

      // A second stop has nothing left to do.
      yield* runtime.stop
      expect(events).toHaveLength(2)
    }).pipe(Effect.provide(captureLogs().layer)))
  })

  test("stop gives up on an unreachable control plane after 2s", async () => {
    const runtime = createCloudRuntime(DIRECT_IDENTITY, {
      apiClient: makeFakeCloudApiClient({
        heartbeat: () => Effect.void,
        markOffline: () => Effect.never,
      }),
    })

    await runTest(Effect.gen(function* () {
      yield* runtime.start({ localUrl: "http://localhost:3210" })
      const stopping = yield* Effect.forkChild(runtime.stop)
      yield* settle
      yield* TestClock.adjust("1999 millis")
      yield* settle
      expect(stopping.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(stopping)
    }).pipe(Effect.provide(captureLogs().layer), Effect.provide(TestClock.layer())))
  })

  test("stop before start does not tell the control plane anything", async () => {
    const api = createFakeApi()
    const runtime = createCloudRuntime(TUNNEL_IDENTITY, { apiClient: api.client })
    await runTest(runtime.stop)
    expect(api.offlines()).toBe(0)
  })
})
