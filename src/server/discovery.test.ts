import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { runTest } from "./effect/testing"
import {
  makeClaudeDiscoveryAdapter,
  makeCodexDiscoveryAdapter,
  makeGrokDiscoveryAdapter,
  ProjectDiscovery,
  type ProjectDiscoveryAdapter,
} from "./discovery"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-discovery-"))
  tempDirs.push(directory)
  return directory
}

function encodeClaudeProjectPath(localPath: string) {
  return `-${localPath.replace(/\//g, "-")}`
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const scanCodex = (homeDir: string) =>
  runTest(makeCodexDiscoveryAdapter().pipe(Effect.flatMap((adapter) => adapter.scan(homeDir))))

const discover = (homeDir: string, adapters: ProjectDiscoveryAdapter[]) =>
  runTest(Effect.gen(function* () {
    const discovery = yield* ProjectDiscovery
    return yield* discovery.discover(homeDir)
  }).pipe(Effect.provide(ProjectDiscovery.layer({ adapters }))))

describe("project discovery", () => {
  test("Claude adapter decodes saved project paths", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "alpha-project")
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects")
    const projectMarkerDir = path.join(claudeProjectsDir, encodeClaudeProjectPath(projectDir))

    mkdirSync(projectDir, { recursive: true })
    mkdirSync(projectMarkerDir, { recursive: true })
    utimesSync(projectMarkerDir, new Date("2026-03-16T10:00:00.000Z"), new Date("2026-03-16T10:00:00.000Z"))

    const projects = await runTest(makeClaudeDiscoveryAdapter.pipe(Effect.flatMap((adapter) => adapter.scan(homeDir))))

    expect(projects).toEqual([
      {
        provider: "claude",
        localPath: projectDir,
        title: "alpha-project",
        modifiedAt: new Date("2026-03-16T10:00:00.000Z").getTime(),
      },
    ])
  })

  test("Codex adapter reads cwd from session metadata and ignores stale or invalid entries", async () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "16")
    const liveProjectDir = path.join(homeDir, "workspace", "kanna")
    const missingProjectDir = path.join(homeDir, "workspace", "missing-project")
    mkdirSync(liveProjectDir, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(path.join(homeDir, ".codex", "session_index.jsonl"), [
      JSON.stringify({
        id: "session-live",
        updated_at: "2026-03-16T23:05:58.940134Z",
      }),
      JSON.stringify({
        id: "session-missing",
        updated_at: "2026-03-16T20:05:58.940134Z",
      }),
      JSON.stringify({
        id: "session-relative",
        updated_at: "2026-03-16T21:05:58.940134Z",
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T23-05-52-session-live.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T23:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-live",
          cwd: liveProjectDir,
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T20-05-52-session-missing.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T20:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-missing",
          cwd: missingProjectDir,
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T21-05-52-session-relative.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T21:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-relative",
          cwd: "./relative-path",
        },
      }),
    ].join("\n"))

    const projects = await scanCodex(homeDir)

    expect(projects).toEqual([
      {
        provider: "codex",
        localPath: liveProjectDir,
        title: "kanna",
        modifiedAt: Date.parse("2026-03-16T23:05:58.940134Z"),
      },
    ])
  })

  test("Codex adapter falls back to session timestamps and config projects when session index misses CLI entries", async () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "16")
    const cliProjectDir = path.join(homeDir, "workspace", "codex-test-2")
    const configOnlyProjectDir = path.join(homeDir, "workspace", "config-only")
    mkdirSync(cliProjectDir, { recursive: true })
    mkdirSync(configOnlyProjectDir, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(path.join(homeDir, ".codex", "session_index.jsonl"), "")
    writeFileSync(path.join(homeDir, ".codex", "config.toml"), [
      `personality = "pragmatic"`,
      `[projects."${configOnlyProjectDir}"]`,
      `trust_level = "trusted"`,
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T23-42-24-cli-session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-17T03:42:25.751Z",
        type: "session_meta",
        payload: {
          id: "cli-session",
          timestamp: "2026-03-17T03:42:24.578Z",
          cwd: cliProjectDir,
          originator: "codex-tui",
          source: "cli",
        },
      }),
    ].join("\n"))

    const projects = await scanCodex(homeDir)

    expect(projects.map((project) => project.localPath).sort()).toEqual([
      cliProjectDir,
      configOnlyProjectDir,
    ].sort())
    expect(projects.find((project) => project.localPath === cliProjectDir)?.modifiedAt).toBe(
      Date.parse("2026-03-17T03:42:25.751Z")
    )
  })

  test("discover de-dupes provider results by normalized path and keeps the newest timestamp", async () => {
    const adapters: ProjectDiscoveryAdapter[] = [
      {
        provider: "claude",
        scan: () => Effect.succeed([
          {
            provider: "claude",
            localPath: "/tmp/project",
            title: "Claude Project",
            modifiedAt: 10,
          },
        ]),
      },
      {
        provider: "codex",
        scan: () => Effect.succeed([
            {
              provider: "codex",
              localPath: "/tmp/project",
              title: "Codex Project",
              modifiedAt: 20,
            },
            {
              provider: "codex",
              localPath: "/tmp/other-project",
              title: "Other Project",
              modifiedAt: 15,
            },
        ]),
      },
    ]

    expect(await discover("/unused-home", adapters)).toEqual([
      {
        localPath: "/tmp/project",
        title: "Codex Project",
        modifiedAt: 20,
      },
      {
        localPath: "/tmp/other-project",
        title: "Other Project",
        modifiedAt: 15,
      },
    ])
  })

  function writeCodexSession(filePath: string, sessionId: string, cwd: string, mtime: Date) {
    writeFileSync(filePath, JSON.stringify({
      timestamp: "2026-03-16T23:05:52.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd },
    }))
    utimesSync(filePath, mtime, mtime)
  }

  function makeCountingCodexAdapter() {
    const reads: string[] = []
    const adapter = runTest(makeCodexDiscoveryAdapter({
      readFileHead: (filePath) => Effect.sync(() => {
        reads.push(filePath)
        return readFileSync(filePath, "utf8")
      }),
    }))
    return { scan: async (homeDir: string) => runTest((await adapter).scan(homeDir)), reads }
  }

  test("Codex adapter does not reopen a session file whose mtime and size are unchanged", async () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const firstProject = path.join(homeDir, "workspace", "aaaa")
    const secondProject = path.join(homeDir, "workspace", "bbbb")
    mkdirSync(firstProject, { recursive: true })
    mkdirSync(secondProject, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })
    const sessionFile = path.join(sessionsDir, "rollout-session.jsonl")
    const mtime = new Date("2026-03-16T23:05:52.000Z")
    writeCodexSession(sessionFile, "session", firstProject, mtime)

    const { scan, reads } = makeCountingCodexAdapter()
    expect((await scan(homeDir)).map((project) => project.localPath)).toEqual([firstProject])
    expect(reads).toEqual([sessionFile])

    // Same length, same mtime: the cache must answer without opening the file,
    // so the stale cwd is what comes back.
    writeCodexSession(sessionFile, "session", secondProject, mtime)
    expect((await scan(homeDir)).map((project) => project.localPath)).toEqual([firstProject])
    expect(reads).toEqual([sessionFile])
  })

  test("Codex adapter rereads a session file after its mtime changes and forgets deleted files", async () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const firstProject = path.join(homeDir, "workspace", "aaaa")
    const secondProject = path.join(homeDir, "workspace", "bbbb")
    mkdirSync(firstProject, { recursive: true })
    mkdirSync(secondProject, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })
    const sessionFile = path.join(sessionsDir, "rollout-session.jsonl")
    writeCodexSession(sessionFile, "session", firstProject, new Date("2026-03-16T23:05:52.000Z"))

    const { scan, reads } = makeCountingCodexAdapter()
    await scan(homeDir)

    writeCodexSession(sessionFile, "session", secondProject, new Date("2026-03-16T23:10:00.000Z"))
    expect((await scan(homeDir)).map((project) => project.localPath)).toEqual([secondProject])
    expect(reads).toEqual([sessionFile, sessionFile])

    rmSync(sessionFile)
    expect(await scan(homeDir)).toEqual([])
    writeCodexSession(sessionFile, "session", secondProject, new Date("2026-03-16T23:10:00.000Z"))
    await scan(homeDir)
    expect(reads).toEqual([sessionFile, sessionFile, sessionFile])
  })

  test("discover shares one scan between concurrent callers", async () => {
    let scans = 0
    await runTest(Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const adapters: ProjectDiscoveryAdapter[] = [
        {
          provider: "claude",
          scan: () => Effect.gen(function* () {
            scans += 1
            yield* Deferred.await(gate)
            return [{ provider: "claude" as const, localPath: "/tmp/project", title: "Project", modifiedAt: 1 }]
          }),
        },
      ]

      yield* Effect.gen(function* () {
        const discovery = yield* ProjectDiscovery
        const first = yield* Effect.forkChild(discovery.discover("/unused-home"))
        const second = yield* Effect.forkChild(discovery.discover("/unused-home"))
        yield* Effect.promise(() => Bun.sleep(10))
        yield* Deferred.succeed(gate, undefined)
        const firstResult = yield* Fiber.join(first)
        const secondResult = yield* Fiber.join(second)
        expect(scans).toBe(1)
        expect(secondResult).toEqual(firstResult)

        // Once settled, the next call scans again rather than returning a stale result.
        yield* discovery.discover("/unused-home")
        expect(scans).toBe(2)
      }).pipe(Effect.provide(ProjectDiscovery.layer({ adapters })))
    }))
  })

  test("a caller that goes away doesn't cancel the scan the others share", async () => {
    let scans = 0
    await runTest(Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const adapters: ProjectDiscoveryAdapter[] = [
        {
          provider: "claude",
          scan: () => Effect.gen(function* () {
            scans += 1
            yield* Deferred.await(gate)
            return [{ provider: "claude" as const, localPath: "/tmp/project", title: "Project", modifiedAt: 1 }]
          }),
        },
      ]

      yield* Effect.gen(function* () {
        const discovery = yield* ProjectDiscovery
        const leaving = yield* Effect.forkChild(discovery.discover("/unused-home"))
        const staying = yield* Effect.forkChild(discovery.discover("/unused-home"))
        yield* Effect.promise(() => Bun.sleep(10))
        yield* Fiber.interrupt(leaving)
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.join(staying)).toEqual([{ localPath: "/tmp/project", title: "Project", modifiedAt: 1 }])
        expect(scans).toBe(1)
      }).pipe(Effect.provide(ProjectDiscovery.layer({ adapters })))
    }))
  })

  test("Grok adapter decodes URI-encoded session folders and skips undecodable ones", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "grok project")
    const sessionsDir = path.join(homeDir, ".grok", "sessions")
    mkdirSync(projectDir, { recursive: true })
    const folder = path.join(sessionsDir, encodeURIComponent(projectDir))
    mkdirSync(folder, { recursive: true })
    mkdirSync(path.join(sessionsDir, "%E0%A4%A"), { recursive: true })
    writeFileSync(path.join(sessionsDir, "not-a-folder"), "")
    utimesSync(folder, new Date("2026-03-16T10:00:00.000Z"), new Date("2026-03-16T10:00:00.000Z"))

    const projects = await runTest(makeGrokDiscoveryAdapter.pipe(Effect.flatMap((adapter) => adapter.scan(homeDir))))

    expect(projects).toEqual([
      {
        provider: "grok",
        localPath: projectDir,
        title: "grok project",
        modifiedAt: new Date("2026-03-16T10:00:00.000Z").getTime(),
      },
    ])
  })

  test("a home with no provider history discovers nothing", async () => {
    const homeDir = makeTempDir()
    const projects = await runTest(
      Effect.gen(function* () {
        const discovery = yield* ProjectDiscovery
        return yield* discovery.discover(homeDir)
      }).pipe(Effect.provide(ProjectDiscovery.layer())),
    )
    expect(projects).toEqual([])
  })
})
