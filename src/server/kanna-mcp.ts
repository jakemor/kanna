import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schema, Stream } from "effect"
import { kannaToolSpecs, type KannaToolHost } from "./kanna-tools"
import { KannaLoggerLayer } from "./effect/logger"
import { HttpHost } from "./platform/http-host"

/**
 * The Kanna tools over MCP's streamable HTTP, for the providers that take an
 * MCP server by URL (codex, cursor). One server per turn, on 127.0.0.1, with
 * a bearer token of its own: a request without that exact token, or for any
 * path but `/mcp`, is 401; a request with an Origin header (a browser page)
 * is 403. Each request gets a fresh MCP server for its own exchange.
 */
export interface KannaMcpEndpoint {
  readonly url: string
  readonly headers: { readonly Authorization: string }
}

/** Answering one MCP request failed in the SDK. The listener answers it with a 500. */
export class KannaMcpRequestError extends Schema.TaggedError<KannaMcpRequestError>()(
  "@kanna/server/kanna-mcp/KannaMcpRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The MCP server for one request: lists the tools, runs calls through `host`. */
function connectionFor(host: KannaToolHost, request: Request, closing: AbortSignal) {
  const mcp = new Server({ name: "kanna", version: "1.0.0" }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: kannaToolSpecs() }))
  mcp.setRequestHandler(CallToolRequestSchema, (call, extra) => {
    const callTool = Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("tool", call.params.name)
      // Progress every ten seconds keeps a client from timing out a call that waits on the user.
      const progressToken = extra._meta?.progressToken
      if (progressToken !== undefined) {
        let progress = 0
        const notify = Effect.tryPromise(() => extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress },
        })).pipe(Effect.ignore)
        yield* Effect.forkScoped(Effect.forever(Effect.sleep("10 seconds").pipe(Effect.andThen(notify))))
      }
      const signal = AbortSignal.any([extra.signal, request.signal, closing])
      // A rejection is the host's own error, which the SDK reports to the client as it is.
      return yield* Effect.promise(() => host.execute(call.params.name, call.params.arguments ?? {}, signal))
    }).pipe(Effect.scoped, Effect.withSpan("KannaMcp.callTool"))
    return Effect.runPromise(callTool.pipe(Effect.provide(KannaLoggerLayer)))
  })
  return mcp
}

const closeConnection = (mcp: Server) => Effect.tryPromise(() => mcp.close()).pipe(Effect.ignore)

/**
 * Serves `host` until the scope closes. Closing it cancels every call in
 * flight, stops the listener and closes every open connection.
 */
export const serveKannaMcp = Effect.fn("KannaMcp.serve")(function* (host: KannaToolHost) {
  const http = yield* HttpHost
  const token = crypto.randomUUID()
  const closing = new AbortController()
  const connections = new Set<Server>()

  const handle = Effect.fn("KannaMcp.request")(function* (request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${token}` || new URL(request.url).pathname !== "/mcp") {
      return new Response("Unauthorized", { status: 401 })
    }
    if (request.headers.has("origin")) return new Response("Forbidden", { status: 403 })
    const mcp = connectionFor(host, request, closing.signal)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    connections.add(mcp)
    const release = Effect.suspend(() => {
      connections.delete(mcp)
      return closeConnection(mcp)
    })
    const response = yield* Effect.tryPromise({
      try: () => mcp.connect(transport),
      catch: (cause) => new KannaMcpRequestError({ operation: "connect", cause }),
    }).pipe(
      Effect.andThen(Effect.tryPromise({
        try: () => transport.handleRequest(request),
        catch: (cause) => new KannaMcpRequestError({ operation: "handleRequest", cause }),
      })),
      Effect.onError(() => release),
    )
    const body = response.body
    if (!body) {
      yield* release
      return response
    }
    // The connection lives as long as its response streams (SSE), and closes when it ends or the client goes.
    const stream = Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) => new KannaMcpRequestError({ operation: "stream", cause }),
    }).pipe(Stream.ensuring(release))
    return new Response(Stream.toReadableStream(stream), { status: response.status, headers: response.headers })
  })

  const server = yield* Effect.acquireRelease(
    // A listener on port 0 that can't start is a defect, as it always was.
    http.listen({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeoutSeconds: 0,
      fetch: (request) => Effect.runPromise(handle(request).pipe(Effect.provide(KannaLoggerLayer))),
    }).pipe(Effect.orDie),
    (server) => Effect.suspend(() => {
      closing.abort()
      return server.stop(true).pipe(Effect.andThen(Effect.suspend(() => {
        const open = [...connections]
        connections.clear()
        return Effect.forEach(open, closeConnection, { concurrency: "unbounded", discard: true })
      })))
    }),
  )
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  } satisfies KannaMcpEndpoint
})
