/**
 * One Kanna per data dir, and the way everything else finds it.
 *
 * The process that runs the server holds a Unix socket at a fixed path
 * (`~/.kanna/kanna.sock`). Only one process can listen on a path, so holding
 * it is the lock. It's also how the Mac app, `kanna stop` and a second
 * `kanna` ask that process about the server: its port, who started it, how
 * many chats are running. The answers come from memory, so they can't go
 * stale the way a pid file can after a crash.
 *
 * Under the CLI's supervisor (cli-supervisor.ts) the supervisor holds the
 * socket. It outlives the server child across update restarts, so the lock
 * stays held while the child restarts, and the child reports its port to the
 * supervisor once it listens. Without a supervisor (`bun run dev`), the
 * server process holds the socket itself.
 *
 * The protocol is one JSON object per line. Keep it additive: the socket is
 * served by a supervisor that may be older than the `kanna` or the Mac app
 * asking it, because an npm update restarts only the child.
 */

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { Clock, Deferred, Effect, Exit, Option, Schema, type Scope } from "effect"
import { getDataDir, getDataRootDir } from "../shared/branding"
import { instanceFingerprint } from "./instance"

/** The supervisor tells its child whether it holds the lock ("held") or found
 *  another Kanna holding it ("taken"). Unset: the child is on its own. */
export const INSTANCE_LOCK_ENV_VAR = "KANNA_INSTANCE_LOCK"
/** "app" when Kanna for Mac started this `kanna`. */
export const STARTED_BY_ENV_VAR = "KANNA_STARTED_BY"

/**
 * Who decides when the server stops.
 * - terminal: whoever ran `kanna`. Quitting the Mac app leaves it alone.
 * - app: the Mac app started it, and asks on quit whether to keep it running.
 * - background: the app quit and the user chose to keep it running. The app
 *   asks again the next time it quits.
 */
export type InstanceOwner = "terminal" | "app" | "background"

export interface InstanceStatus {
  ok: true
  /** The process holding the socket: the supervisor, or the server itself. */
  pid: number
  instance: string
  owner: InstanceOwner
  startedAt: number
  /** Null while the server starts, or restarts after an update. */
  port: number | null
  version: string | null
  runningChats: number | null
  /** Serving this Mac's Kanna Cloud address. */
  cloud: boolean | null
}

export type InstanceRequest = { type: "status" } | { type: "release" } | { type: "stop" }

/** What the server reports to the lock holder. */
export interface AttachedServer {
  port: number
  version: string
  state?: () => { runningChats: number; cloud: boolean }
}

/**
 * `<data root>/kanna.sock`, or a named pipe on Windows. macOS caps a socket
 * path at 104 bytes (Linux at 108), so a long home folder falls back to one
 * in the temp dir, named for the data dir. The Mac app computes the same path
 * (macos/src/instance.ts).
 */
export function instanceSocketPath(homeDir: string = os.homedir(), platform: NodeJS.Platform = process.platform) {
  const fingerprint = instanceFingerprint(getDataDir(homeDir))
  if (platform === "win32") return `\\\\.\\pipe\\kanna-${fingerprint}`
  const inRoot = path.join(getDataRootDir(homeDir), "kanna.sock")
  return Buffer.byteLength(inRoot) < 100 ? inRoot : path.join(os.tmpdir(), `kanna-${fingerprint}.sock`)
}

/** Whether `argv` starts a server, and so needs the lock. `pair` does too
 *  once it has paired; its child takes the lock itself at that point. */
export function startsServer(argv: string[]) {
  if (argv[0] === "pair" || argv[0] === "slim-transcripts" || argv[0] === "stop") return false
  return !argv.some((arg) => arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h")
}

// Wire

/** One line of the protocol: any JSON object. Anything else is skipped. */
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

function readLines(socket: net.Socket, onMessage: (message: Record<string, unknown>) => void) {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = decodeMessage(line)
      if (Option.isSome(message)) onMessage(message.value)
    }
    if (buffer.length > 64_000) socket.destroy()
  })
}

function send(socket: net.Socket, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

type Answer = { kind: "none" } | { kind: "noAnswer" } | { kind: "answer"; message: Record<string, unknown> }

/**
 * "none" when nothing listens: the file is missing, or left behind by a
 * process that died (connecting is refused). "noAnswer" when something
 * listens but doesn't reply in time, which is a live process, not a stale
 * socket.
 */
const ask = Effect.fn("InstanceSocket.ask")(function* (socketPath: string, request: InstanceRequest, timeoutMs: number) {
  // Bun throws a failed connect to a missing path instead of emitting it.
  if (process.platform !== "win32" && !(yield* Effect.sync(() => fs.existsSync(socketPath)))) {
    return { kind: "none" } satisfies Answer
  }
  // The socket is made and its listeners attached in one go, so an error
  // emitted on the next tick always has a listener.
  const answer = yield* Effect.callback<Answer>((resume) => {
    const socket = net.createConnection(socketPath)
    const finish = (answer: Answer) => {
      socket.destroy()
      resume(Effect.succeed(answer))
    }
    socket.once("connect", () => send(socket, request))
    // `on`, not `once`: Bun can emit a failed connect's error twice.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? { kind: "none" } : { kind: "noAnswer" })
    })
    readLines(socket, (message) => finish({ kind: "answer", message }))
    return Effect.sync(() => socket.destroy())
  }).pipe(Effect.timeoutOption(timeoutMs))
  return Option.getOrElse(answer, (): Answer => ({ kind: "noAnswer" }))
})

function isStatus(message: Record<string, unknown>): message is Record<string, unknown> & InstanceStatus {
  return message.ok === true && typeof message.pid === "number" && typeof message.owner === "string"
}

/** The running Kanna's status, or null when none is running. */
export const instanceStatus = Effect.fn("InstanceSocket.status")(function* (
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  const answer = yield* ask(options.socketPath ?? instanceSocketPath(), { type: "status" }, options.timeoutMs ?? 1_000)
  return answer.kind === "answer" && isStatus(answer.message) ? answer.message : null
})

/**
 * The running Kanna once its server listens. Waits out a start or an update
 * restart, while the port is still unknown. Null if none is running, or if
 * it still has no port after `timeoutMs`.
 */
export const waitForInstancePort = Effect.fn("InstanceSocket.waitForPort")(function* (
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  const deadline = (yield* Clock.currentTimeMillis) + (options.timeoutMs ?? 30_000)
  while (true) {
    const status = yield* instanceStatus({ socketPath: options.socketPath })
    if (!status || status.port !== null) return status
    if ((yield* Clock.currentTimeMillis) >= deadline) return null
    yield* Effect.sleep("250 millis")
  }
})

/** Ask the running Kanna to stop. False when none is running. */
export const requestInstanceStop = Effect.fn("InstanceSocket.requestStop")(function* (
  options: { socketPath?: string } = {},
) {
  const answer = yield* ask(options.socketPath ?? instanceSocketPath(), { type: "stop" }, 2_000)
  return answer.kind === "answer" && answer.message.ok === true
})

// The lock

export class InstanceLock {
  owner: InstanceOwner
  private server: AttachedServer | null = null
  private link: net.Socket | null = null
  private readonly startedAt = Date.now()
  private readonly instance = instanceFingerprint(getDataDir(os.homedir()))

  constructor(
    private readonly listener: net.Server,
    readonly socketPath: string,
    owner: InstanceOwner,
    private readonly onStop: () => void,
  ) {
    this.owner = owner
    listener.on("connection", (socket) => this.serve(socket))
  }

  private linkState: { runningChats: number; cloud: boolean } | null = null

  /** The server this process runs in-process (no supervisor). */
  attach(server: AttachedServer) {
    this.server = server
  }

  /** Kept running when the app that started it quits. */
  get releasedFromParent() {
    return this.owner === "background"
  }

  status(): InstanceStatus {
    let state: { runningChats: number; cloud: boolean } | null = null
    try {
      state = this.server?.state?.() ?? null
    } catch {}
    return {
      ok: true,
      pid: process.pid,
      instance: this.instance,
      owner: this.owner,
      startedAt: this.startedAt,
      port: this.server?.port ?? null,
      version: this.server?.version ?? null,
      runningChats: state?.runningChats ?? null,
      cloud: state?.cloud ?? null,
    }
  }

  close() {
    this.listener.close()
    removeSocketFile(this.socketPath)
  }

  private serve(socket: net.Socket) {
    socket.on("error", () => {})
    readLines(socket, (message) => {
      switch (message.type) {
        case "status":
          send(socket, this.status())
          break
        case "release":
          // Only the app's own server: a terminal's belongs to its terminal.
          if (this.owner === "app") this.owner = "background"
          send(socket, { ok: true, owner: this.owner })
          break
        case "stop":
          send(socket, { ok: true })
          this.onStop()
          break
        case "attach":
          this.attachLink(socket, message)
          break
        case "state":
          this.linkState = {
            runningChats: typeof message.runningChats === "number" ? message.runningChats : 0,
            cloud: message.cloud === true,
          }
          break
      }
    })
  }

  /**
   * The server child, under a supervisor, keeps this connection open and
   * pushes its state on it. When the child exits the connection closes,
   * and the port goes back to unknown until the next child attaches.
   */
  private attachLink(socket: net.Socket, message: Record<string, unknown>) {
    if (typeof message.port !== "number") return
    this.link?.destroy()
    this.link = socket
    this.linkState = null
    this.server = {
      port: message.port,
      version: typeof message.version === "string" ? message.version : "",
      state: () => this.linkState ?? { runningChats: 0, cloud: false },
    }
    socket.once("close", () => {
      if (this.link !== socket) return
      this.link = null
      this.server = null
      this.linkState = null
    })
  }
}

/**
 * Take the socket, or null when another live Kanna holds it. A file left by
 * a process that died is removed and taken over. `onStop` runs on a `stop`
 * request.
 *
 * The lock outlives the call: it is released by `close()` or at exit, not by
 * a scope, because its holder keeps it for the life of the process.
 */
export const acquireInstanceLock = Effect.fn("InstanceSocket.acquireLock")(function* (options: {
  owner: InstanceOwner
  onStop: () => void
  socketPath?: string
}) {
  const socketPath = options.socketPath ?? instanceSocketPath()
  yield* Effect.annotateCurrentSpan("socketPath", socketPath)
  if (process.platform !== "win32") yield* Effect.sync(() => fs.mkdirSync(path.dirname(socketPath), { recursive: true }))

  for (let attempt = 0; attempt < 50; attempt++) {
    // Checking and listening happen under a short claim, for two reasons.
    // Bun's listen replaces a socket file that's already there instead of
    // failing, so listening alone isn't exclusive. And two starters that
    // both find a stale file mustn't both remove it, one of them deleting
    // the socket the other just opened.
    const outcome = yield* Effect.acquireRelease(
      Effect.sync(() => claimSocket(socketPath)),
      (release) => Effect.sync(() => release?.()),
    ).pipe(
      Effect.flatMap((release): Effect.Effect<"busy" | "taken" | Option.Option<net.Server>> =>
        release ? takeOver(socketPath) : Effect.succeed("busy")),
      Effect.scoped,
    )
    if (outcome === "busy") {
      yield* Effect.sleep("100 millis")
      continue
    }
    if (outcome === "taken") return null
    if (Option.isSome(outcome)) {
      const lock = new InstanceLock(outcome.value, socketPath, options.owner, options.onStop)
      process.once("exit", () => removeSocketFile(socketPath))
      return lock
    }
  }
  return null
})

/** Under the claim: "taken" by a live Kanna, else our listener (none if listening failed). */
const takeOver = Effect.fn("InstanceSocket.takeOver")(function* (socketPath: string) {
  // Something answering, or listening and busy, is a live Kanna.
  // Nobody accepting is a file a crashed one left: take it over.
  if ((yield* ask(socketPath, { type: "status" }, 1_000)).kind !== "none") return "taken" as const
  yield* Effect.sync(() => removeSocketFile(socketPath))
  return yield* listen(socketPath)
})

/** A server listening on `socketPath`, or none when listening failed. */
const listen = Effect.fn("InstanceSocket.listen")(function* (socketPath: string) {
  return yield* Effect.callback<Option.Option<net.Server>>((resume) => {
    const listener = net.createServer()
    listener.once("error", () => resume(Effect.succeedNone))
    listener.listen(socketPath, () => {
      // Only this user may ask the server anything, or stop it.
      if (process.platform !== "win32") restrictToOwner(socketPath)
      resume(Effect.succeedSome(listener))
    })
  })
})

function restrictToOwner(socketPath: string) {
  try {
    fs.chmodSync(socketPath, 0o600)
  } catch {}
}

function removeSocketFile(socketPath: string) {
  if (process.platform === "win32") return
  try {
    fs.unlinkSync(socketPath)
  } catch {}
}

/** An exclusive-create claim file next to the socket. One left by a crash
 *  while claimed (at most a second's window) is ignored after 5 seconds. */
function claimSocket(socketPath: string): (() => void) | null {
  const claimPath = `${socketPath}.claim`
  try {
    fs.closeSync(fs.openSync(claimPath, "wx"))
  } catch {
    try {
      if (Date.now() - fs.statSync(claimPath).mtimeMs > 5_000) fs.unlinkSync(claimPath)
    } catch {}
    return null
  }
  return () => {
    try {
      fs.unlinkSync(claimPath)
    } catch {}
  }
}

/**
 * The server child's side, under a supervisor that holds the lock: report
 * the port once listening, and push the state the app's quit dialog shows,
 * each second, until the scope closes (detaching) or the supervisor goes.
 *
 * The push loop runs on Effect's clock, whose timers keep the process
 * alive; that is fine because the scope is the server's, which ends with
 * the process (cli.ts). The socket itself is unref'd.
 */
export const attachToSupervisor = Effect.fn("InstanceSocket.attachToSupervisor")(function* (
  server: AttachedServer,
  options: { socketPath?: string } = {},
) {
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = net.createConnection(options.socketPath ?? instanceSocketPath())
      socket.on("error", () => {})
      // Don't hold the process open for this.
      socket.unref()
      return socket
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  )
  let last = ""
  const push = () => {
    const state = server.state?.()
    if (!state) return
    const line = JSON.stringify({ type: "state", ...state })
    if (line === last) return
    last = line
    socket.write(`${line}\n`)
  }
  const closed = Deferred.makeUnsafe<void>()
  socket.once("connect", () => {
    send(socket, { type: "attach", port: server.port, version: server.version })
    push()
  })
  socket.once("close", () => Deferred.doneUnsafe(closed, Exit.void))
  yield* Effect.sync(push).pipe(
    Effect.delay("1 second"),
    Effect.forever,
    Effect.raceFirst(Deferred.await(closed)),
    Effect.forkScoped,
  )
})

export type InstanceClaim =
  | {
    kind: "ours"
    /** Reports the listening server for as long as the scope stays open. */
    attach: (server: AttachedServer) => Effect.Effect<void, never, Scope.Scope>
    /** The app that started this server quit and chose to keep it running. */
    releasedFromParent: () => boolean
  }
  /** Another Kanna has the lock. Its status is null when it still has no
   *  port after the wait, or stopped while this one waited. */
  | { kind: "running"; status: InstanceStatus | null }

/**
 * The server's half of the lock, before it starts: go ahead ("ours"), or
 * point the user at the Kanna already running.
 */
export const claimInstance = Effect.fn("InstanceSocket.claim")(function* (
  env: Record<string, string | undefined> = process.env,
) {
  const lockEnv = env[INSTANCE_LOCK_ENV_VAR]
  const owner: InstanceOwner = env[STARTED_BY_ENV_VAR] === "app" ? "app" : "terminal"
  // Read once: the server's own children (terminals, agents) inherit its
  // env, and a `kanna` run in one of them must not think it holds a lock.
  delete env[INSTANCE_LOCK_ENV_VAR]
  delete env[STARTED_BY_ENV_VAR]

  // Under a supervisor, the parent this server watches is the supervisor,
  // which does the watching for a release.
  if (lockEnv === "held") {
    const claim: InstanceClaim = {
      kind: "ours",
      attach: (server) => attachToSupervisor(server),
      releasedFromParent: () => false,
    }
    return claim
  }
  if (lockEnv === "taken") {
    const claim: InstanceClaim = { kind: "running", status: yield* waitForInstancePort() }
    return claim
  }

  const lock = yield* acquireInstanceLock({
    owner,
    // The same path as Ctrl-C: cli.ts stops the server on SIGTERM.
    onStop: () => process.kill(process.pid, "SIGTERM"),
  })
  const claim: InstanceClaim = lock
    ? { kind: "ours", attach: (server) => Effect.sync(() => lock.attach(server)), releasedFromParent: () => lock.releasedFromParent }
    : { kind: "running", status: yield* waitForInstancePort() }
  return claim
})
