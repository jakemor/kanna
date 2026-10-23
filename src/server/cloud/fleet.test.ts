import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { runTest } from "../effect/testing"
import type { CloudIdentity } from "./identity"
import { CloudFleet } from "./fleet"

const IDENTITY: CloudIdentity = {
  controlUrl: "http://cp/api/cloud",
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jake-mbp",
  appOrigin: "https://jake-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

const MACHINE = {
  subdomain: "jake-studio",
  name: "Studio",
  appOrigin: "https://jake-studio.kanna.sh",
  online: true,
  lastSeenAt: 1,
}

describe("CloudFleet", () => {
  test("asks the control plane with the machine token, then caches", async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") })
      return Response.json({ self: "jake-mbp", machines: [MACHINE] })
    }) as unknown as typeof fetch

    await runTest(Effect.gen(function* () {
      const fleet = yield* CloudFleet
      expect(yield* fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [MACHINE] })
      yield* fleet.get(IDENTITY)
      expect(calls).toEqual([{ url: "http://cp/api/cloud/fleet", auth: "Bearer machine-token" }])

      yield* TestClock.adjust("20 seconds")
      yield* fleet.get(IDENTITY)
      expect(calls).toHaveLength(2)
    }).pipe(Effect.provide(CloudFleet.layer({ fetchImpl })), Effect.provide(TestClock.layer())))
  })

  test("unpaired is empty; a failing control plane still names this machine", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch

    await runTest(Effect.gen(function* () {
      const fleet = yield* CloudFleet
      expect(yield* fleet.get(null)).toEqual({ self: null, machines: [] })
      expect(yield* fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [] })
    }).pipe(Effect.provide(CloudFleet.layer({ fetchImpl }))))
  })

  test("an unreachable control plane or a malformed body falls back to this machine", async () => {
    let mode: "throw" | "malformed" = "throw"
    const fetchImpl = (async () => {
      if (mode === "throw") throw new TypeError("Unable to connect")
      return Response.json({ self: "jake-mbp", machines: "not-a-list" })
    }) as unknown as typeof fetch

    await runTest(Effect.gen(function* () {
      const fleet = yield* CloudFleet
      expect(yield* fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [] })
      mode = "malformed"
      yield* TestClock.adjust("20 seconds")
      expect(yield* fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [] })
    }).pipe(Effect.provide(CloudFleet.layer({ fetchImpl })), Effect.provide(TestClock.layer())))
  })

  test("concurrent callers share one request", async () => {
    let requests = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async () => {
      requests += 1
      await gate
      return Response.json({ self: "jake-mbp", machines: [MACHINE] })
    }) as unknown as typeof fetch

    await runTest(Effect.gen(function* () {
      const fleet = yield* CloudFleet
      const first = yield* Effect.forkChild(fleet.get(IDENTITY))
      const second = yield* Effect.forkChild(fleet.get(IDENTITY))
      yield* Effect.promise(() => Bun.sleep(10))
      release()
      expect(yield* Fiber.join(first)).toEqual({ self: "jake-mbp", machines: [MACHINE] })
      expect(yield* Fiber.join(second)).toEqual({ self: "jake-mbp", machines: [MACHINE] })
      expect(requests).toBe(1)
    }).pipe(Effect.provide(CloudFleet.layer({ fetchImpl }))))
  })
})
