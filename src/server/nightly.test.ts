import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Result } from "effect"
import { ServerPlatform } from "./effect/runtime"
import { runTest } from "./effect/testing"
import {
  fetchMainCommitSha,
  installNightlyBuild,
  nightlyVersion,
  repairBunGlobalManifest,
  runCommandWithTimeout,
  type RunCommandResult,
} from "./nightly"

const SHA = "0123456789abcdef0123456789abcdef01234567"

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

/** A real .tar.gz of a minimal repo (package.json only), like GitHub's codeload archive. */
function createSourceTarball(workDir: string): Buffer {
  const repoDir = path.join(workDir, "repo-root")
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "kanna-code", version: "0.56.7" }))
  const tarPath = path.join(workDir, "fixture.tar.gz")
  const result = spawnSync("tar", ["-czf", tarPath, "-C", workDir, "repo-root"], { stdio: "ignore" })
  expect(result.status).toBe(0)
  return Buffer.from(readFileSync(tarPath))
}

describe("nightlyVersion", () => {
  test("stamps the base version with the short sha", () => {
    expect(nightlyVersion("0.56.7", SHA)).toBe("0.56.7-nightly.0123456")
  })
})

describe("fetchMainCommitSha", () => {
  test("returns the sha from the GitHub API", async () => {
    const fetchImpl = (async () => new Response(`${SHA}\n`)) as unknown as typeof fetch
    expect(await runTest(fetchMainCommitSha(fetchImpl))).toBe(SHA)
  })

  test("fails on non-ok responses, malformed shas and network errors", async () => {
    const lookup = async (fetchImpl: typeof fetch) => {
      const result = await runTest(Effect.result(fetchMainCommitSha(fetchImpl)))
      if (!Result.isFailure(result)) throw new Error("expected the lookup to fail")
      expect(result.failure._tag).toBe("@kanna/server/nightly/MainCommitLookupError")
      return result.failure.message
    }

    expect(await lookup((async () => new Response("nope", { status: 503 })) as unknown as typeof fetch)).toContain("503")
    expect(await lookup((async () => new Response("not-a-sha")) as unknown as typeof fetch)).toContain("commit sha")
    expect(await lookup((async () => { throw new Error("socket hang up") }) as unknown as typeof fetch)).toBe("socket hang up")
  })
})

describe("repairBunGlobalManifest", () => {
  test("keeps every other key of the manifest when it repairs it", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-bun-global-"))
    const manifestDir = path.join(tempDir, "install", "global")
    mkdirSync(manifestDir, { recursive: true })
    const manifestPath = path.join(manifestDir, "package.json")
    writeFileSync(manifestPath, JSON.stringify({ name: "global", dependencies: { "": "." }, private: true }))

    expect(await runTest(repairBunGlobalManifest(tempDir))).toBe(true)
    expect(readFileSync(manifestPath, "utf8")).toBe(`${JSON.stringify({ name: "global", dependencies: {}, private: true }, null, 2)}\n`)
  })

  test("is a no-op when the manifest is not JSON", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-bun-global-"))
    mkdirSync(path.join(tempDir, "install", "global"), { recursive: true })
    writeFileSync(path.join(tempDir, "install", "global", "package.json"), "{ not json")
    expect(await runTest(repairBunGlobalManifest(tempDir))).toBe(false)
  })

  test("strips the corrupt entries `bun install -g .` wrote, keeping real dependencies", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-bun-global-"))
    const manifestDir = path.join(tempDir, "install", "global")
    mkdirSync(manifestDir, { recursive: true })
    const manifestPath = path.join(manifestDir, "package.json")
    writeFileSync(manifestPath, JSON.stringify({
      dependencies: {
        "kanna-code": "^0.57.0",
        "@": "@.",
        "": ".",
        "some-tool": "file:.",
      },
    }))

    expect(await runTest(repairBunGlobalManifest(tempDir))).toBe(true)
    const repaired = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> }
    expect(repaired.dependencies).toEqual({ "kanna-code": "^0.57.0" })

    // Idempotent: a clean manifest reports nothing to repair.
    expect(await runTest(repairBunGlobalManifest(tempDir))).toBe(false)
  })

  test("is a no-op when the manifest is missing", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-bun-global-"))
    expect(await runTest(repairBunGlobalManifest(tempDir))).toBe(false)
  })
})

describe("installNightlyBuild", () => {
  test("downloads main, stamps the version, and runs the build/install steps", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const commands: Array<{ command: string; args: string[]; cwd: string; env?: Record<string, string> }> = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      if (url.includes("codeload.github.com")) {
        expect(url).toContain(SHA)
        return new Response(new Uint8Array(tarball))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const srcDir = path.join(workDir, "src")
    const stampedVersion = "0.56.7-nightly.0123456"
    const expectedTgz = path.join(srcDir, `kanna-code-${stampedVersion}.tgz`)
    const bunGlobalDir = path.join(tempDir, "bun-global")

    const result = await runTest(installNightlyBuild({
      workDir,
      bunGlobalDir,
      fetchImpl,
      runCommand: (command, args, cwd, env) => Effect.sync((): RunCommandResult => {
        commands.push({ command, args, cwd, env })
        if (command === "tar") {
          // Real extraction so the version-stamp step operates on real files.
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: true, output: `${stampedVersion}\n` }
        }
        if (args[0] === "pm" && args[1] === "pack") {
          writeFileSync(expectedTgz, "tarball")
          return { ok: true, output: "" }
        }
        if (args[0] === "install" && args[1] === "-g") {
          // Simulate the global install landing the stamped version.
          const installedDir = path.join(bunGlobalDir, "install", "global", "node_modules", "kanna-code")
          mkdirSync(installedDir, { recursive: true })
          writeFileSync(path.join(installedDir, "package.json"), JSON.stringify({ name: "kanna-code", version: stampedVersion }))
          return { ok: true, output: "" }
        }
        return { ok: true, output: "" }
      }),
    }))

    expect(result.ok).toBe(true)
    expect(result.version).toBe(stampedVersion)

    // The extracted checkout carries the stamped version bun install -g picks up.
    const stamped = JSON.parse(readFileSync(path.join(srcDir, "package.json"), "utf8")) as { version: string }
    expect(stamped.version).toBe(stampedVersion)

    expect(commands.map(({ command, args }) => [command, ...args].join(" "))).toEqual([
      expect.stringContaining("tar -xzf"),
      "bun install",
      "bun run build",
      "bun dist/server/entry.js --version",
      "bun pm pack",
      // The existing registry entry must go first — bun can't switch an
      // installed package to a tarball spec in place (DependencyLoop).
      "bun remove -g kanna-code",
      // Absolute tarball path — never "." (bun mis-parses it; see repairBunGlobalManifest).
      `bun install -g ${expectedTgz}`,
    ])
    // Build steps run inside the extracted source checkout.
    expect(commands.slice(1).every(({ cwd }) => cwd === srcDir)).toBe(true)
    // The startup probe runs the built CLI directly in child mode.
    const probeEnv = commands.find(({ args }) => args.includes("--version"))?.env ?? {}
    expect(Object.keys(probeEnv).length).toBeGreaterThan(0)
    expect(probeEnv.KANNA_DISABLE_SELF_UPDATE).toBe("1")
  })

  test("an install that does not land the stamped version fails instead of reporting success", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")
    const srcDir = path.join(workDir, "src")
    const bunGlobalDir = path.join(tempDir, "bun-global")
    // The global manifest still carries the OLD version after the install —
    // the silent no-op that shipped in 0.57.0's `bun install -g .`.
    const installedDir = path.join(bunGlobalDir, "install", "global", "node_modules", "kanna-code")
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(path.join(installedDir, "package.json"), JSON.stringify({ name: "kanna-code", version: "0.57.0" }))

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await runTest(installNightlyBuild({
      workDir,
      bunGlobalDir,
      fetchImpl,
      runCommand: (command, args, cwd) => Effect.sync((): RunCommandResult => {
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: true, output: "0.56.7-nightly.0123456\n" }
        }
        if (args[0] === "pm" && args[1] === "pack") {
          writeFileSync(path.join(srcDir, "kanna-code-0.56.7-nightly.0123456.tgz"), "tarball")
          return { ok: true, output: "" }
        }
        return { ok: true, output: "" }
      }),
    }))

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("still reports 0.57.0")
    // A failure after the global entry was removed reinstalls the release.
    expect(result.userMessage).toContain("release was reinstalled")
  })

  test("a failed tarball install rolls back to the latest release", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")
    const srcDir = path.join(workDir, "src")

    const commands: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await runTest(installNightlyBuild({
      workDir,
      bunGlobalDir: path.join(tempDir, "bun-global"),
      fetchImpl,
      runCommand: (command, args, cwd) => Effect.sync((): RunCommandResult => {
        commands.push([command, ...args].join(" "))
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: true, output: "0.56.7-nightly.0123456\n" }
        }
        if (args[0] === "pm" && args[1] === "pack") {
          writeFileSync(path.join(srcDir, "kanna-code-0.56.7-nightly.0123456.tgz"), "tarball")
          return { ok: true, output: "" }
        }
        if (args[0] === "install" && args[1] === "-g" && args[2]?.endsWith(".tgz")) {
          return { ok: false, output: "registry is down" }
        }
        return { ok: true, output: "" }
      }),
    }))

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("registry is down")
    expect(result.userMessage).toContain("release was reinstalled")
    expect(commands.at(-1)).toBe("bun install -g kanna-code@latest")
  })

  test("a stop during the global install waits for it, so the machine keeps a kanna", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")
    const srcDir = path.join(workDir, "src")
    const bunGlobalDir = path.join(tempDir, "bun-global")
    const installedDir = path.join(bunGlobalDir, "install", "global", "node_modules", "kanna-code")

    const commands: string[] = []
    const installing = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const fiber = Effect.runFork(installNightlyBuild({
      workDir,
      bunGlobalDir,
      fetchImpl,
      runCommand: (command, args, cwd) => Effect.suspend((): Effect.Effect<RunCommandResult> => {
        commands.push([command, ...args].join(" "))
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return Effect.succeed({ ok: extract.status === 0, output: "" })
        }
        if (args.includes("--version")) return Effect.succeed({ ok: true, output: "0.56.7-nightly.0123456\n" })
        if (args[0] === "pm" && args[1] === "pack") {
          writeFileSync(path.join(srcDir, "kanna-code-0.56.7-nightly.0123456.tgz"), "tarball")
          return Effect.succeed({ ok: true, output: "" })
        }
        if (args[0] === "install" && args[1] === "-g" && args[2]?.endsWith(".tgz")) {
          // The install lands only after the stop has been asked for.
          return Deferred.succeed(installing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => {
              mkdirSync(installedDir, { recursive: true })
              writeFileSync(path.join(installedDir, "package.json"), JSON.stringify({ name: "kanna-code", version: "0.56.7-nightly.0123456" }))
              return { ok: true, output: "" }
            })),
          )
        }
        return Effect.succeed({ ok: true, output: "" })
      }),
    }).pipe(Effect.provide(ServerPlatform)))

    await Effect.runPromise(Deferred.await(installing))
    const stopped = Effect.runPromise(Fiber.interrupt(fiber))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await stopped

    // The install ran to the end and was not rolled back.
    expect(JSON.parse(readFileSync(path.join(installedDir, "package.json"), "utf8")).version).toBe("0.56.7-nightly.0123456")
    expect(commands).not.toContain("bun install -g kanna-code@latest")
  })

  test("a build that fails its startup check is never installed", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const commands: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await runTest(installNightlyBuild({
      workDir,
      fetchImpl,
      runCommand: (command, args, cwd) => Effect.sync((): RunCommandResult => {
        commands.push([command, ...args].join(" "))
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: false, output: "SyntaxError: unexpected token" }
        }
        return { ok: true, output: "" }
      }),
    }))

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("startup check")
    expect(result.userMessage).toContain("SyntaxError")
    // The global install was never touched.
    expect(commands.some((command) => command.includes("install -g"))).toBe(false)
  })

  test("surfaces a failing build step with its output", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await runTest(installNightlyBuild({
      workDir,
      fetchImpl,
      runCommand: (command, args, cwd) => Effect.sync((): RunCommandResult => {
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args[0] === "run") {
          return { ok: false, output: "vite exploded" }
        }
        return { ok: true, output: "" }
      }),
    }))

    expect(result.ok).toBe(false)
    expect(result.version).toBeNull()
    expect(result.userTitle).toBe("Nightly update failed")
    expect(result.userMessage).toContain("build step failed")
    expect(result.userMessage).toContain("vite exploded")
  })

  test("fails cleanly when GitHub is unreachable", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const fetchImpl = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch

    const result = await runTest(installNightlyBuild({
      workDir: path.join(tempDir, "nightly"),
      fetchImpl,
      runCommand: () => Effect.succeed({ ok: true, output: "" }),
    }))

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("502")
  })
})

describe("runCommandWithTimeout", () => {
  test("collects stdout and stderr, and reports a non-zero exit", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const result = await runTest(runCommandWithTimeout("sh", ["-c", "echo out; echo err >&2; exit 3"], tempDir))
    expect(result.ok).toBe(false)
    expect(result.output).toContain("out")
    expect(result.output).toContain("err")
  })

  test("reports a command that can't start instead of failing", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const result = await runTest(runCommandWithTimeout("kanna-no-such-command", [], tempDir))
    expect(result.ok).toBe(false)
    expect(result.output).toContain("kanna-no-such-command")
  })

  test("passes extra env through to the step", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const result = await runTest(runCommandWithTimeout("sh", ["-c", "printf %s \"$KANNA_STEP\""], tempDir, { KANNA_STEP: "probe" }))
    expect(result).toEqual({ ok: true, output: "probe" })
  })
})
