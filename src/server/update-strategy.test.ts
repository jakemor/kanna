import { describe, expect, test } from "bun:test"
import { NpmChecker, SupervisorExitReloader, UpdateInstallError, createUpdateStrategy, GitChecker, Pm2Reloader } from "./update-strategy"

describe("NpmChecker", () => {
  test("reports update available when latest is newer", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => "0.13.0",
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "0.13.0", updateAvailable: true })
  })

  test("reports no update when versions match", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.13.0",
      fetchLatestVersion: async () => "0.13.0",
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "0.13.0", updateAvailable: false })
  })

  test("propagates fetch errors", async () => {
    const checker = new NpmChecker({
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => { throw new Error("registry down") },
    })
    await expect(checker.check()).rejects.toThrow("registry down")
  })
})

describe("SupervisorExitReloader", () => {
  test("installs target version when invoked", async () => {
    const calls: Array<{ packageName: string; version: string }> = []
    const reloader = new SupervisorExitReloader({
      targetVersion: () => "0.13.0",
      installVersion: (packageName, version) => {
        calls.push({ packageName, version })
        return { ok: true, errorCode: null, userTitle: null, userMessage: null }
      },
    })
    await reloader.reload()
    expect(calls).toEqual([{ packageName: "kanna-code", version: "0.13.0" }])
  })

  test("throws UpdateInstallError with structured fields when install fails", async () => {
    const reloader = new SupervisorExitReloader({
      targetVersion: () => "0.13.0",
      installVersion: () => ({
        ok: false,
        errorCode: "version_not_live_yet",
        userTitle: "Update not live yet",
        userMessage: "This update is still propagating. Try again in a few minutes.",
      }),
    })
    await expect(reloader.reload()).rejects.toBeInstanceOf(UpdateInstallError)
    await expect(reloader.reload()).rejects.toMatchObject({
      message: "This update is still propagating. Try again in a few minutes.",
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
    })
  })

  test("throws when target version cannot be resolved", async () => {
    const reloader = new SupervisorExitReloader({
      targetVersion: () => null,
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
    })
    await expect(reloader.reload()).rejects.toThrow(/target version/i)
  })
})

describe("GitChecker", () => {
  const makeRunGit = (responses: Record<string, string>) => async (args: string[]) => {
    const key = args.join(" ")
    if (!(key in responses)) throw new Error(`unexpected git call: ${key}`)
    return responses[key]
  }

  test("reports update when HEAD differs from upstream", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: makeRunGit({
        "fetch origin main": "",
        "rev-parse HEAD": "abc123def456\n",
        "rev-parse origin/main": "deadbeef99887\n",
      }),
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "deadbee", updateAvailable: true })
  })

  test("reports no update when HEAD matches upstream", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: makeRunGit({
        "fetch origin main": "",
        "rev-parse HEAD": "abc123def456\n",
        "rev-parse origin/main": "abc123def456\n",
      }),
    })
    const result = await checker.check()
    expect(result).toEqual({ latestVersion: "abc123d", updateAvailable: false })
  })

  test("propagates git fetch errors", async () => {
    const checker = new GitChecker({
      repoDir: "/tmp/repo",
      branch: "main",
      runGit: async () => { throw new Error("fetch failed: network") },
    })
    await expect(checker.check()).rejects.toThrow(/fetch failed/)
  })
})

describe("createUpdateStrategy", () => {
  const baseDeps = {
    currentVersion: "0.12.0",
    fetchLatestVersion: async () => "0.13.0",
    installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
    latestVersionHint: () => "0.13.0",
  } as const

  test("defaults to npm + supervisor-exit when env unset", () => {
    const strategy = createUpdateStrategy({ reloaderEnv: undefined, ...baseDeps })
    expect(strategy.checker).toBeInstanceOf(NpmChecker)
    expect(strategy.reloader).toBeInstanceOf(SupervisorExitReloader)
  })

  test("uses npm + supervisor-exit when env=supervisor", () => {
    const strategy = createUpdateStrategy({ reloaderEnv: "supervisor", ...baseDeps })
    expect(strategy.checker).toBeInstanceOf(NpmChecker)
    expect(strategy.reloader).toBeInstanceOf(SupervisorExitReloader)
  })

  test("throws on unknown reloader value", () => {
    expect(() => createUpdateStrategy({ reloaderEnv: "bogus", ...baseDeps })).toThrow(/unknown.*reloader/i)
  })
})

describe("Pm2Reloader", () => {
  function makeReloader(overrides: {
    lockfileChanged?: boolean
    commandErrors?: Record<string, string>
    reloadError?: Error | null
  } = {}) {
    const calls: string[] = []
    const reloader = new Pm2Reloader({
      repoDir: "/tmp/repo",
      processName: "kanna",
      runCommand: async (command, args) => {
        const line = [command, ...args].join(" ")
        calls.push(line)
        if (overrides.commandErrors?.[line]) {
          throw new Error(overrides.commandErrors[line])
        }
      },
      lockfileChanged: async () => overrides.lockfileChanged ?? false,
      triggerPm2Reload: async () => {
        calls.push("pm2.reload kanna")
        if (overrides.reloadError) throw overrides.reloadError
      },
    })
    return { reloader, calls }
  }

  test("runs git pull, build, then pm2 reload when lockfile unchanged", async () => {
    const { reloader, calls } = makeReloader({ lockfileChanged: false })
    await reloader.reload()
    expect(calls).toEqual([
      "git pull --ff-only",
      "bun run build",
      "pm2.reload kanna",
    ])
  })

  test("inserts bun install when lockfile changed", async () => {
    const { reloader, calls } = makeReloader({ lockfileChanged: true })
    await reloader.reload()
    expect(calls).toEqual([
      "git pull --ff-only",
      "bun install",
      "bun run build",
      "pm2.reload kanna",
    ])
  })

  test("aborts before reload when git pull fails", async () => {
    const { reloader, calls } = makeReloader({
      commandErrors: { "git pull --ff-only": "merge conflict in src/foo.ts" },
    })
    await expect(reloader.reload()).rejects.toThrow(/git pull failed/i)
    expect(calls).toEqual(["git pull --ff-only"])
  })

  test("aborts before reload when build fails", async () => {
    const { reloader, calls } = makeReloader({
      commandErrors: { "bun run build": "tsc error TS2345" },
    })
    await expect(reloader.reload()).rejects.toThrow(/bun run build failed/i)
    expect(calls).toEqual(["git pull --ff-only", "bun run build"])
  })

  test("surfaces pm2 reload failures", async () => {
    const { reloader } = makeReloader({ reloadError: new Error("pm2 daemon not running") })
    await expect(reloader.reload()).rejects.toThrow(/pm2 reload failed/i)
  })
})

describe("createUpdateStrategy pm2 branch", () => {
  test("returns GitChecker + Pm2Reloader for KANNA_RELOADER=pm2", () => {
    const strategy = createUpdateStrategy({
      reloaderEnv: "pm2",
      currentVersion: "0.12.0",
      fetchLatestVersion: async () => "ignored",
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
      latestVersionHint: () => null,
      repoDir: "/tmp/repo",
    })
    expect(strategy.checker).toBeInstanceOf(GitChecker)
    expect(strategy.reloader).toBeInstanceOf(Pm2Reloader)
  })

  test("throws when pm2 mode selected without repoDir", () => {
    expect(() =>
      createUpdateStrategy({
        reloaderEnv: "pm2",
        currentVersion: "0.12.0",
        fetchLatestVersion: async () => "ignored",
        installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
        latestVersionHint: () => null,
      }),
    ).toThrow(/KANNA_REPO_DIR/)
  })
})
