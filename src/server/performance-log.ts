import { CLIENT_PERFORMANCE_METRICS } from "../shared/performance"
import path from "node:path"
import { Context, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { HostProcess } from "./platform/host-process"
import { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { runCommand } from "./process-utils"
import { capturePlatform } from "./platform"
const DAY_MS = 86_400_000
const MAX_DAILY_BYTES = 8 * 1024 * 1024
const RETENTION_DAYS = 14
const MAX_METRICS = 64

interface Metric {
  count: number
  total: number
  max: number
}

/** One metric of a client's summary, as `mergeClientSummary` accepts it. */
const ClientMetric = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1e6 })),
  total: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  max: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
}).check(Schema.makeFilter((metric) => metric.max <= metric.total || "max is more than total"))

const decodeClientMetric = Schema.decodeUnknownOption(ClientMetric)

export interface PerformanceLogOptions {
  dataDir: string
  /** Bytes one day's file may grow to; samples past it are counted, not written. */
  dailyLimit?: number
  version?: string
}

/**
 * Local performance summaries under `<dataDir>/diagnostics`, one JSON line a
 * minute. They have fixed limits so diagnostics cannot become another leak.
 *
 * Nothing is sampled until `start`. When the layer is released the timers
 * stop and one last line is written.
 */
export class PerformanceLog extends Context.Service<PerformanceLog, {
  readonly directory: string
  readonly record: (name: string, value?: number) => Effect.Effect<void>
  /** Folds in a client's summary; only the known metrics, and only sane values, are kept. */
  readonly mergeClientSummary: (input: unknown, clientId?: string) => Effect.Effect<void>
  /** Starts the minute's line and the event-loop lag probe. Once only, and never after release. */
  readonly start: (sampleResources: () => Record<string, number>) => Effect.Effect<void>
  /** Writes a line now. Never fails: the first failure is logged, later ones are not. */
  readonly flush: Effect.Effect<void>
}>()("@kanna/server/PerformanceLog") {
  static readonly layer = (options: PerformanceLogOptions) => Layer.effect(this, makePerformanceLog(options))
}

const makePerformanceLog = Effect.fn("PerformanceLog.make")(function* (options: PerformanceLogOptions) {
  const fs = yield* FileSystem.FileSystem
  const host = yield* HostProcess
  const machine = yield* Machine
  const spawner = yield* capturePlatform<ProcessSpawner>()
  const scope = yield* Effect.scope
  const directory = path.join(options.dataDir, "diagnostics")
  const dailyLimit = options.dailyLimit ?? MAX_DAILY_BYTES
  const version = options.version ?? "development"
  const metrics = new Map<string, Metric>()
  const clients = new Map<string, { lastSeen: string; metrics: Record<string, Metric> }>()
  let droppedSamples = 0
  let sampleResources: () => Record<string, number> = () => ({})
  let previousCpu = host.cpuUsage()
  let previousTime = performance.now()
  let lastPruneDay = ""
  let warned = false
  let started = false
  let stopped = false
  /** The line being written, which a second `flush` waits on instead of writing its own. */
  let writing: Deferred.Deferred<void> | null = null

  const recordNow = (name: string, value = 1) => {
    if (!Number.isFinite(value) || value < 0 || name.length > 80) return
    let metric = metrics.get(name)
    if (!metric) {
      if (metrics.size >= MAX_METRICS) return
      metric = { count: 0, total: 0, max: 0 }
      metrics.set(name, metric)
    }
    metric.count += 1
    metric.total += value
    metric.max = Math.max(metric.max, value)
  }

  const mergeClientSummary = (input: unknown, clientId?: string) => Effect.sync(() => {
    const sanitized: Record<string, Metric> = {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return
    for (const name of CLIENT_PERFORMANCE_METRICS) {
      const decoded = decodeClientMetric((input as Record<string, unknown>)[name])
      if (Option.isNone(decoded)) continue
      const { count, total, max } = decoded.value
      sanitized[name] = { count, total, max }
      const key = `client_${name}`
      const previous = metrics.get(key) ?? { count: 0, total: 0, max: 0 }
      metrics.set(key, { count: previous.count + count, total: previous.total + total, max: Math.max(previous.max, max) })
    }
    if (clientId && /^[a-f0-9-]{36}$/.test(clientId)) {
      clients.delete(clientId)
      clients.set(clientId, { lastSeen: new Date().toISOString(), metrics: sanitized })
      while (clients.size > 32) clients.delete(clients.keys().next().value!)
    }
  })

  const writeSample = Effect.fn("PerformanceLog.writeSample")(function* () {
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    if (lastPruneDay !== day) {
      for (const name of yield* fs.readDirectory(directory)) {
        const match = /^performance-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
        if (match && Date.parse(match[1]!) <= now - RETENTION_DAYS * DAY_MS) {
          yield* fs.remove(path.join(directory, name), { force: true })
        }
      }
      lastPruneDay = day
    }
    const cpu = host.cpuUsage()
    const time = performance.now()
    const elapsed = Math.max(1, time - previousTime)
    const sampled = Object.fromEntries(metrics)
    metrics.clear()
    for (const [id, client] of clients) {
      if (Date.parse(client.lastSeen) < now - 300_000) clients.delete(id)
    }
    const sample = {
      v: 1,
      version,
      bunVersion: host.runtimeVersion,
      time: new Date(now).toISOString(),
      pid: host.pid,
      uptimeSeconds: host.uptimeSeconds(),
      intervalMs: elapsed,
      memory: host.memoryUsage(),
      cpuPercent: ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000 / elapsed) * 100,
      resources: sampleResources(),
      clients: Object.fromEntries(clients),
      droppedSamples,
      metrics: sampled,
      children: yield* readChildProcessMemory(machine.platform, host.pid).pipe(Effect.provide(spawner)),
    }
    previousCpu = cpu
    previousTime = time
    const file = path.join(directory, `performance-${day}.jsonl`)
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchTag("PlatformError", () => Effect.succeed(0)),
    )
    const line = `${JSON.stringify(sample)}\n`
    if (size + Buffer.byteLength(line) > dailyLimit) {
      droppedSamples += 1
      return
    }
    yield* fs.writeFileString(file, line, { flag: "a", mode: 0o600 })
    droppedSamples = 0
  })

  const flush: Effect.Effect<void> = Effect.suspend(() => {
    if (writing) return Deferred.await(writing)
    const done = Deferred.makeUnsafe<void>()
    writing = done
    return writeSample().pipe(
      Effect.catchTag("PlatformError", (error) => {
        // One warning avoids an error loop when the disk is full.
        if (warned) return Effect.void
        warned = true
        return Effect.logWarning("performance-log: Cannot write diagnostics:", error.message)
      }),
      Effect.ensuring(Effect.suspend(() => {
        writing = null
        return Deferred.succeed(done, undefined)
      })),
    )
  })

  const start = Effect.fn("PerformanceLog.start")(function* (sample: () => Record<string, number>) {
    if (started || stopped) return
    started = true
    sampleResources = sample
    let expected = performance.now() + 1000
    yield* Effect.sync(() => {
      const now = performance.now()
      recordNow("event_loop_lag_ms", Math.max(0, now - expected))
      expected = now + 1000
    }).pipe(Effect.delay("1 second"), Effect.forever, Effect.forkIn(scope))
    yield* flush.pipe(Effect.delay("1 minute"), Effect.forever, Effect.forkIn(scope))
    yield* Effect.forkIn(flush, scope)
  })

  // Runs after the scope has interrupted the timers started above.
  yield* Effect.addFinalizer(() => Effect.suspend(() => {
    stopped = true
    return (writing ? Deferred.await(writing) : Effect.void).pipe(Effect.andThen(flush))
  }))

  return {
    directory,
    record: (name: string, value?: number) => Effect.sync(() => recordNow(name, value)),
    mergeClientSummary,
    start,
    flush,
  } satisfies PerformanceLog["Service"]
})

/** Executable names and numeric process data only. Never collect command arguments. */
const PS_MAX_OUTPUT_BYTES = 1024 * 1024

const readChildProcessMemory = Effect.fn("PerformanceLog.readChildProcessMemory")(function* (
  platform: NodeJS.Platform,
  serverPid: number,
) {
  if (platform === "win32") return null
  const output = yield* runCommand(["ps", "-axo", "pid=,ppid=,rss=,pcpu=,comm="], { stdout: true }).pipe(
    Effect.timeoutOption(3000),
    Effect.orElseSucceed(() => Option.none()),
  )
  // No `ps`, it failed, it timed out or overflowed: the line goes out without children.
  if (Option.isNone(output) || output.value.exitCode !== 0 || output.value.stdout.length > PS_MAX_OUTPUT_BYTES) return null
  return summarizeChildProcesses(output.value.stdout, serverPid)
})

function summarizeChildProcesses(stdout: string, serverPid: number) {
  const processes = stdout.trim().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuPercent: Number(match[4]), executable: path.basename(match[5]!) }] : []
  })
  const ids = new Set([serverPid])
  for (let pass = 0; pass < 32; pass++) {
    const before = ids.size
    for (const child of processes) if (ids.has(child.parent)) ids.add(child.pid)
    if (ids.size === before) break
  }
  const children = processes.filter(child => child.pid !== serverPid && ids.has(child.pid) && child.executable !== "ps")
  return {
    count: children.length,
    rssBytes: children.reduce((sum, child) => sum + child.rssBytes, 0),
    largest: children.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 12),
  }
}
