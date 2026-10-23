import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Result, type Scope } from "effect"
import { runTest } from "./effect/testing"
import { PortTunnels, type PortTunnelsOptions } from "./port-tunnels"
import type { StartedShareTunnel } from "./share"

function createFakeTunnel(publicUrl: string | null) {
  const exited = Deferred.makeUnsafe<void>()
  let stopCalls = 0
  const tunnel: StartedShareTunnel = {
    publicUrl,
    stop: () => {
      stopCalls += 1
      Deferred.doneUnsafe(exited, Exit.void)
    },
    exited: Deferred.await(exited),
  }
  return {
    tunnel,
    exit: () => Deferred.doneUnsafe(exited, Exit.void),
    get stopCalls() {
      return stopCalls
    },
  }
}

const withTunnels = <A, E>(
  startTunnel: NonNullable<PortTunnelsOptions["startTunnel"]>,
  body: (tunnels: PortTunnels["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) => runTest(Effect.flatMap(Effect.service(PortTunnels), body).pipe(Effect.provide(PortTunnels.layer({ startTunnel }))))

describe("PortTunnels", () => {
  test("exposes a port once and reuses the running tunnel", async () => {
    const starts: string[] = []
    const fake = createFakeTunnel("https://one.trycloudflare.com")

    await withTunnels(
      (localUrl) => Effect.sync(() => {
        starts.push(localUrl)
        return fake.tunnel
      }),
      (tunnels) => Effect.gen(function* () {
        const first = yield* tunnels.expose(5000)
        const second = yield* tunnels.expose(5000)

        expect(first).toEqual({ port: 5000, publicUrl: "https://one.trycloudflare.com" })
        expect(second).toEqual(first)
        expect(starts).toEqual(["http://localhost:5000"])
        expect(yield* tunnels.publicUrl(5000)).toBe("https://one.trycloudflare.com")
        expect(yield* tunnels.list).toEqual([{ port: 5000, publicUrl: "https://one.trycloudflare.com" }])
      }),
    )
  })

  test("shares one attempt between concurrent expose calls", async () => {
    let starts = 0
    const fake = createFakeTunnel("https://one.trycloudflare.com")

    await withTunnels(
      () => Effect.sync(() => {
        starts += 1
      }).pipe(Effect.andThen(Effect.sleep("5 millis")), Effect.as(fake.tunnel)),
      (tunnels) => Effect.gen(function* () {
        const [a, b] = yield* Effect.all([tunnels.expose(5000), tunnels.expose(5000)], { concurrency: "unbounded" })

        expect(a).toEqual(b)
        expect(starts).toBe(1)
      }),
    )
  })

  test("unexpose stops the tunnel and forgets the URL", async () => {
    const fake = createFakeTunnel("https://one.trycloudflare.com")

    await withTunnels(
      () => Effect.succeed(fake.tunnel),
      (tunnels) => Effect.gen(function* () {
        yield* tunnels.expose(5000)
        expect(yield* tunnels.unexpose(5000)).toEqual({ ok: true, port: 5000 })

        expect(fake.stopCalls).toBe(1)
        expect(yield* tunnels.publicUrl(5000)).toBeUndefined()
        expect(yield* tunnels.unexpose(5000)).toEqual({ ok: true, port: 5000 })
        expect(fake.stopCalls).toBe(1)
      }),
    )
  })

  test("forgets a tunnel whose process exits on its own", async () => {
    const fake = createFakeTunnel("https://one.trycloudflare.com")

    await withTunnels(
      () => Effect.succeed(fake.tunnel),
      (tunnels) => Effect.gen(function* () {
        yield* tunnels.expose(5000)
        fake.exit()
        yield* Effect.sleep("10 millis")

        expect(yield* tunnels.publicUrl(5000)).toBeUndefined()
        expect(fake.stopCalls).toBe(0)
      }),
    )
  })

  test("rejects a tunnel that comes up without a URL", async () => {
    const fake = createFakeTunnel(null)

    await withTunnels(
      () => Effect.succeed(fake.tunnel),
      (tunnels) => Effect.gen(function* () {
        const result = yield* Effect.result(tunnels.expose(5000))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("@kanna/server/port-tunnels/TunnelWithoutUrlError")
          expect(result.failure.message).toContain("without a public URL")
        }
        expect(fake.stopCalls).toBe(1)
        expect(yield* tunnels.publicUrl(5000)).toBeUndefined()
      }),
    )
  })

  test("rejects invalid ports", async () => {
    await withTunnels(
      () => Effect.succeed(createFakeTunnel("https://x").tunnel),
      (tunnels) => Effect.gen(function* () {
        const exposed = yield* Effect.result(tunnels.expose(0))
        const unexposed = yield* Effect.result(tunnels.unexpose(70000))
        for (const failure of [Result.getFailure(exposed), Result.getFailure(unexposed)]) {
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value._tag).toBe("@kanna/server/port-tunnels/InvalidPortError")
            expect(failure.value.message).toBe("Port is invalid.")
          }
        }
      }),
    )
  })

  test("closing the layer stops every tunnel", async () => {
    const a = createFakeTunnel("https://a.trycloudflare.com")
    const b = createFakeTunnel("https://b.trycloudflare.com")

    await withTunnels(
      (localUrl) => Effect.succeed(localUrl.endsWith(":5000") ? a.tunnel : b.tunnel),
      (tunnels) => Effect.gen(function* () {
        yield* tunnels.expose(5000)
        yield* tunnels.expose(5001)
        expect(a.stopCalls).toBe(0)
      }),
    )

    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(1)
  })

  test("closing the layer interrupts an attempt still connecting", async () => {
    let interrupted = false

    await withTunnels(
      () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => {
        interrupted = true
      }))),
      (tunnels) => Effect.gen(function* () {
        yield* Effect.forkDetach(tunnels.expose(5000))
        yield* Effect.sleep("5 millis")
      }),
    )

    expect(interrupted).toBe(true)
  })

  test("a caller that gives up leaves the attempt to the others", async () => {
    const fake = createFakeTunnel("https://one.trycloudflare.com")
    const gate = Deferred.makeUnsafe<void>()

    await withTunnels(
      () => Deferred.await(gate).pipe(Effect.as(fake.tunnel)),
      (tunnels) => Effect.gen(function* () {
        const first = yield* Effect.forkChild(tunnels.expose(5000), { startImmediately: true })
        const second = yield* Effect.forkChild(tunnels.expose(5000), { startImmediately: true })
        yield* Fiber.interrupt(first)
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(second)).toEqual({ port: 5000, publicUrl: "https://one.trycloudflare.com" })
      }),
    )
  })
})
