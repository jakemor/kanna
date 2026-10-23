import path from "node:path"
import { Clock, Effect, Option, Schema, Stream } from "effect"
import { Machine } from "./platform/machine"
import { ProcessSpawner } from "./platform/process-spawner"

// macOS ships lsof only in /usr/sbin. A launchd agent gets a trimmed PATH that
// often stops at /bin, so a bare "lsof" fails with ENOENT and discovery goes
// silent. Try PATH first, then the known absolute path.
const LSOF_CANDIDATES = ["lsof", "/usr/sbin/lsof"]
const LOCAL_HTTP_SCAN_TIMEOUT_MS = 450
const LOCAL_HTTP_CACHE_TTL_MS = 30_000

/** `value[key]` when `value` is an object; how node hangs `code` and `stdout` on exec errors. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

/** `lsof`, `ps`: failed to start, timed out, overflowed, or exited non-zero. */
export class LocalCommandError extends Schema.TaggedError<LocalCommandError>()(
  "@kanna/server/local-http-servers/LocalCommandError",
  {
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** `ENOENT` and the like when it failed to start; the exit status when it ran. */
  get code(): unknown {
    return field(this.cause, "code")
  }

  /** What it printed before failing, when it ran at all. */
  get stdout(): unknown {
    return field(this.cause, "stdout")
  }
}

export class InvalidPortError extends Schema.TaggedError<InvalidPortError>()(
  "@kanna/server/local-http-servers/InvalidPortError",
  { port: Schema.Number },
) {
  override get message() {
    return "Port is invalid."
  }
}

export class NoListeningProcessError extends Schema.TaggedError<NoListeningProcessError>()(
  "@kanna/server/local-http-servers/NoListeningProcessError",
  { port: Schema.Number },
) {
  override get message() {
    return `No listening process found on port ${this.port}.`
  }
}

export class KillProcessError extends Schema.TaggedError<KillProcessError>()(
  "@kanna/server/local-http-servers/KillProcessError",
  {
    port: Schema.Number,
    pid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : `Unable to kill process on port ${this.port}.`
  }
}

/** The page at a port didn't answer in time, or not over HTTP. */
class LocalHttpProbeError extends Schema.TaggedError<LocalHttpProbeError>()(
  "@kanna/server/local-http-servers/LocalHttpProbeError",
  {
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {}

const COMMAND_ERROR = "@kanna/server/local-http-servers/LocalCommandError"
const PROBE_ERROR = "@kanna/server/local-http-servers/LocalHttpProbeError"

/**
 * How node's `execFile` failed, kept as the error's cause so `code` and
 * `stdout` read the same: the exit status (a number) when the command ran
 * and exited non-zero, a string code when it timed out or overflowed.
 */
function execFailure(message: string, fields: { code: unknown; stdout?: string; stderr?: string; killed?: boolean }) {
  return Object.assign(new Error(message), fields)
}

/**
 * `execFile` semantics on the machine's `ProcessSpawner`: collects stdout,
 * kills the command past `timeout` ms or `maxBuffer` bytes of stdout, and
 * fails on a non-zero exit with the output so far.
 */
const runCommand = Effect.fn("LocalHttpServers.runCommand")(function* (
  bin: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) {
  const spawner = yield* ProcessSpawner
  const commandLine = [bin, ...args].join(" ")
  const child = yield* spawner.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" }).pipe(
    Effect.mapError((error) => new LocalCommandError({ command: bin, cause: error.cause })),
  )
  let stdout = ""
  let overflowed = false
  const collect = Effect.all([
    child.stdout.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) => Effect.gen(function* () {
        stdout += chunk
        if (stdout.length > options.maxBuffer && !overflowed) {
          overflowed = true
          yield* child.kill()
        }
      })),
    ),
    Stream.mkString(Stream.decodeText(child.stderr)),
    child.exited,
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError((cause) => new LocalCommandError({ command: bin, cause })),
  )
  const finished = yield* Effect.timeoutOption(collect, options.timeout)
  if (Option.isNone(finished)) {
    yield* child.kill()
    return yield* new LocalCommandError({
      command: bin,
      cause: execFailure(`Command failed: ${commandLine}`, { code: null, killed: true, stdout }),
    })
  }
  const [, stderr, exit] = finished.value
  if (overflowed) {
    return yield* new LocalCommandError({
      command: bin,
      cause: execFailure("stdout maxBuffer length exceeded", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout, stderr }),
    })
  }
  if (exit.exitCode !== 0) {
    return yield* new LocalCommandError({
      command: bin,
      cause: execFailure(`Command failed: ${commandLine}\n${stderr}`, { code: exit.exitCode, stdout, stderr }),
    })
  }
  return { stdout, stderr }
}, Effect.scoped)

const execLsof = Effect.fn("LocalHttpServers.execLsof")(function* (args: string[], options: { timeout: number; maxBuffer: number }) {
  let lastError: LocalCommandError | undefined
  for (const bin of LSOF_CANDIDATES) {
    const result = yield* Effect.result(runCommand(bin, args, options))
    if (result._tag === "Success") return result.success
    lastError = result.failure
    if (lastError.code !== "ENOENT") return yield* lastError
  }
  return yield* lastError!
})

interface LocalHttpServerCacheEntry {
  signature: string
  scannedAt: number
  results: LocalHttpServerInfo[]
}

const localHttpServerCache = new Map<string, LocalHttpServerCacheEntry>()

export interface LocalHttpServerInfo {
  title: string
  address: string
  port: number
  status: number
  ownerPath?: string
  processName?: string
  sameProject?: boolean
  publicUrl?: string
}

interface ListeningPortOwner {
  command: string
  pid: number
}

export interface ListeningPortEntry {
  port: number
  owners: ListeningPortOwner[]
}

export function extractHtmlTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ""
  return match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function parseLsofListeningEntries(output: string) {
  const entriesByPort = new Map<number, ListeningPortEntry>()

  for (const line of output.split("\n").slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+).*TCP\s+(?:.+?):(\d+)\s+\(LISTEN\)/)
    if (!match) continue

    const command = match[1]
    const pid = Number(match[2])
    const port = Number(match[3])
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      continue
    }

    const entry = entriesByPort.get(port) ?? { port, owners: [] }
    if (!entry.owners.some((owner) => owner.pid === pid)) {
      entry.owners.push({ command, pid })
    }
    entriesByPort.set(port, entry)
  }

  return [...entriesByPort.values()].sort((a, b) => a.port - b.port)
}

export function isPathWithin(parentPath: string | undefined, childPath: string | undefined) {
  if (!parentPath || !childPath) return false
  const normalizedParent = path.resolve(parentPath)
  const normalizedChild = path.resolve(childPath)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

export function isDescendantPid(pid: number, rootPids: Set<number>, parentByPid: Map<number, number>) {
  let current: number | undefined = pid
  const visited = new Set<number>()

  while (current !== undefined && current > 0 && !visited.has(current)) {
    if (rootPids.has(current)) return true
    visited.add(current)
    current = parentByPid.get(current)
  }

  return false
}

function isLikelyInternalResponder(server: LocalHttpServerInfo) {
  if (server.status < 200 || server.status >= 400) return true
  if (/^(localhost:\d+|502 Bad Gateway|Welcome to nginx!)$/i.test(server.title)) return true
  if (/^(nginx|cloudflar|workerd|agent-bro|Google|Cursor|ControlCe|figma_age|Superhuma|Spotify|redis|postgres|mysqld)/i.test(server.processName ?? "")) {
    return true
  }
  return false
}

export function filterLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => !isLikelyInternalResponder(server))
}

/** Every listening TCP port and who owns it; empty when lsof can't tell. */
const listListeningTcpEntries = Effect.fn("LocalHttpServers.listListeningTcpEntries")(function* () {
  return yield* execLsof(["-nP", "-iTCP", "-sTCP:LISTEN"], {
    timeout: 1_500,
    maxBuffer: 1024 * 1024,
  }).pipe(
    Effect.map(({ stdout }) => parseLsofListeningEntries(stdout)),
    Effect.catchTag(COMMAND_ERROR, () => Effect.succeed([])),
  )
})

function getListeningEntriesSignature(entries: ListeningPortEntry) {
  return `${entries.port}:${entries.owners.map((owner) => `${owner.command}:${owner.pid}`).join(",")}`
}

function getListeningEntryListSignature(entries: ListeningPortEntry[]) {
  return entries.map(getListeningEntriesSignature).join("|")
}

/** SIGTERMs whatever owns the listening port. */
export const killLocalHttpServer = Effect.fn("LocalHttpServers.kill")(function* (port: number) {
  yield* Effect.annotateCurrentSpan("port", port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return yield* new InvalidPortError({ port })
  }

  const entries = yield* listListeningTcpEntries()
  const owner = entries.find((entry) => entry.port === port)?.owners[0]
  if (!owner) {
    return yield* new NoListeningProcessError({ port })
  }

  const machine = yield* Machine
  yield* machine.signalProcess(owner.pid, "SIGTERM").pipe(
    Effect.catchTag("@kanna/server/platform/ProcessSignalError", (error) =>
      Effect.fail(new KillProcessError({ port, pid: owner.pid, cause: error.cause }))),
  )

  return {
    ok: true,
    port,
    processName: owner.command,
  }
})

export function parseLsofCwdOutput(output: string) {
  const cwdByPid = new Map<number, string>()
  let currentPid: number | undefined

  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1))
      currentPid = Number.isInteger(pid) ? pid : undefined
    } else if (line.startsWith("n") && currentPid !== undefined && !cwdByPid.has(currentPid)) {
      cwdByPid.set(currentPid, line.slice(1))
    }
  }

  return cwdByPid
}

// One lsof for every owner, not one per process: Bun spawns on the main
// thread, and a spawn per listening process blocked the server for ~1s a poll.
const readProcessCwds = Effect.fn("LocalHttpServers.readProcessCwds")(function* (pids: number[]) {
  if (pids.length === 0) return new Map<number, string>()
  return yield* execLsof(["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
    timeout: 1_500,
    maxBuffer: 64 * 1024 + pids.length * 4 * 1024,
  }).pipe(
    Effect.map(({ stdout }) => parseLsofCwdOutput(stdout)),
    // lsof exits 1 when any pid has exited or is not ours to inspect, yet still
    // prints the rest. A numeric code means lsof ran to completion; timeouts and
    // overflows have no numeric code and may hold a truncated path.
    Effect.catchTag(COMMAND_ERROR, (error) => {
      const { code, stdout } = error
      return Effect.succeed(typeof code === "number" && typeof stdout === "string"
        ? parseLsofCwdOutput(stdout)
        : new Map<number, string>())
    }),
  )
})

const readParentProcessMap = Effect.fn("LocalHttpServers.readParentProcessMap")(function* () {
  const parentByPid = new Map<number, number>()
  const output = yield* runCommand("ps", ["-axo", "pid=", "-o", "ppid="], {
    timeout: 500,
    maxBuffer: 1024 * 1024,
  }).pipe(
    Effect.map(({ stdout }) => stdout),
    // Process ancestry is an enrichment only; discovery still works without it.
    Effect.catchTag(COMMAND_ERROR, () => Effect.succeed("")),
  )
  for (const line of output.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const ppid = Number(ppidText)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      parentByPid.set(pid, ppid)
    }
  }
  return parentByPid
})

/** Fetches the port's page for its title; null when nothing answers HTTP in time. */
const readHttpServer = Effect.fn("LocalHttpServers.readHttpServer")(function* (
  entry: ListeningPortEntry,
  args: {
    fetchImpl: typeof fetch
    ownerPath?: string
    processName?: string
    projectPath?: string
    projectTerminalRootPids: Set<number>
    parentByPid: Map<number, number>
  },
) {
  const address = `http://localhost:${entry.port}`
  const probe = Effect.gen(function* () {
    // One controller for the request and its body, aborted when the probe
    // ends for any reason, so a slow page stops downloading at the timeout.
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    )
    const response = yield* Effect.tryPromise({
      try: () => args.fetchImpl(address, { signal: controller.signal, redirect: "follow" }),
      catch: (cause) => new LocalHttpProbeError({ port: entry.port, cause }),
    })
    const contentType = response.headers.get("content-type") ?? ""
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new LocalHttpProbeError({ port: entry.port, cause }),
    }).pipe(Effect.catchTag(PROBE_ERROR, () => Effect.succeed("")))
    const title = contentType.toLowerCase().includes("text/html")
      ? extractHtmlTitle(text)
      : ""
    const sameProject = isPathWithin(args.projectPath, args.ownerPath)
      || entry.owners.some((owner) => isDescendantPid(owner.pid, args.projectTerminalRootPids, args.parentByPid))

    const info: LocalHttpServerInfo = {
      title: title || `localhost:${entry.port}`,
      address,
      port: entry.port,
      status: response.status,
      ownerPath: args.ownerPath,
      processName: args.processName,
      sameProject,
    }
    return info
  })
  return yield* probe.pipe(
    Effect.scoped,
    Effect.timeoutOption(LOCAL_HTTP_SCAN_TIMEOUT_MS),
    Effect.map(Option.getOrNull),
    Effect.catchTag(PROBE_ERROR, () => Effect.succeed(null)),
  )
})

/**
 * The HTTP servers listening on this machine, the project's own first. A
 * scan is reused for 30 s while the set of listening ports stays the same.
 */
export const listLocalHttpServers = Effect.fn("LocalHttpServers.list")(function* (options: {
  fetchImpl?: typeof fetch
  projectPath?: string
  projectTerminalRootPids?: ReadonlyArray<number>
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const entries = yield* listListeningTcpEntries()
  const projectTerminalRootPids = new Set(options.projectTerminalRootPids ?? [])
  const cacheKey = `${options.projectPath ?? ""}\u0000${[...projectTerminalRootPids].sort((a, b) => a - b).join(",")}`
  const signature = getListeningEntryListSignature(entries)
  const cached = localHttpServerCache.get(cacheKey)
  if (cached && cached.signature === signature && (yield* Clock.currentTimeMillis) - cached.scannedAt < LOCAL_HTTP_CACHE_TTL_MS) {
    return cached.results
  }

  const parentByPid = yield* readParentProcessMap()
  const ownerPids = new Set(entries.flatMap((entry) => entry.owners.map((owner) => owner.pid)))
  const ownerCwds = yield* readProcessCwds([...ownerPids])

  const results = yield* Effect.forEach(entries, (entry) => {
    const primaryOwner = entry.owners[0]
    const ownerPath = entry.owners.map((owner) => ownerCwds.get(owner.pid)).find(Boolean)
    return readHttpServer(entry, {
      fetchImpl,
      ownerPath,
      processName: primaryOwner?.command,
      projectPath: options.projectPath,
      projectTerminalRootPids,
      parentByPid,
    })
  }, { concurrency: "unbounded" })

  const filteredResults = filterLocalHttpServers(results
    .filter((result): result is LocalHttpServerInfo => result !== null)
  ).sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.port - b.port)
  localHttpServerCache.set(cacheKey, {
    signature,
    scannedAt: yield* Clock.currentTimeMillis,
    results: filteredResults,
  })

  return filteredResults
})
