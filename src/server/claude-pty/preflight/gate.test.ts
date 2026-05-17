import { describe, expect, test } from "bun:test"
import { createPreflightGate } from "./gate"
import type { ProbeResult } from "./types"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

async function fixtureBinary(contents: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-gate-bin-"))
  const f = path.join(dir, "claude")
  await writeFile(f, contents, "utf8")
  return { filePath: f, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const PASS_PROBES: ProbeResult[] = [{ kind: "pass", builtin: "Bash", evidence: "no_builtin_tool_use_in_assistant_turn" }]
const FAIL_PROBES: ProbeResult[] = [{ kind: "fail", builtin: "Bash", evidence: "tool_use:Bash" }]

describe("preflight gate", () => {
  test("concurrent canSpawn calls share a single suite run", async () => {
    const { filePath, cleanup } = await fixtureBinary("v5")
    try {
      let suiteCalls = 0
      let resolveSuite: ((probes: ProbeResult[]) => void) | undefined
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: () => {
          suiteCalls++
          return new Promise<ProbeResult[]>((r) => { resolveSuite = r })
        },
      })
      const p1 = gate.canSpawn({ binaryPath: filePath, model: "m" })
      const p2 = gate.canSpawn({ binaryPath: filePath, model: "m" })
      await new Promise((r) => setTimeout(r, 10))
      if (resolveSuite) (resolveSuite as (probes: ProbeResult[]) => void)(PASS_PROBES)
      await p1; await p2
      expect(suiteCalls).toBe(1)
    } finally { await cleanup() }
  })

  test("cache miss + suite passes → ok and caches", async () => {
    const { filePath, cleanup } = await fixtureBinary("v1")
    try {
      let suiteCalls = 0
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => { suiteCalls++; return PASS_PROBES },
      })
      const r1 = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r1.ok).toBe(true)
      // Second call should hit cache.
      await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(suiteCalls).toBe(1)
    } finally { await cleanup() }
  })

  test("suite fails → not ok with reason", async () => {
    const { filePath, cleanup } = await fixtureBinary("v2")
    try {
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => FAIL_PROBES,
      })
      const r = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("Bash")
    } finally { await cleanup() }
  })

  test("changing binary sha256 invalidates cache", async () => {
    const { filePath: a, cleanup: cA } = await fixtureBinary("v3")
    const { filePath: b, cleanup: cB } = await fixtureBinary("v4")
    try {
      let suiteCalls = 0
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => { suiteCalls++; return PASS_PROBES },
      })
      await gate.canSpawn({ binaryPath: a, model: "m" })
      await gate.canSpawn({ binaryPath: b, model: "m" })
      expect(suiteCalls).toBe(2)
    } finally { await cA(); await cB() }
  })

  test("suite throw → fail-closed (not ok), not an unhandled rejection", async () => {
    const { filePath, cleanup } = await fixtureBinary("v6")
    try {
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => { throw new Error("spawn EACCES") },
      })
      const r = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toContain("fail-closed")
        expect(r.reason).toContain("spawn EACCES")
      }
    } finally { await cleanup() }
  })

  test("suite throw is not cached → next call re-probes", async () => {
    const { filePath, cleanup } = await fixtureBinary("v7")
    try {
      let calls = 0
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => {
          calls++
          if (calls === 1) throw new Error("transient")
          return PASS_PROBES
        },
      })
      const r1 = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r1.ok).toBe(false)
      const r2 = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r2.ok).toBe(true)
      expect(calls).toBe(2)
    } finally { await cleanup() }
  })

  test("canSpawn pass returns the sha256 the suite ran against (for TOCTOU re-verify)", async () => {
    const { filePath, cleanup } = await fixtureBinary("v9")
    try {
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => PASS_PROBES,
      })
      const r = await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.binarySha256).toMatch(/^[0-9a-f]{64}$/)
      }
    } finally { await cleanup() }
  })

  test("verifyBinaryUnchanged: matching sha256 → ok", async () => {
    const { verifyBinaryUnchanged } = await import("./gate")
    const { computeBinarySha256 } = await import("./binary-fingerprint")
    const { filePath, cleanup } = await fixtureBinary("toctou-a")
    try {
      const sha = await computeBinarySha256(filePath)
      const r = await verifyBinaryUnchanged(filePath, sha)
      expect(r.ok).toBe(true)
    } finally { await cleanup() }
  })

  test("verifyBinaryUnchanged: changed bytes → fail-closed with reason", async () => {
    const { verifyBinaryUnchanged } = await import("./gate")
    const { computeBinarySha256 } = await import("./binary-fingerprint")
    const { writeFile } = await import("node:fs/promises")
    const { filePath, cleanup } = await fixtureBinary("toctou-orig")
    try {
      const oldSha = await computeBinarySha256(filePath)
      await writeFile(filePath, "toctou-tampered", "utf8")
      const r = await verifyBinaryUnchanged(filePath, oldSha)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toContain("claude binary changed")
        expect(r.reason).toContain(oldSha.slice(0, 8))
      }
    } finally { await cleanup() }
  })

  test("invalidateAll() forces a re-probe on the next canSpawn", async () => {
    const { filePath, cleanup } = await fixtureBinary("v8")
    try {
      let calls = 0
      const gate = createPreflightGate({
        toolsString: "mcp__kanna__*",
        now: () => 0,
        runSuite: async () => { calls++; return PASS_PROBES },
      })
      await gate.canSpawn({ binaryPath: filePath, model: "m" })
      await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(calls).toBe(1) // cached
      gate.invalidateAll()
      await gate.canSpawn({ binaryPath: filePath, model: "m" })
      expect(calls).toBe(2) // re-probed after wipe
    } finally { await cleanup() }
  })
})
