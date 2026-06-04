import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClaudePtyRegistry, killProcessTree } from "./pid-registry.adapter"

let tempDir = ""
let registryPath = ""

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kanna-claude-pty-registry-"))
  registryPath = path.join(tempDir, "claude-pty.json")
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe("ClaudePtyRegistry", () => {
  test("register persists entries with sessionId, pid, cwd, runtimeDir", async () => {
    const registry = new ClaudePtyRegistry(registryPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 12345, cwd: "/tmp/a", runtimeDir: "/tmp/r1" })
    await registry.register({ chatId: "c2", sessionId: "s2", pid: 23456, cwd: "/tmp/b", runtimeDir: "/tmp/r2" })

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as {
      entries: Array<{ chatId: string; sessionId: string; pid: number; runtimeDir: string }>
    }
    expect(raw.entries).toHaveLength(2)
    expect(raw.entries[0]).toMatchObject({ chatId: "c1", sessionId: "s1", pid: 12345, cwd: "/tmp/a", runtimeDir: "/tmp/r1" })
    expect(raw.entries[1]).toMatchObject({ chatId: "c2", sessionId: "s2", pid: 23456, cwd: "/tmp/b", runtimeDir: "/tmp/r2" })
  })

  test("re-registering the same pid replaces the prior entry", async () => {
    const registry = new ClaudePtyRegistry(registryPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 100, cwd: "/tmp/old", runtimeDir: "/tmp/r-old" })
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 100, cwd: "/tmp/new", runtimeDir: "/tmp/r-new" })

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { entries: Array<{ pid: number; runtimeDir: string }> }
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0]?.pid).toBe(100)
    expect(raw.entries[0]?.runtimeDir).toBe("/tmp/r-new")
  })

  test("re-spawn of the same sessionId with a new pid keeps BOTH entries (identity is pid, not sessionId)", async () => {
    // A chat re-spawns its claude PTY via --resume <sessionId>: the old and
    // new processes briefly coexist with the SAME sessionId but DIFFERENT pids.
    // Both must be tracked so reap can reach whichever survives.
    const registry = new ClaudePtyRegistry(registryPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 38830, cwd: "/tmp/a", runtimeDir: "/tmp/r-old" })
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 41506, cwd: "/tmp/a", runtimeDir: "/tmp/r-new" })

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { entries: Array<{ pid: number }> }
    expect(raw.entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([38830, 41506])
  })

  test("unregister(pid) removes only the matching pid", async () => {
    const registry = new ClaudePtyRegistry(registryPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 1, cwd: "/tmp/a", runtimeDir: "/tmp/r1" })
    await registry.register({ chatId: "c2", sessionId: "s2", pid: 2, cwd: "/tmp/b", runtimeDir: "/tmp/r2" })
    await registry.unregister(1)

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { entries: Array<{ pid: number }> }
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0]?.pid).toBe(2)
  })

  test("unregister(stale pid) does NOT remove the live re-spawn entry sharing the sessionId", async () => {
    // Regression for the leak: the OLD handle's deferred cleanup must not
    // delete the NEW handle's entry just because they share a sessionId.
    const registry = new ClaudePtyRegistry(registryPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 38830, cwd: "/tmp/a", runtimeDir: "/tmp/r-old" })
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 41506, cwd: "/tmp/a", runtimeDir: "/tmp/r-new" })
    await registry.unregister(38830) // old handle's cleanupResources

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { entries: Array<{ pid: number }> }
    expect(raw.entries.map((e) => e.pid)).toEqual([41506])
  })

  test("reapStale kills live process groups, removes runtimeDirs, and clears the file", async () => {
    const child = Bun.spawn(
      ["python3", "-c", "import os, sys, time; os.setsid(); sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(60)"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    )
    const reader = child.stdout.getReader()
    const decoded = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array())
    expect(decoded).toContain("ready")
    reader.releaseLock()
    const childPid = child.pid

    const runtimeDir = path.join(tempDir, "spawn-runtime")
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(path.join(runtimeDir, "mcp-config.json"), "{}", "utf8")

    await writeFile(
      registryPath,
      JSON.stringify({
        entries: [
          { chatId: "c1", sessionId: "s1", pid: childPid, cwd: "/tmp/a", runtimeDir, createdAt: Date.now() },
          { chatId: "c2", sessionId: "s2", pid: 999_999_999, cwd: "/tmp/b", runtimeDir: "/tmp/nonexistent", createdAt: Date.now() },
        ],
      }),
      "utf8",
    )

    const registry = new ClaudePtyRegistry(registryPath)
    const reaped = await registry.reapStale()

    expect(reaped.map((entry) => entry.sessionId).sort()).toEqual(["s1", "s2"])

    const exited = await Promise.race([
      child.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ])
    expect(exited).not.toBe("timeout")
    expect(child.signalCode).toBe("SIGKILL")
    void childPid

    // runtimeDir cleaned up
    await expect(stat(runtimeDir)).rejects.toThrow()

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { entries: unknown[] }
    expect(raw.entries).toEqual([])
  }, 30_000)

  test("killProcessTree reaps a NON-leader process and its descendants", async () => {
    // Reproduces the PM2 deployment: the PTY child is NOT its own process-group
    // leader (it inherits the server's pgid), so the old `kill(-pid)` was a
    // no-op. killProcessTree must walk children by ppid and SIGKILL the whole
    // subtree by pid. Parent forks a `sleep` child WITHOUT setsid; both share
    // the test runner's process group.
    const parent = Bun.spawn(
      [
        "python3",
        "-c",
        "import subprocess, sys, time; c = subprocess.Popen(['sleep', '120']); "
          + "sys.stdout.write(str(c.pid) + '\\n'); sys.stdout.flush(); time.sleep(120)",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    )
    const reader = parent.stdout.getReader()
    const childLine = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array()).trim()
    reader.releaseLock()
    const childPid = Number.parseInt(childLine, 10)
    expect(Number.isFinite(childPid)).toBe(true)
    const parentPid = parent.pid

    await killProcessTree(parentPid)

    const exited = await Promise.race([
      parent.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ])
    expect(exited).not.toBe("timeout")

    // The descendant `sleep` must also be gone (kill 0 throws ESRCH once dead).
    await new Promise((r) => setTimeout(r, 200))
    let childAlive = true
    try { process.kill(childPid, 0) } catch { childAlive = false }
    expect(childAlive).toBe(false)
  }, 30_000)

  test("killProcessTree ignores an invalid pid without throwing", async () => {
    await killProcessTree(0)
    await killProcessTree(-1)
    await killProcessTree(Number.NaN)
  })

  test("reapStale tolerates a missing registry file", async () => {
    const registry = new ClaudePtyRegistry(registryPath)
    const reaped = await registry.reapStale()
    expect(reaped).toEqual([])
  })

  test("reapStale tolerates a malformed registry file", async () => {
    await writeFile(registryPath, "not json", "utf8")
    const registry = new ClaudePtyRegistry(registryPath)
    const reaped = await registry.reapStale()
    expect(reaped).toEqual([])
  })

  test("register creates the parent directory if missing", async () => {
    const nestedPath = path.join(tempDir, "nested", "deep", "claude-pty.json")
    const registry = new ClaudePtyRegistry(nestedPath)
    await registry.register({ chatId: "c1", sessionId: "s1", pid: 1, cwd: "/tmp/a", runtimeDir: "/tmp/r1" })
    const raw = JSON.parse(await readFile(nestedPath, "utf8")) as { entries: unknown[] }
    expect(raw.entries).toHaveLength(1)
  })
})
