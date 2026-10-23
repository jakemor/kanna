import { Effect, Layer } from "effect"
import { HttpHost, HttpListenError, type HttpListener, type HttpListenOptions } from "../http-host"

const isAddressInUse = (error: unknown) =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"

/**
 * `Bun.serve`. A Bun `ServerWebSocket` already is a `ClientSocket`, so the
 * handlers get Bun's own socket objects: the same object on open, message
 * and close.
 */
function listen<Data>(options: HttpListenOptions<Data>): Effect.Effect<HttpListener, HttpListenError> {
  return Effect.try({
    try: () => {
      const websocket = options.websocket
      const server = Bun.serve<Data>({
        port: options.port,
        hostname: options.hostname,
        idleTimeout: options.idleTimeoutSeconds,
        ...(options.error ? { error: (error: Error) => options.error!(error) } : {}),
        fetch: (request, server) => options.fetch(request, {
          // Bun types `upgrade`'s options by whether Data is undefined; Data is
          // generic here, so go through a plain signature.
          upgrade: (req, data) => (server.upgrade as (req: Request, options: { data: Data }) => boolean).call(server, req, { data }),
        }),
        websocket: websocket
          ? {
            ...(websocket.compressOutgoing ? { perMessageDeflate: { compress: "dedicated", decompress: "disable" } } : {}),
            open: (ws) => websocket.open(ws),
            message: (ws, message) => websocket.message(ws, message),
            close: (ws, code, reason) => websocket.close(ws, code, reason),
          }
          // Bun requires a websocket config whenever fetch may upgrade; a
          // listener without one never does.
          : { message: () => {} },
      })
      return {
        port: server.port ?? options.port,
        stop: (closeActiveConnections) => Effect.sync(() => {
          void server.stop(closeActiveConnections)
        }),
      } satisfies HttpListener
    },
    catch: (cause) => new HttpListenError({
      port: options.port,
      hostname: options.hostname,
      addressInUse: isAddressInUse(cause),
      cause,
    }),
  })
}

export const BunHttpHostLayer = Layer.succeed(HttpHost, { listen })
