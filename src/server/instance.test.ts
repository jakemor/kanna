import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTest } from "./effect/testing"
import { instanceFingerprint, probeExistingInstance } from "./instance"
import { startKannaServer } from "./server-bun"

const stops: Array<() => Promise<void>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("instanceFingerprint", () => {
  test("is stable per data dir, distinct across dirs, and non-reversible-looking", () => {
    expect(instanceFingerprint("/a/b")).toBe(instanceFingerprint("/a/b"))
    expect(instanceFingerprint("/a/b")).not.toBe(instanceFingerprint("/a/c"))
    expect(instanceFingerprint("/a/b")).toMatch(/^[0-9a-f]{16}$/)
    // Relative paths resolve before hashing.
    expect(instanceFingerprint(path.resolve("x"))).toBe(instanceFingerprint("x"))
  })
})

describe("probeExistingInstance", () => {
  test("finds a running same-data-dir instance and ignores foreign ones", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-instance-"))
    tempDirs.push(dataDir)
    const server = await startKannaServer({ dataDir, port: 4381 })
    stops.push(server.stop)

    const match = await runTest(probeExistingInstance(server.port, dataDir))
    expect(match).toEqual({ localUrl: `http://localhost:${server.port}`, port: server.port })

    // Same server, different expected data dir (e.g. dev profile) → no match.
    const mismatch = await runTest(probeExistingInstance(server.port, "/somewhere/else"))
    expect(mismatch).toBeNull()
  })

  test("nothing listening → null", async () => {
    expect(await runTest(probeExistingInstance(4382, "/whatever"))).toBeNull()
  })

  test("non-kanna server → null", async () => {
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: 4383,
      fetch: () => Response.json({ hello: "world" }),
    })
    try {
      expect(await runTest(probeExistingInstance(4383, "/whatever"))).toBeNull()
    } finally {
      foreign.stop(true)
    }
  })

  test("a server that never answers → null after the timeout", async () => {
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 4384,
      fetch: () => new Promise<Response>(() => {}),
    })
    try {
      const started = Date.now()
      expect(await runTest(probeExistingInstance(4384, "/whatever"))).toBeNull()
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      silent.stop(true)
    }
  })
})
