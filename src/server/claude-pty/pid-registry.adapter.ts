import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

/**
 * On-disk registry of claude PTY children so a non-graceful server crash
 * does not leak orphan claude processes (a Bun.Terminal child survives parent
 * death). On the next server boot `reapStale()` SIGKILLs each recorded
 * process subtree and removes its runtimeDir (mcp-config.json + settings).
 *
 * Identity is the OS `pid`, NOT the `sessionId`: a chat re-spawns its claude
 * PTY via `--resume <sessionId>`, so old and new processes briefly coexist
 * with the same sessionId but different pids.
 *
 * Reap kills by process SUBTREE (`killProcessTree`), NOT by process group.
 * Under a process supervisor (e.g. PM2) the PTY child inherits the server's
 * pgid rather than becoming its own group leader, so the old `kill(-pid)`
 * either no-op'd (empty group → orphan survived) or, had the pgid matched,
 * would have SIGKILL'd the entire kanna app.
 *
 * Mirrors {@link import("../terminal-pid-registry").TerminalPidRegistry}
 * but adds `runtimeDir` so we can clean up the tmp dir kanna allocated
 * for the spawn (otherwise it leaks every restart).
 */
export interface ClaudePtyEntry {
  chatId: string
  sessionId: string
  pid: number
  cwd: string
  runtimeDir: string
  createdAt: number
}

interface RegistryFile {
  entries: ClaudePtyEntry[]
}

export class ClaudePtyRegistry {
  private readonly filePath: string
  private entries: ClaudePtyEntry[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async register(entry: Omit<ClaudePtyEntry, "createdAt">): Promise<void> {
    await this.loadIfNeeded()
    // Dedupe on pid (the stable process identity), not sessionId — see the
    // class doc: --resume re-spawns share a sessionId but differ by pid.
    const next = this.entries.filter((existing) => existing.pid !== entry.pid)
    next.push({ ...entry, createdAt: Date.now() })
    this.entries = next
    await this.persist()
  }

  async unregister(pid: number): Promise<void> {
    await this.loadIfNeeded()
    this.entries = this.entries.filter((entry) => entry.pid !== pid)
    await this.persist()
  }

  async reapStale(): Promise<ClaudePtyEntry[]> {
    const stored = await this.readFromDisk()
    if (stored.length === 0) {
      this.entries = []
      this.loaded = true
      return []
    }
    for (const entry of stored) {
      await killProcessTree(entry.pid)
      // Best-effort: remove the spawn's runtimeDir (mcp-config.json +
      // settings.local.json + any other kanna-side scratch). Children
      // wrote nothing user-facing here, but the dir leaks per restart
      // without cleanup.
      if (entry.runtimeDir && entry.runtimeDir.length > 0) {
        try { await rm(entry.runtimeDir, { recursive: true, force: true }) } catch {
          /* swallow — best-effort */
        }
      }
    }
    this.entries = []
    this.loaded = true
    await this.persist()
    return stored
  }

  private async loadIfNeeded() {
    if (this.loaded) return
    this.entries = await this.readFromDisk()
    this.loaded = true
  }

  private async readFromDisk(): Promise<ClaudePtyEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>
      if (!parsed || !Array.isArray(parsed.entries)) return []
      return parsed.entries.filter(isValidEntry)
    } catch {
      return []
    }
  }

  private async persist() {
    const snapshot: RegistryFile = { entries: [...this.entries] }
    const serialized = JSON.stringify(snapshot)
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, serialized, "utf8")
      })
    await this.writeQueue
  }
}

function isValidEntry(value: unknown): value is ClaudePtyEntry {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ClaudePtyEntry>
  return (
    typeof candidate.chatId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.pid === "number"
    && Number.isFinite(candidate.pid)
    && typeof candidate.cwd === "string"
    && typeof candidate.runtimeDir === "string"
    && typeof candidate.createdAt === "number"
  )
}

/**
 * SIGKILL `pid` and every descendant, identified by walking the live
 * pid→ppid table. Kills by pid, never by process group: a Bun.Terminal child
 * is not guaranteed to be its own group leader (under PM2 it inherits the
 * server's pgid), so `kill(-pid)` is unreliable (empty-group no-op) or
 * dangerous (could signal the whole app). Descendants are collected BEFORE
 * any signal is sent, so a process that reparents after its parent dies is
 * still reached. Best-effort: ESRCH/EPERM and a failed `ps` are swallowed.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") return
  if (!Number.isFinite(pid) || pid <= 0) return

  const targets = [pid, ...(await collectDescendants(pid))]
  // Leaves-first: signal descendants before the root so a parent cannot
  // re-fork on the way down (claude children are inert here, but cheap).
  for (const target of targets.reverse()) {
    try {
      process.kill(target, "SIGKILL")
    } catch {
      // ESRCH (already gone) and EPERM (race with kernel reap) are fine.
    }
  }
}

/** Read the live pid→ppid table via `ps` and BFS the descendants of `root`. */
async function collectDescendants(root: number): Promise<number[]> {
  let childrenByParent: Map<number, number[]>
  try {
    const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    childrenByParent = parsePidPpid(text)
  } catch {
    return []
  }

  const descendants: number[] = []
  const queue = [root]
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

function parsePidPpid(psOutput: string): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>()
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number.parseInt(match[1] as string, 10)
    const ppid = Number.parseInt(match[2] as string, 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const siblings = childrenByParent.get(ppid)
    if (siblings) siblings.push(pid)
    else childrenByParent.set(ppid, [pid])
  }
  return childrenByParent
}
