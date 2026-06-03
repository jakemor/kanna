import http from "node:http"
import type { AddressInfo } from "node:net"

export type HttpRequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

export interface HttpServerHandle {
  port: number
  close: () => Promise<void>
}

export function createHttpServer(handler: HttpRequestHandler) {
  const server = http.createServer(handler)
  // This server hosts the loopback MCP transport (Streamable HTTP). The MCP
  // client holds a long-lived GET SSE stream for server->client notifications
  // that, by design, never "completes". Node/Bun defaults reap such sockets:
  // requestTimeout (default 300_000ms) destroys the still-open request after
  // 5 minutes, and keepAliveTimeout closes idle keep-alive sockets between
  // calls. Either reap leaves the next tool call hitting a dead transport —
  // surfaced to the model as `transport dropped mid-call`. The connection is
  // loopback-only with a single trusted client, so the DoS rationale for these
  // timeouts does not apply: disable them so idle stretches don't kill the SSE.
  server.requestTimeout = 0
  server.timeout = 0
  server.keepAliveTimeout = 0
  return server
}

export function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve(server.address() as AddressInfo)
    })
  })
}

export function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

export type HttpServer = http.Server
export type HttpIncomingMessage = http.IncomingMessage
export type HttpServerResponse = http.ServerResponse
