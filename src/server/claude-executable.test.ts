import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import {
  claudeCodeMinimumVersion,
  readClaudeVersion,
  requireClaudeExecutable,
  resolveClaudeExecutable,
} from "./claude-executable"

const found = (path: string | null) => () => Effect.succeed(path)

describe("resolveClaudeExecutable", () => {
  test("runs the user's claude when it is new enough", async () => {
    const result = await runTest(resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/Users/me/.local/bin/claude"),
      readVersion: () => Effect.succeed("2.1.280"),
      minimumVersion: "2.1.277",
    }))
    expect(result).toEqual({ ok: true, path: "/Users/me/.local/bin/claude", version: "2.1.280" })
  })

  test("an older claude is outdated, with the update named", async () => {
    const result = await runTest(resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/opt/homebrew/bin/claude"),
      readVersion: () => Effect.succeed("2.1.200"),
      minimumVersion: "2.1.277",
    }))
    expect(result).toMatchObject({ ok: false, reason: "outdated", version: "2.1.200" })
    expect(!result.ok && result.message).toContain("claude update")
  })

  test("no claude on PATH is not installed; the SDK's own copy is never the fallback", async () => {
    const result = await runTest(resolveClaudeExecutable({ env: {}, resolveCommandPath: found(null) }))
    expect(result).toMatchObject({ ok: false, reason: "not_installed" })

    const required = await runTest(Effect.result(requireClaudeExecutable({ env: {}, resolveCommandPath: found(null) })))
    expect(Result.isFailure(required)).toBe(true)
    if (Result.isFailure(required)) {
      expect(required.failure._tag).toBe("@kanna/server/claude-executable/ClaudeExecutableError")
      expect(required.failure.message).toContain("isn't installed")
    }
  })

  test("an outdated claude fails requireClaudeExecutable with the reason", async () => {
    const required = await runTest(Effect.result(requireClaudeExecutable({
      env: {},
      resolveCommandPath: found("/opt/homebrew/bin/claude"),
      readVersion: () => Effect.succeed("2.1.200"),
      minimumVersion: "2.1.277",
    })))
    expect(Result.isFailure(required) && required.failure._tag === "@kanna/server/claude-executable/ClaudeExecutableError"
      && required.failure.reason).toBe("outdated")
  })

  test("CLAUDE_EXECUTABLE wins, ~ expanded, without a version check", async () => {
    let versionRead = false
    const result = await runTest(resolveClaudeExecutable({
      env: { CLAUDE_EXECUTABLE: "~/bin/claude-bedrock" },
      resolveCommandPath: found("/usr/local/bin/claude"),
      readVersion: () => Effect.sync(() => {
        versionRead = true
        return "1.0.0"
      }),
    }))
    expect(result).toEqual({ ok: true, path: `${homedir()}/bin/claude-bedrock`, version: null })
    expect(versionRead).toBe(false)
  })

  test("an unreadable version is let through", async () => {
    const result = await runTest(resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/usr/local/bin/claude"),
      readVersion: () => Effect.succeed(null),
      minimumVersion: "2.1.277",
    }))
    expect(result).toMatchObject({ ok: true, version: null })
  })

  test("the floor is the Claude Code version the installed SDK pairs with", () => {
    expect(claudeCodeMinimumVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("readClaudeVersion", () => {
  test("runs the binary once and reuses the answer until the file changes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-claude-version-"))
    try {
      const binary = path.join(dir, "claude")
      const counter = path.join(dir, "runs")
      await writeFile(binary, `#!/bin/sh\necho x >> '${counter}'\necho "2.1.300 (Claude Code)"\n`)
      await chmod(binary, 0o755)

      expect(await runTest(readClaudeVersion(binary))).toBe("2.1.300")
      expect(await runTest(readClaudeVersion(binary))).toBe("2.1.300")
      expect((await Bun.file(counter).text()).trim().split("\n")).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a binary that can't start is a spawn error", async () => {
    const result = await runTest(Effect.result(readClaudeVersion("/nonexistent/kanna-test/claude")))
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
  })
})
