import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ClaudeProjectDiscoveryAdapter,
  CodexProjectDiscoveryAdapter,
  discoverProjects,
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

describe("project discovery", () => {
  test("Claude adapter decodes saved project paths", () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "alpha-project")
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects")
    const projectMarkerDir = path.join(claudeProjectsDir, encodeClaudeProjectPath(projectDir))

    mkdirSync(projectDir, { recursive: true })
    mkdirSync(projectMarkerDir, { recursive: true })
    utimesSync(projectMarkerDir, new Date("2026-03-16T10:00:00.000Z"), new Date("2026-03-16T10:00:00.000Z"))

    const projects = new ClaudeProjectDiscoveryAdapter().scan(homeDir)

    expect(projects).toEqual([
      {
        provider: "claude",
        repoKey: `path:${projectDir}`,
        localPath: projectDir,
        worktreePaths: [projectDir],
        title: "alpha-project",
        modifiedAt: new Date("2026-03-16T10:00:00.000Z").getTime(),
      },
    ])
  })

  test("Codex adapter reads cwd from session metadata and ignores stale or invalid entries", () => {
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

    const projects = new CodexProjectDiscoveryAdapter().scan(homeDir)

    expect(projects).toEqual([
      {
        provider: "codex",
        repoKey: `path:${liveProjectDir}`,
        localPath: liveProjectDir,
        worktreePaths: [liveProjectDir],
        title: "kanna",
        modifiedAt: Date.parse("2026-03-16T23:05:58.940134Z"),
      },
    ])
  })

  test("Codex adapter falls back to session timestamps and config projects when session index misses CLI entries", () => {
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

    const projects = new CodexProjectDiscoveryAdapter().scan(homeDir)

    expect(projects.map((project) => project.localPath).sort()).toEqual([
      cliProjectDir,
      configOnlyProjectDir,
    ].sort())
    expect(projects.find((project) => project.localPath === cliProjectDir)?.modifiedAt).toBe(
      Date.parse("2026-03-17T03:42:25.751Z")
    )
  })

  test("discoverProjects de-dupes provider results by normalized path and keeps the newest timestamp", () => {
    const adapters: ProjectDiscoveryAdapter[] = [
      {
        provider: "claude",
        scan() {
          return [
            {
              provider: "claude",
              repoKey: "path:/tmp/project",
              localPath: "/tmp/project",
              worktreePaths: ["/tmp/project"],
              title: "Claude Project",
              modifiedAt: 10,
            },
          ]
        },
      },
      {
        provider: "codex",
        scan() {
          return [
            {
              provider: "codex",
              repoKey: "path:/tmp/project",
              localPath: "/tmp/project",
              worktreePaths: ["/tmp/project"],
              title: "Codex Project",
              modifiedAt: 20,
            },
            {
              provider: "codex",
              repoKey: "path:/tmp/other-project",
              localPath: "/tmp/other-project",
              worktreePaths: ["/tmp/other-project"],
              title: "Other Project",
              modifiedAt: 15,
            },
          ]
        },
      },
    ]

    expect(discoverProjects("/unused-home", adapters)).toEqual([
      {
        repoKey: "path:/tmp/project",
        localPath: "/tmp/project",
        worktreePaths: ["/tmp/project"],
        title: "Codex Project",
        modifiedAt: 20,
      },
      {
        repoKey: "path:/tmp/other-project",
        localPath: "/tmp/other-project",
        worktreePaths: ["/tmp/other-project"],
        title: "Other Project",
        modifiedAt: 15,
      },
    ])
  })

  test("discoverProjects merges sibling worktrees under one repo key", () => {
    const adapters: ProjectDiscoveryAdapter[] = [
      {
        provider: "codex",
        scan() {
          return [
            {
              provider: "codex",
              repoKey: "git:/tmp/kanna/.git",
              localPath: "/tmp/kanna-feature",
              worktreePaths: ["/tmp/kanna-feature"],
              title: "kanna",
              modifiedAt: 20,
            },
            {
              provider: "codex",
              repoKey: "git:/tmp/kanna/.git",
              localPath: "/tmp/kanna",
              worktreePaths: ["/tmp/kanna"],
              title: "kanna",
              modifiedAt: 10,
            },
          ]
        },
      },
    ]

    expect(discoverProjects("/unused-home", adapters)).toEqual([
      {
        repoKey: "git:/tmp/kanna/.git",
        localPath: "/tmp/kanna-feature",
        worktreePaths: ["/tmp/kanna-feature", "/tmp/kanna"],
        title: "kanna",
        modifiedAt: 20,
      },
    ])
  })
})
