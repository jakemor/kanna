import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KannaSocket } from "./socket"

type EventHandler = (event?: unknown) => void

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventHandler>>()

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  removeEventListener(type: string, listener: EventHandler) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

class FakeTimers {
  private nextId = 1
  readonly timeouts = new Map<number, () => void>()
  readonly intervals = new Map<number, () => void>()

  setTimeout = (callback: () => void) => {
    const id = this.nextId++
    this.timeouts.set(id, callback)
    return id
  }

  clearTimeout = (id: number) => {
    this.timeouts.delete(id)
  }

  setInterval = (callback: () => void) => {
    const id = this.nextId++
    this.intervals.set(id, callback)
    return id
  }

  clearInterval = (id: number) => {
    this.intervals.delete(id)
  }

  runTimeout(id: number) {
    const callback = this.timeouts.get(id)
    if (!callback) return
    this.timeouts.delete(id)
    callback()
  }

  runInterval(id: number) {
    this.intervals.get(id)?.()
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<EventHandler>>()
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventHandler) {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(listener)
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit("open")
  }

  receive(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) })
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit("close")
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe("KannaSocket", () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalWebSocket = globalThis.WebSocket

  let windowTarget: FakeEventTarget
  let documentTarget: FakeEventTarget & { visibilityState: "visible" | "hidden" }
  let timers: FakeTimers

  function setGlobal(key: "window" | "document" | "WebSocket", value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  beforeEach(() => {
    FakeWebSocket.instances = []
    timers = new FakeTimers()
    windowTarget = new FakeEventTarget()
    documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const })

    setGlobal("window", Object.assign(windowTarget, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      location: { protocol: "http:", host: "localhost:3211" },
    }))
    setGlobal("document", documentTarget)
    setGlobal("WebSocket", FakeWebSocket)
  })

  afterEach(() => {
    setGlobal("window", originalWindow)
    setGlobal("document", originalDocument)
    setGlobal("WebSocket", originalWebSocket)
  })

  test("does not ping when the connection is already fresh", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    await socket.ensureHealthyConnection()

    expect(ws.sent).toHaveLength(0)
    socket.dispose()
  })

  test("pings a stale open connection and resolves when acked", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    const ping = ws.sent[0]

    expect(ping?.type).toBe("command")
    expect(ping?.command).toEqual({ type: "system.ping" })

    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await healthCheck

    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.dispose()
  })

  test("reconnects immediately when a stale ping times out", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const firstWs = FakeWebSocket.instances[0]!
    firstWs.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    const healthCheck = socket.ensureHealthyConnection()
    timers.runTimeout((socket as any).pingTimeoutTimer)

    await expect(healthCheck).rejects.toThrow("Disconnected")
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]?.readyState).toBe(FakeWebSocket.CONNECTING)
    socket.dispose()
  })

  test("runs health checks on focus, visibility restore, and online", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("focus")
    let ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    documentTarget.visibilityState = "hidden"
    documentTarget.dispatchEvent("visibilitychange")
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    documentTarget.visibilityState = "visible"
    documentTarget.dispatchEvent("visibilitychange")
    ping = ws.sent.pop()
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()

    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000
    windowTarget.dispatchEvent("online")
    ping = ws.sent.pop()

    expect(ping?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ping?.id })
    await Promise.resolve()
    socket.dispose()
  })

  test("keeps queued commands and flushes them once the socket opens", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    const pingPromise = socket.command({ type: "system.ping" })

    expect(ws.sent).toHaveLength(0)

    ws.open()
    const ping = ws.sent[0]
    ws.receive({ v: 1, type: "ack", id: ping?.id })

    await expect(pingPromise).resolves.toBeUndefined()
    expect(ws.sent).toHaveLength(1)
    socket.dispose()
  })

  test("sends heartbeat checks while visible", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ;(socket as any).lastOpenAt = Date.now() - 30_000
    ;(socket as any).lastMessageAt = Date.now() - 30_000

    timers.runInterval((socket as any).heartbeatTimer)

    expect(ws.sent[0]?.command).toEqual({ type: "system.ping" })
    ws.receive({ v: 1, type: "ack", id: ws.sent[0]?.id })
    await Promise.resolve()
    socket.dispose()
  })
})
