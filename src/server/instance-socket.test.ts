import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { runTest } from "./effect/testing"
import {
  acquireInstanceLock,
  attachToSupervisor,
  instanceSocketPath,
  instanceStatus,
  requestInstanceStop,
  startsServer,
  type InstanceLock,
  waitForInstancePort,
} from "./instance-socket"

// Short: macOS caps a socket path at 104 bytes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-"))
let count = 0
const locks: InstanceLock[] = []

function socketPath() {
  return path.join(dir, `${++count}.sock`)
}

async function acquire(socket: string, owner: "terminal" | "app" = "terminal", onStop = () => {}) {
  const lock = await runTest(acquireInstanceLock({ owner, onStop, socketPath: socket }))
  if (lock) locks.push(lock)
  return lock
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

afterEach(() => {
  for (const lock of locks.splice(0)) lock.close()
})

describe("the instance lock", () => {
  test("one holder at a time; the second finds the first", async () => {
    const socket = socketPath()
    const first = await acquire(socket)
    expect(first).not.toBeNull()
    expect(await acquire(socket)).toBeNull()

    const status = await runTest(instanceStatus({ socketPath: socket }))
    expect(status).toMatchObject({ ok: true, pid: process.pid, owner: "terminal", port: null })
  })

  test("the server reports its port and state once it listens", async () => {
    const socket = socketPath()
    const lock = (await acquire(socket))!
    lock.attach({ port: 4123, version: "1.2.3", state: () => ({ runningChats: 2, cloud: true }) })
    expect(await runTest(instanceStatus({ socketPath: socket }))).toMatchObject({
      port: 4123,
      version: "1.2.3",
      runningChats: 2,
      cloud: true,
    })
  })

  test("a socket left by a crashed Kanna is taken over", async () => {
    const socket = socketPath()
    // A regular file is what a dead process leaves behind as far as
    // connecting goes: nobody accepts.
    fs.writeFileSync(socket, "")
    expect(await runTest(instanceStatus({ socketPath: socket }))).toBeNull()
    expect(await acquire(socket)).not.toBeNull()
  })

  test("release keeps the app's server running, and not a terminal's", async () => {
    const appSocket = socketPath()
    const appLock = (await acquire(appSocket, "app"))!
    expect(appLock.releasedFromParent).toBe(false)
    await release(appSocket)
    expect(appLock.owner).toBe("background")
    expect(appLock.releasedFromParent).toBe(true)

    const terminalSocket = socketPath()
    const terminalLock = (await acquire(terminalSocket, "terminal"))!
    await release(terminalSocket)
    expect(terminalLock.owner).toBe("terminal")
  })

  test("stop reaches the holder", async () => {
    const socket = socketPath()
    let stopped = false
    await acquire(socket, "terminal", () => {
      stopped = true
    })
    expect(await runTest(requestInstanceStop({ socketPath: socket }))).toBe(true)
    expect(stopped).toBe(true)
    expect(await runTest(requestInstanceStop({ socketPath: socketPath() }))).toBe(false)
  })

  test("a server child attaches to its supervisor, and detaches when it exits", async () => {
    const socket = socketPath()
    await acquire(socket)
    let runningChats = 1
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(attachToSupervisor(
      { port: 5000, version: "9.9.9", state: () => ({ runningChats, cloud: false }) },
      { socketPath: socket },
    ).pipe(Scope.provide(scope)))
    await until(async () => (await runTest(instanceStatus({ socketPath: socket })))?.runningChats === 1)
    expect(await runTest(instanceStatus({ socketPath: socket }))).toMatchObject({ port: 5000, version: "9.9.9" })

    runningChats = 3
    await until(async () => (await runTest(instanceStatus({ socketPath: socket })))?.runningChats === 3)

    // Closing the scope detaches: the supervisor forgets the port.
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await until(async () => (await runTest(instanceStatus({ socketPath: socket })))?.port === null)
  })

  test("an attached child stops pushing once the supervisor goes away", async () => {
    const socket = socketPath()
    // A stand-in supervisor that hangs up on the child as soon as it attaches.
    let hungUp = false
    const supervisor = net.createServer((connection) => {
      connection.once("data", () => {
        connection.destroy()
        hungUp = true
      })
    })
    await new Promise<void>((resolve) => supervisor.listen(socket, resolve))
    const scope = Effect.runSync(Scope.make())
    let reads = 0
    await Effect.runPromise(attachToSupervisor(
      { port: 5001, version: "9.9.9", state: () => { reads += 1; return { runningChats: reads, cloud: false } } },
      { socketPath: socket },
    ).pipe(Scope.provide(scope)))
    await until(async () => hungUp)
    await Bun.sleep(100)
    const afterHangUp = reads
    await Bun.sleep(1_300)
    expect(reads).toBe(afterHangUp)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    supervisor.close()
  })

  test("close removes the socket", async () => {
    const socket = socketPath()
    const lock = (await acquire(socket))!
    locks.pop()
    lock.close()
    expect(fs.existsSync(socket)).toBe(false)
    expect(await runTest(instanceStatus({ socketPath: socket }))).toBeNull()
  })
})

describe("instanceSocketPath", () => {
  test("sits in the data root, or the temp dir for a long home folder", () => {
    expect(instanceSocketPath("/Users/jake", "darwin")).toMatch(/^\/Users\/jake\/\.kanna(-dev)?\/kanna\.sock$/)
    const long = `/Users/${"x".repeat(120)}`
    expect(instanceSocketPath(long, "darwin")).toMatch(/kanna-[0-9a-f]{16}\.sock$/)
    expect(instanceSocketPath("/Users/jake", "win32")).toMatch(/^\\\\\.\\pipe\\kanna-[0-9a-f]{16}$/)
  })
})

describe("startsServer", () => {
  test("a run needs the lock; commands and pair don't", () => {
    expect(startsServer([])).toBe(true)
    expect(startsServer(["--port", "4000", "--no-open"])).toBe(true)
    expect(startsServer(["--version"])).toBe(false)
    expect(startsServer(["--help"])).toBe(false)
    expect(startsServer(["stop"])).toBe(false)
    expect(startsServer(["slim-transcripts"])).toBe(false)
    expect(startsServer(["pair", "ABC123"])).toBe(false)
  })
})

async function release(socket: string) {
  const net = await import("node:net")
  await new Promise<void>((resolve) => {
    const client = net.createConnection(socket, () => client.write(`${JSON.stringify({ type: "release" })}\n`))
    client.on("data", () => {
      client.destroy()
      resolve()
    })
  })
}

describe("the instance socket, from Effect", () => {
  test("a busy listener that never answers counts as running, not stale", async () => {
    const socket = socketPath()
    const net = await import("node:net")
    // Accepts connections but never replies.
    const silent = net.createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(socket, resolve))
    try {
      expect(await runTest(instanceStatus({ socketPath: socket, timeoutMs: 100 }))).toBeNull()
      expect(await acquire(socket)).toBeNull()
    } finally {
      silent.close()
    }
  })

  test("waitForInstancePort waits out a server with no port yet", async () => {
    const socket = socketPath()
    const lock = (await acquire(socket))!
    expect(await runTest(waitForInstancePort({ socketPath: socket, timeoutMs: 300 }))).toBeNull()

    const waiting = runTest(waitForInstancePort({ socketPath: socket, timeoutMs: 5_000 }).pipe(Effect.timeout("6 seconds")))
    await Bun.sleep(300)
    lock.attach({ port: 4567, version: "1.0.0" })
    expect(await waiting).toMatchObject({ port: 4567, version: "1.0.0" })
  })

  test("waitForInstancePort is null when nothing is running", async () => {
    expect(await runTest(waitForInstancePort({ socketPath: socketPath(), timeoutMs: 300 }))).toBeNull()
  })
})
