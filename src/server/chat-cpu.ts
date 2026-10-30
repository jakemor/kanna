import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { availableParallelism, cpus } from "node:os"
import { promisify } from "node:util"
import type { ChatCpuSnapshot } from "../shared/types"

const execFileAsync = promisify(execFile)

/** How often a sample is taken while anyone is watching. */
export const CHAT_CPU_INTERVAL_MS = 5_000

/**
 * Set in each `claude` process's environment to a per-session token, so the
 * monitor can tell which of the server's children belongs to which chat: the
 * SDK does not expose the pid (see `readClaudeQueryPid`).
 */
export const KANNA_PROCESS_TAG_ENV = "KANNA_PROCESS_TAG"

/** Live chats' agent processes: by pid where known, else by process tag. */
export interface ChatProcesses {
  pids: ReadonlyMap<string, number>
  tags: ReadonlyMap<string, string>
}

export interface PsRow {
  pid: number
  ppid: number
  /** `ps`'s own %cpu: a decaying average on macOS, a lifetime one on Linux. */
  cpuPercent: number
  /** Cumulative CPU time, user + system. */
  cpuSeconds: number
}

/** `M:SS.ss` (macOS), `[DD-]HH:MM:SS` (Linux) → seconds. NaN when unreadable. */
export function parseCpuTime(value: string): number {
  const [daysPart, clock] = value.includes("-") ? value.split("-", 2) : [null, value]
  const parts = clock!.split(":").map(Number)
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return Number.NaN
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  if (daysPart !== null) {
    const days = Number(daysPart)
    if (!Number.isFinite(days)) return Number.NaN
    seconds += days * 86_400
  }
  return seconds
}

/** Rows of `ps -ax -o pid=,ppid=,%cpu=,time=`. Lines that do not parse are skipped. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*$/.exec(line)
    if (!match) continue
    const cpuSeconds = parseCpuTime(match[4]!)
    if (!Number.isFinite(cpuSeconds)) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]), cpuSeconds })
  }
  return rows
}

/**
 * Each process's CPU over the interval since `previous`, in percent of one
 * core, from the change in its cumulative CPU time. That is what the tooltip
 * promises ("last 5s"); `ps`'s %cpu is a decaying average on macOS and a
 * lifetime one on Linux. A process missing from `previous` started since, so
 * all of its time is new. With no previous sample (the first tick) there is
 * nothing to difference, and `ps`'s own figure stands in.
 *
 * A process that exited during the interval is not in `rows`, so its time is
 * lost: a short build step can be undercounted, never overcounted.
 */
export function processCpuPercents(
  rows: readonly PsRow[],
  previous: { cpuSecondsByPid: ReadonlyMap<number, number>; elapsedMs: number } | null,
): Map<number, number> {
  const percents = new Map<number, number>()
  for (const row of rows) {
    if (!previous || previous.elapsedMs <= 0) {
      percents.set(row.pid, row.cpuPercent)
      continue
    }
    const before = previous.cpuSecondsByPid.get(row.pid) ?? 0
    // A reused pid, or a clock that rounds down: never negative.
    const delta = Math.max(0, row.cpuSeconds - before)
    percents.set(row.pid, (delta * 1000 * 100) / previous.elapsedMs)
  }
  return percents
}

/**
 * Sums CPU over each chat's process and every descendant of it, so a chat's
 * builds and tests count toward it. A root that is not in `rows` (it exited)
 * gives that chat nothing. A process is counted once even when two roots
 * would both reach it (one root nested in another's tree).
 */
export function sumProcessTreeCpu(
  rows: readonly PsRow[],
  percentByPid: ReadonlyMap<number, number>,
  rootPidByChat: ReadonlyMap<string, number>,
): Map<string, number> {
  const childrenByPid = new Map<number, number[]>()
  const present = new Set<number>()
  for (const row of rows) {
    present.add(row.pid)
    // pid 0's parent is itself on some systems; a loop would never end.
    if (row.pid === row.ppid) continue
    const siblings = childrenByPid.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByPid.set(row.ppid, [row.pid])
  }

  const totals = new Map<string, number>()
  const counted = new Set<number>()
  for (const [chatId, rootPid] of rootPidByChat) {
    if (!present.has(rootPid)) continue
    let total = 0
    const stack = [rootPid]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (counted.has(pid)) continue
      counted.add(pid)
      total += percentByPid.get(pid) ?? 0
      const children = childrenByPid.get(pid)
      if (children) stack.push(...children)
    }
    totals.set(chatId, total)
  }
  return totals
}

/** Logical cores, which a machine-wide share is taken over. */
export function machineCores(): number {
  const cores = typeof availableParallelism === "function" ? availableParallelism() : cpus().length
  return Math.max(1, cores)
}

/**
 * Every chat with a live process, as a share of the whole machine: the
 * per-core total (where 100 is one core) over `cores`, so all of it busy is
 * 100. One decimal under 10, whole above. Under 1 keeps its decimal too (a
 * row shows it as a dimmed "<1%"), so a delegator's total over many quiet
 * sub-chats still adds up on the client.
 */
export function toChatCpuSnapshot(totals: ReadonlyMap<string, number>, cores: number): ChatCpuSnapshot {
  const chats: Record<string, number> = {}
  for (const [chatId, perCore] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    const share = Math.min(100, perCore / cores)
    chats[chatId] = share < 10 ? Math.round(share * 10) / 10 : Math.round(share)
  }
  return { chats, cores }
}

async function readPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,%cpu=,time="], {
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

const PROCESS_TAG_PATTERN = new RegExp(`(?:^|[\\s\\0])${KANNA_PROCESS_TAG_ENV}=([\\w-]+)`)

/**
 * Each pid's `KANNA_PROCESS_TAG`, or null when its environment has none.
 * Pids that could not be read are left out, to be tried again next tick.
 * macOS: one `ps -E` over all of them (the environment follows the command);
 * Linux: `/proc/<pid>/environ`.
 */
async function readProcessTags(pids: readonly number[]): Promise<Map<number, string | null>> {
  const tags = new Map<number, string | null>()
  if (process.platform === "linux") {
    await Promise.all(pids.map(async (pid) => {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, "utf8")
        tags.set(pid, PROCESS_TAG_PATTERN.exec(environ)?.[1] ?? null)
      } catch {
        // Exited, or not ours to read.
      }
    }))
    return tags
  }
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], {
      timeout: 3_000,
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch (error) {
    // `ps` exits 1 when one of the pids has gone, but still lists the rest.
    stdout = (error as { stdout?: string }).stdout ?? ""
  }
  for (const line of stdout.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1]
    if (pid) tags.set(Number(pid), PROCESS_TAG_PATTERN.exec(line)?.[1] ?? null)
  }
  return tags
}

/**
 * Samples each chat's CPU (its agent process plus descendants) every
 * `CHAT_CPU_INTERVAL_MS`, but only while `setActive(true)`: the router turns
 * it on while some client holds a `chat-cpu` subscription. One `ps` call per
 * tick covers every chat, and a tick with no live chat process skips `ps`.
 *
 * A chat comes with its process's pid (Codex) or with the tag its process
 * carries (Claude). A tag is matched against the server's direct children:
 * each new child's environment is read once (one more `ps`, only on a tick
 * where a child has appeared) and remembered until the pid goes away.
 */
export class ChatCpuMonitor {
  private readonly getChatProcesses: () => ChatProcesses
  private readonly read: () => Promise<string>
  private readonly readTags: (pids: readonly number[]) => Promise<Map<number, string | null>>
  private readonly parentPid: number
  private readonly intervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private sampling = false
  private previous: { cpuSecondsByPid: Map<number, number>; at: number } | null = null
  /** The server's children whose environment was read: their tag, or null. */
  private readonly tagByPid = new Map<number, string | null>()
  private readonly cores = machineCores()
  private snapshot: ChatCpuSnapshot = { chats: {}, cores: this.cores }
  private signature = "{}"
  private readonly listeners = new Set<() => void>()

  constructor(args: {
    getChatProcesses: () => ChatProcesses
    readPs?: () => Promise<string>
    readProcessTags?: (pids: readonly number[]) => Promise<Map<number, string | null>>
    /** Whose children carry the tags. Default: this process. */
    parentPid?: number
    intervalMs?: number
    now?: () => number
  }) {
    this.getChatProcesses = args.getChatProcesses
    this.read = args.readPs ?? readPs
    this.readTags = args.readProcessTags ?? readProcessTags
    this.parentPid = args.parentPid ?? process.pid
    this.intervalMs = args.intervalMs ?? CHAT_CPU_INTERVAL_MS
    this.now = args.now ?? Date.now
  }

  getSnapshot(): ChatCpuSnapshot {
    return this.snapshot
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setActive(active: boolean) {
    if (active === (this.timer !== null)) return
    if (!active) {
      clearInterval(this.timer!)
      this.timer = null
      // A sample from minutes ago would difference into a long average.
      this.previous = null
      return
    }
    this.timer = setInterval(() => void this.sample(), this.intervalMs)
    void this.sample()
  }

  dispose() {
    this.setActive(false)
    this.listeners.clear()
  }

  /** One tick. Public for tests. */
  async sample() {
    if (this.sampling) return
    this.sampling = true
    try {
      const { pids, tags } = this.getChatProcesses()
      if (pids.size === 0 && tags.size === 0) {
        this.previous = null
        this.publish({ chats: {}, cores: this.cores })
        return
      }
      let stdout: string
      try {
        stdout = await this.read()
      } catch {
        return
      }
      const at = this.now()
      const rows = parsePsOutput(stdout)
      const percents = processCpuPercents(
        rows,
        this.previous ? { cpuSecondsByPid: this.previous.cpuSecondsByPid, elapsedMs: at - this.previous.at } : null,
      )
      this.previous = { cpuSecondsByPid: new Map(rows.map((row) => [row.pid, row.cpuSeconds])), at }
      const roots = new Map(pids)
      if (tags.size > 0) await this.resolveTags(rows, tags, roots)
      this.publish(toChatCpuSnapshot(sumProcessTreeCpu(rows, percents, roots), this.cores))
    } finally {
      this.sampling = false
    }
  }

  /** Adds to `roots` the pid of each tagged chat's process, where found. */
  private async resolveTags(rows: readonly PsRow[], tags: ReadonlyMap<string, string>, roots: Map<string, number>) {
    const children = new Set<number>()
    for (const row of rows) if (row.ppid === this.parentPid) children.add(row.pid)
    for (const pid of this.tagByPid.keys()) if (!children.has(pid)) this.tagByPid.delete(pid)
    const unread = [...children].filter((pid) => !this.tagByPid.has(pid))
    if (unread.length > 0) {
      try {
        for (const [pid, tag] of await this.readTags(unread)) this.tagByPid.set(pid, tag)
      } catch {
        // Tried again next tick.
      }
    }
    const pidByTag = new Map<string, number>()
    for (const [pid, tag] of this.tagByPid) if (tag) pidByTag.set(tag, pid)
    for (const [chatId, tag] of tags) {
      const pid = pidByTag.get(tag)
      if (pid !== undefined && !roots.has(chatId)) roots.set(chatId, pid)
    }
  }

  private publish(next: ChatCpuSnapshot) {
    const signature = JSON.stringify(next.chats)
    if (signature === this.signature) return
    this.signature = signature
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
