import { expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import type { ServerEnvelope } from "../../shared/protocol"
import { startIsolatedServer } from "./isolated-server"

test("isolated server accepts a project over WebSocket and persists it", async () => {
  const fixture = await startIsolatedServer()
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.port}/ws`)
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket could not open")), { once: true })
  })
  const messages: ServerEnvelope[] = []
  const waiters: Array<() => void> = []
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerEnvelope)
    for (const wake of waiters.splice(0)) wake()
  })
  const waitFor = async (matches: (message: ServerEnvelope) => boolean) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const found = messages.find(matches)
      if (found) return found
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        Bun.sleep(100),
      ])
    }
    throw new Error(`Timed out waiting for a WebSocket message: ${JSON.stringify(messages)}`)
  }

  try {
    const health = await fetch(`http://127.0.0.1:${fixture.server.port}/health`)
    expect(health.status).toBe(200)
    await opened

    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "projects", topic: { type: "local-projects" } }))
    const initial = await waitFor((message) => message.type === "snapshot" && message.id === "projects")
    expect(initial.type).toBe("snapshot")

    socket.send(JSON.stringify({ v: 1, type: "command", id: "create", command: {
      type: "project.create", localPath: fixture.projectDir, title: "Fixture Project",
    } }))
    const acknowledgement = await waitFor((message) => message.id === "create" && (message.type === "ack" || message.type === "error"))
    expect(acknowledgement.type).toBe("ack")
    expect((await stat(fixture.projectDir)).isDirectory()).toBe(true)
    expect([...fixture.server.store.state.projectsById.values()].some((project) => project.localPath === fixture.projectDir)).toBe(true)
  } finally {
    socket.close()
    await fixture.close()
  }
}, 30_000)
