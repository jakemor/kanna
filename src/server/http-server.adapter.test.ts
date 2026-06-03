import { describe, expect, test } from "bun:test"
import { closeHttpServer, createHttpServer } from "./http-server.adapter"

describe("createHttpServer", () => {
  // Regression: the loopback MCP server holds a long-lived GET SSE stream for
  // server->client notifications. Node/Bun default timeouts reap that socket
  // (requestTimeout=300_000ms kills the open request after 5 min;
  // keepAliveTimeout closes idle sockets between calls), so the next tool call
  // hits a dead transport — surfaced as `transport dropped mid-call`. Disabling
  // the timeouts keeps the idle SSE alive across long pauses (>5 min).
  test("disables socket reaping so long-lived SSE streams survive idle", async () => {
    const server = createHttpServer((_req, res) => {
      res.statusCode = 204
      res.end()
    })
    try {
      expect(server.requestTimeout).toBe(0)
      expect(server.timeout).toBe(0)
      expect(server.keepAliveTimeout).toBe(0)
    } finally {
      await closeHttpServer(server)
    }
  })
})
