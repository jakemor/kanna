import { Context, type Effect, Schema } from "effect"

/**
 * One browser or app connection, as the router sees it. Locally a Bun
 * `ServerWebSocket`; a Durable Object binding wraps its own WebSocket.
 */
export interface ClientSocket<Data> {
  /** Per-connection state the router keeps, set at upgrade. */
  readonly data: Data
  /**
   * Sends a text frame. `compress` asks for per-message deflate, which only
   * happens when the connection negotiated it.
   */
  send(payload: string, compress?: boolean): void
  close(code?: number, reason?: string): void
}

export interface HttpRequestContext<Data> {
  /** Upgrades `request` to a WebSocket carrying `data`; false when it isn't an upgrade request. */
  readonly upgrade: (request: Request, data: Data) => boolean
}

export interface WebSocketHandlers<Data> {
  /**
   * Compress frames the server sends (when the client offers it), never
   * inflate what clients send. See server.ts for why one direction only.
   */
  readonly compressOutgoing?: boolean
  readonly open: (socket: ClientSocket<Data>) => void
  readonly message: (socket: ClientSocket<Data>, message: string | Uint8Array) => void
  readonly close: (socket: ClientSocket<Data>, code: number, reason: string) => void
}

export interface HttpListenOptions<Data> {
  /** 0 picks a free port. */
  readonly port: number
  readonly hostname?: string
  /** Seconds a connection may sit idle. 0 never times out. */
  readonly idleTimeoutSeconds?: number
  /** Answers a request. Undefined means the request was upgraded to a WebSocket. */
  readonly fetch: (request: Request, context: HttpRequestContext<Data>) => Response | undefined | Promise<Response | undefined>
  /** Answers a request whose `fetch` threw or rejected. */
  readonly error?: (error: unknown) => Response
  readonly websocket?: WebSocketHandlers<Data>
}

export interface HttpListener {
  readonly port: number
  /** Stops listening; `closeActiveConnections` also drops open requests and sockets. */
  readonly stop: (closeActiveConnections?: boolean) => Effect.Effect<void>
}

/** The listener couldn't start. `addressInUse` lets callers try the next port. */
export class HttpListenError extends Schema.TaggedError<HttpListenError>()(
  "@kanna/server/platform/HttpListenError",
  {
    port: Schema.Number,
    hostname: Schema.optional(Schema.String),
    addressInUse: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

/**
 * Serves HTTP and WebSockets. Locally `Bun.serve`; a Durable Object binding
 * hands its `fetch` and WebSocket events to the same handlers instead of
 * listening on a port.
 */
export class HttpHost extends Context.Service<HttpHost, {
  readonly listen: <Data>(options: HttpListenOptions<Data>) => Effect.Effect<HttpListener, HttpListenError>
}>()("@kanna/server/platform/HttpHost") {}
