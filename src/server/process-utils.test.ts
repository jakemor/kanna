import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Option, Result } from "effect"
import { runTest } from "./effect/testing"
import {
  commandExists,
  hasCommand,
  mergePathLists,
  parseShellPathOutput,
  resolveCommandPath,
  runCommand,
  spawnDetached,
} from "./process-utils"

let fakeHome: string | null = null

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  fakeHome = null
})

describe("resolveCommandPath", () => {
  test("finds binaries the login-shell PATH misses in well-known user bin dirs", async () => {
    // e.g. the native Claude Code installer's ~/.local/bin, whose PATH line
    // goes to the interactive shell rc that `sh -lc` never reads on macOS.
    fakeHome = mkdtempSync(path.join(tmpdir(), "kanna-home-"))
    const binDir = path.join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const binary = path.join(binDir, "kanna-fake-cli")
    writeFileSync(binary, "#!/bin/sh\nexit 0\n")
    chmodSync(binary, 0o755)

    expect(await runTest(resolveCommandPath("kanna-fake-cli", fakeHome))).toBe(binary)
    expect(await runTest(resolveCommandPath("kanna-missing-cli", fakeHome))).toBeNull()
  })

  test("login-shell resolution still wins when it succeeds", async () => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "kanna-home-"))
    expect(await runTest(resolveCommandPath("sh", fakeHome))).toMatch(/\/sh$/)
  })
})

describe("mergePathLists", () => {
  test("keeps the current order and appends only what the shell adds", () => {
    expect(mergePathLists("/a:/usr/bin:/b", "/home/.local/bin:/usr/bin:/a::/c")).toBe(
      "/a:/usr/bin:/b:/home/.local/bin:/c"
    )
  })

  test("uses the shell PATH when the current one is empty", () => {
    expect(mergePathLists("", "/x:/y")).toBe("/x:/y")
  })
})

describe("parseShellPathOutput", () => {
  test("ignores rc-file noise around the markers", () => {
    const output = "Welcome!\n__KANNA_SHELL_PATH__\n/one:/two\n__KANNA_SHELL_PATH__\nbye\n"
    expect(parseShellPathOutput(output)).toBe("/one:/two")
  })

  test("returns null when the shell printed nothing usable", () => {
    expect(parseShellPathOutput("")).toBeNull()
    expect(parseShellPathOutput("__KANNA_SHELL_PATH__\n\n__KANNA_SHELL_PATH__")).toBeNull()
  })
})

describe("spawnDetached", () => {
  test("fails when the command does not exist", async () => {
    const result = await runTest(Effect.result(spawnDetached("definitely-not-a-real-command-kanna", [])))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
      expect(result.failure.message).toBe("Command not found: definitely-not-a-real-command-kanna")
    }
  })

  test("succeeds when the process starts successfully", async () => {
    expect(await runTest(spawnDetached("sh", ["-c", "exit 0"]))).toBeUndefined()
  })
})

describe("runCommand", () => {
  test("collects the exit code and the streams asked for", async () => {
    const output = await runTest(runCommand(["sh", "-c", "echo out; echo err >&2; exit 3"], { stdout: true, stderr: true }))
    expect(output).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" })
  })

  test("fails with CommandSpawnError when the command does not exist", async () => {
    const result = await runTest(Effect.result(runCommand(["definitely-not-a-real-command-kanna"])))
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
  })

  test("kills the process when interrupted", async () => {
    const marker = path.join(tmpdir(), `kanna-run-command-${process.pid}-${Date.now()}`)
    const timedOut = await runTest(
      runCommand(["sh", "-c", `sleep 1; touch ${marker}`]).pipe(Effect.timeoutOption("50 millis")),
    )
    expect(Option.isNone(timedOut)).toBe(true)
    await Bun.sleep(1_300)
    expect(existsSync(marker)).toBe(false)
  })
})

describe("command probes", () => {
  test("find what is installed and miss what is not", async () => {
    expect(await runTest(commandExists("sh"))).toBe(true)
    expect(await runTest(commandExists("definitely-not-a-real-command-kanna"))).toBe(false)
    expect(await runTest(hasCommand("sh"))).toBe(true)
    expect(await runTest(hasCommand("definitely-not-a-real-command-kanna"))).toBe(false)
  })
})
