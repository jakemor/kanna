import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { sendEnvelope, sendSerializedSnapshot, shouldIncludeTopic } from "./ws-transport"

test("snapshot filters include only selected subscriptions", () => {
  const filter = { includeSidebar: true, chatIds: new Set(["chat-1"]) }
  expect(shouldIncludeTopic({ type: "sidebar" }, filter)).toBe(true)
  expect(shouldIncludeTopic({ type: "local-projects" }, filter)).toBe(false)
  expect(shouldIncludeTopic({ type: "chat", chatId: "chat-1" }, filter)).toBe(true)
  expect(shouldIncludeTopic({ type: "chat", chatId: "chat-2" }, filter)).toBe(false)
})

test("WebSocket frames compress large snapshots and escape subscription IDs", () => {
  const frames: Array<{ payload: string; compress: boolean }> = []
  const socket = {
    send(payload: string, compress: boolean) {
      frames.push({ payload, compress })
      return payload.length
    },
  } as ServerWebSocket<unknown>

  sendEnvelope(socket, { v: 1, type: "ack", id: "small" })
  sendSerializedSnapshot(socket, 'quoted"id', JSON.stringify({ type: "sidebar", data: { large: "x".repeat(1024) } }))

  expect(frames[0]?.compress).toBe(false)
  expect(frames[1]?.compress).toBe(true)
  expect(JSON.parse(frames[1]!.payload).id).toBe('quoted"id')
})
