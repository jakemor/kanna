import { FileSystem, Context, Deferred, Effect, Layer, Schema } from "effect"
import {
  startShareTunnel,
  type CloudflaredInstallError,
  type ShareTunnelError,
  type ShareTunnelExitedError,
  type StartedShareTunnel,
} from "./share"

/**
 * One cloudflared quick tunnel per exposed local port.
 *
 * A port's link is `http://localhost:<port>`, which in cloud mode resolves
 * to the viewer's own machine. A quick tunnel gives the
 * port a public https URL that works from anywhere. Nothing here persists:
 * the tunnels are child processes, stopped when the layer closes, and a
 * forgotten public share is the main risk of this feature.
 *
 * Anyone with the URL can reach the port. trycloudflare hostnames are random
 * words, not an auth scheme.
 */

export interface ExposedPort {
  port: number
  publicUrl: string
}

export class InvalidPortError extends Schema.TaggedError<InvalidPortError>()(
  "@kanna/server/port-tunnels/InvalidPortError",
  { port: Schema.Number },
) {
  override get message() {
    return "Port is invalid."
  }
}

export class TunnelWithoutUrlError extends Schema.TaggedError<TunnelWithoutUrlError>()(
  "@kanna/server/port-tunnels/TunnelWithoutUrlError",
  { port: Schema.Number },
) {
  override get message() {
    return `Cloudflare tunnel for port ${this.port} started without a public URL.`
  }
}

export type StartTunnelError = CloudflaredInstallError | ShareTunnelError | ShareTunnelExitedError
export type ExposeError = InvalidPortError | TunnelWithoutUrlError | StartTunnelError

export interface PortTunnelsOptions {
  /** Starts cloudflared for a local URL. Defaults to a quick tunnel. */
  startTunnel?: (localUrl: string) => Effect.Effect<StartedShareTunnel, StartTunnelError>
}

export class PortTunnels extends Context.Service<PortTunnels, {
  /** The running tunnel's URL for the port, if any. */
  readonly publicUrl: (port: number) => Effect.Effect<string | undefined>
  readonly list: Effect.Effect<ReadonlyArray<ExposedPort>>
  /**
   * Start a tunnel for the port, or return the one already running. A second
   * call while the first is still connecting shares that attempt instead of
   * spawning a second cloudflared.
   */
  readonly expose: (port: number) => Effect.Effect<ExposedPort, ExposeError>
  readonly unexpose: (port: number) => Effect.Effect<{ ok: true; port: number }, InvalidPortError>
}>()("@kanna/server/PortTunnels") {
  static readonly layer = (options: PortTunnelsOptions = {}) => Layer.effect(this, makePortTunnels(options))
}

function validatePort(port: number) {
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? Effect.void
    : Effect.fail(new InvalidPortError({ port }))
}

const makePortTunnels = Effect.fn("PortTunnels.make")(function* (options: PortTunnelsOptions) {
  const fs = yield* FileSystem.FileSystem
  const startTunnel = options.startTunnel
    ?? ((localUrl: string) => startShareTunnel(localUrl, "quick").pipe(Effect.provideService(FileSystem.FileSystem, fs)))
  // Plain maps: every read and write is a synchronous step inside one effect.
  const tunnels = new Map<number, { publicUrl: string; stop: () => void }>()
  const pending = new Map<number, Deferred.Deferred<ExposedPort, ExposeError>>()
  const layerScope = yield* Effect.scope

  const stop = Effect.fn("PortTunnels.stop")(function* (port: number) {
    const tunnel = tunnels.get(port)
    if (!tunnel) return
    tunnels.delete(port)
    tunnel.stop()
    yield* Effect.logInfo(`stopped exposing port ${port}`)
  })

  // Shutdown stops every tunnel; an attempt still connecting is interrupted
  // with the layer's fibers, which stops its cloudflared too.
  yield* Effect.addFinalizer(() => Effect.forEach([...tunnels.keys()], stop, { discard: true }))

  /** Starts the tunnel and records it. Runs in the layer's scope, not the caller's. */
  const attempt = Effect.fn("PortTunnels.attempt")(function* (port: number) {
    const tunnel = yield* startTunnel(`http://localhost:${port}`)
    if (!tunnel.publicUrl) {
      tunnel.stop()
      return yield* new TunnelWithoutUrlError({ port })
    }
    const record = { publicUrl: tunnel.publicUrl, stop: tunnel.stop }
    tunnels.set(port, record)
    yield* Effect.logInfo(`exposed port ${port} at ${tunnel.publicUrl}`)
    // cloudflared can die on its own (rate limit, network). Drop the
    // record so the panel stops showing a URL that no longer answers.
    if (tunnel.exited) {
      yield* tunnel.exited.pipe(
        Effect.andThen(Effect.suspend(() => {
          if (tunnels.get(port) !== record) return Effect.void
          tunnels.delete(port)
          return Effect.logInfo(`tunnel for port ${port} exited`)
        })),
        Effect.forkIn(layerScope),
      )
    }
    return { port, publicUrl: tunnel.publicUrl }
  })

  const expose = Effect.fn("PortTunnels.expose")(function* (port: number) {
    yield* Effect.annotateCurrentSpan("port", port)
    yield* validatePort(port)
    const running = tunnels.get(port)
    if (running) return { port, publicUrl: running.publicUrl }
    const inFlight = pending.get(port)
    if (inFlight) return yield* Deferred.await(inFlight)

    const result = Deferred.makeUnsafe<ExposedPort, ExposeError>()
    pending.set(port, result)
    // Forked into the layer, so a caller that gives up (a closed socket)
    // doesn't take the attempt others may be waiting on with it.
    yield* attempt(port).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(result, exit)),
      Effect.onInterrupt(() => Deferred.interrupt(result)),
      Effect.ensuring(Effect.sync(() => pending.delete(port))),
      Effect.forkIn(layerScope),
    )
    return yield* Deferred.await(result)
  })

  const unexpose = Effect.fn("PortTunnels.unexpose")(function* (port: number) {
    yield* validatePort(port)
    yield* stop(port)
    return { ok: true as const, port }
  })

  return {
    publicUrl: (port: number) => Effect.sync(() => tunnels.get(port)?.publicUrl),
    list: Effect.sync(() => [...tunnels.entries()].map(([port, tunnel]) => ({ port, publicUrl: tunnel.publicUrl }))),
    expose,
    unexpose,
  }
})
