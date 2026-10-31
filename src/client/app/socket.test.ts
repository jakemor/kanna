import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KannaSocket } from "./socket"
import { RECONNECT_FAILURES_BEFORE_LOST, RECONNECT_GRACE_MS, SOCKET_DISCONNECTED_MESSAGE } from "./connectionHealth"

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

  beforeEach(() => {
    FakeWebSocket.instances = []
    timers = new FakeTimers()
    windowTarget = new FakeEventTarget()
    documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const })

    ;(globalThis as any).window = Object.assign(windowTarget, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      location: { protocol: "http:", host: "localhost:3211" },
    })
    ;(globalThis as any).document = documentTarget
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    ;(globalThis as any).WebSocket = originalWebSocket
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

  test("async url provider resolves before each connection (cloud URL rotation)", async () => {
    const urls = ["ws://tunnel-one/ws?token=a", "ws://tunnel-two/ws?token=b"]
    let resolveCount = 0
    const socket = new KannaSocket(async () => urls[Math.min(resolveCount++, urls.length - 1)])

    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toBe("ws://tunnel-one/ws?token=a")
    FakeWebSocket.instances[0]!.open()

    // Drop the connection → reconnect timer → provider re-resolves → new URL.
    FakeWebSocket.instances[0]!.close()
    const reconnectTimer = (socket as any).reconnectTimer as number
    timers.runTimeout(reconnectTimer)
    await Promise.resolve()
    await Promise.resolve()

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]!.url).toBe("ws://tunnel-two/ws?token=b")
    socket.dispose()
  })

  test("provider failure schedules a reconnect with backoff", async () => {
    const statuses: string[] = []
    let failuresLeft = 1
    const socket = new KannaSocket(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error("ws-endpoint unreachable")
      }
      return "ws://tunnel/ws?token=x"
    })
    socket.onStatus((status) => statuses.push(status))

    socket.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(statuses).toContain("disconnected")
    const reconnectTimer = (socket as any).reconnectTimer as number
    expect(timers.timeouts.has(reconnectTimer)).toBe(true)

    timers.runTimeout(reconnectTimer)
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toBe("ws://tunnel/ws?token=x")
    socket.dispose()
  })

  test("a drop reads as reconnecting through quick failures, lost past the threshold, connected once back", () => {
    const healths: string[] = []
    const socket = new KannaSocket("ws://localhost/ws")
    socket.onHealth((health) => healths.push(health))
    socket.start()
    FakeWebSocket.instances[0]!.open()
    expect(healths.at(-1)).toBe("connected")

    FakeWebSocket.instances[0]!.close()
    for (let attempt = 0; attempt < RECONNECT_FAILURES_BEFORE_LOST; attempt++) {
      timers.runTimeout((socket as any).reconnectTimer)
      FakeWebSocket.instances.at(-1)!.close()
    }
    expect(healths.at(-1)).toBe("reconnecting")
    expect(healths).not.toContain("lost")

    // The grace window runs out with no socket event; the health timer notices.
    ;(socket as any).downSince = Date.now() - RECONNECT_GRACE_MS
    timers.runTimeout((socket as any).healthTimer)
    expect(healths.at(-1)).toBe("lost")

    timers.runTimeout((socket as any).reconnectTimer)
    FakeWebSocket.instances.at(-1)!.open()
    expect(healths.at(-1)).toBe("connected")
    expect((socket as any).healthTimer).toBeNull()
    socket.dispose()
  })

  test("an unreachable server on first load reads as lost after the same threshold", () => {
    const healths: string[] = []
    const socket = new KannaSocket("ws://localhost/ws")
    socket.onHealth((health) => healths.push(health))
    socket.start()
    FakeWebSocket.instances[0]!.close()
    for (let attempt = 1; attempt < RECONNECT_FAILURES_BEFORE_LOST; attempt++) {
      timers.runTimeout((socket as any).reconnectTimer)
      FakeWebSocket.instances.at(-1)!.close()
    }
    expect(healths.at(-1)).toBe("connecting")

    ;(socket as any).downSince = Date.now() - RECONNECT_GRACE_MS
    timers.runTimeout((socket as any).healthTimer)
    expect(healths.at(-1)).toBe("lost")
    socket.dispose()
  })

  for (const returning of ["visibilitychange", "online", "focus"] as const) {
    test(`${returning} reconnects a dead socket at once, resets the backoff and restarts the grace window`, () => {
      const healths: string[] = []
      const socket = new KannaSocket("ws://localhost/ws")
      socket.onHealth((health) => healths.push(health))
      socket.start()
      FakeWebSocket.instances[0]!.open()
      FakeWebSocket.instances[0]!.close()
      for (let attempt = 0; attempt < RECONNECT_FAILURES_BEFORE_LOST; attempt++) {
        timers.runTimeout((socket as any).reconnectTimer)
        FakeWebSocket.instances.at(-1)!.close()
      }
      ;(socket as any).downSince = Date.now() - RECONNECT_GRACE_MS
      timers.runTimeout((socket as any).healthTimer)
      expect(healths.at(-1)).toBe("lost")
      expect((socket as any).reconnectDelayMs).toBeGreaterThan(750)
      const socketsBefore = FakeWebSocket.instances.length

      if (returning === "visibilitychange") documentTarget.dispatchEvent("visibilitychange")
      else windowTarget.dispatchEvent(returning)

      expect(FakeWebSocket.instances).toHaveLength(socketsBefore + 1)
      expect(FakeWebSocket.instances.at(-1)!.readyState).toBe(FakeWebSocket.CONNECTING)
      expect((socket as any).reconnectTimer).toBeNull()
      expect((socket as any).reconnectDelayMs).toBe(750)
      expect(healths.at(-1)).toBe("reconnecting")

      FakeWebSocket.instances.at(-1)!.open()
      expect(healths.at(-1)).toBe("connected")
      socket.dispose()
    })
  }

  test("commands in flight when the socket drops reject with the disconnect message", async () => {
    const socket = new KannaSocket("ws://localhost/ws")
    socket.start()
    FakeWebSocket.instances[0]!.open()
    const command = socket.command({ type: "system.ping" })
    FakeWebSocket.instances[0]!.close()
    await expect(command).rejects.toThrow(SOCKET_DISCONNECTED_MESSAGE)
    socket.dispose()
  })

  test("dispose during provider resolution never opens a socket", async () => {
    const resolver: { resolve: ((url: string) => void) | null } = { resolve: null }
    const socket = new KannaSocket(
      () => new Promise<string>((resolve) => {
        resolver.resolve = resolve
      }),
    )

    socket.start()
    socket.dispose()
    resolver.resolve?.("ws://tunnel/ws?token=late")
    await Promise.resolve()
    await Promise.resolve()

    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})
