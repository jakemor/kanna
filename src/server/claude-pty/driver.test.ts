import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startClaudeSessionPTY, buildPtyEnv, buildPtyCliArgs, OutputRing, PTY_STDERR_RING_BYTES } from "./driver"
import type { HarnessEvent } from "../harness-types"



describe("startClaudeSessionPTY", () => {
  test("auth precheck fails when credentials missing", async () => {
    if (process.platform === "win32") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-driver-"))
    try {
      await expect(
        startClaudeSessionPTY({
          chatId: "c",
          projectId: "p",
          localPath: "/tmp",
          model: "claude-sonnet-4-6",
          planMode: false,
          forkSession: false,
          oauthToken: null,
          sessionToken: null,
          onToolRequest: async () => null,
          homeDir,
          env: {},
        }),
      ).rejects.toThrow(/claude \/login/)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test("auth precheck fails when ANTHROPIC_API_KEY is set", async () => {
    if (process.platform === "win32") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-driver-"))
    try {
      await mkdir(path.join(homeDir, ".claude"), { recursive: true })
      await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
      await expect(
        startClaudeSessionPTY({
          chatId: "c",
          projectId: "p",
          localPath: "/tmp",
          model: "claude-sonnet-4-6",
          planMode: false,
          forkSession: false,
          oauthToken: null,
          sessionToken: null,
          onToolRequest: async () => null,
          homeDir,
          env: { ANTHROPIC_API_KEY: "sk-x" },
        }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test("refuses to spawn when preflight gate returns not ok", async () => {
    if (process.platform === "win32") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-gate-"))
    try {
      await mkdir(path.join(homeDir, ".claude"), { recursive: true })
      await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
      await expect(
        startClaudeSessionPTY({
          chatId: "c", projectId: "p", localPath: homeDir,
          model: "claude-sonnet-4-6",
          planMode: false, forkSession: false,
          oauthToken: null, sessionToken: null,
          onToolRequest: async () => null,
          homeDir,
          env: {},
          preflightGate: {
            canSpawn: async () => ({ ok: false as const, reason: "built-in reachable: Bash" }),
            invalidateAll: () => {},
          },
        }),
      ).rejects.toThrow(/built-in reachable/)
    } finally { await rm(homeDir, { recursive: true, force: true }) }
  })

  test.skipIf(process.env.KANNA_PTY_E2E !== "1")(
    "E2E: spawn claude, send one prompt, observe one transcript event",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "kanna-pty-e2e-"))
      try {
        const handle = await startClaudeSessionPTY({
          chatId: "e2e",
          projectId: "e2e",
          localPath: dir,
          model: "claude-haiku-4-5-20251001",
          planMode: false,
          forkSession: false,
          oauthToken: null,
          sessionToken: null,
          onToolRequest: async () => null,
        })
        await handle.sendPrompt("Reply with exactly the word: ok")
        const it = handle.stream[Symbol.asyncIterator]()
        const start = Date.now()
        let sawTranscript = false
        while (Date.now() - start < 30_000) {
          const next = await Promise.race([
            it.next(),
            new Promise<IteratorResult<HarnessEvent>>((r) =>
              setTimeout(() => r({ value: undefined as unknown as HarnessEvent, done: false }), 500),
            ),
          ])
          if (next.value?.type === "transcript") {
            sawTranscript = true
            break
          }
        }
        expect(sawTranscript).toBe(true)
        handle.close()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test("sandbox profile is generated and applied when enabled on darwin", async () => {
    if (process.platform !== "darwin") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-sandbox-"))
    try {
      await mkdir(path.join(homeDir, ".claude"), { recursive: true })
      await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
      // We don't actually spawn — we provide a preflightGate that blocks early,
      // so the test only verifies the assembly path. If sandbox path raises before
      // the gate check, the test would throw a different error.
      await expect(
        startClaudeSessionPTY({
          chatId: "c", projectId: "p", localPath: homeDir,
          model: "claude-sonnet-4-6",
          planMode: false, forkSession: false,
          oauthToken: null, sessionToken: null,
          onToolRequest: async () => null,
          homeDir,
          env: { KANNA_PTY_SANDBOX: "on" },
          preflightGate: {
            canSpawn: async () => ({ ok: false as const, reason: "test-block" }),
            invalidateAll: () => {},
          },
        }),
      ).rejects.toThrow(/test-block/)
    } finally { await rm(homeDir, { recursive: true, force: true }) }
  }, 30_000)
})

describe("buildPtyEnv", () => {
  test("sets CLAUDE_CODE_OAUTH_TOKEN when oauthToken present", () => {
    const env = buildPtyEnv({
      baseEnv: {},
      homeDir: "/tmp/home",
      oauthToken: "sk-ant-oat-test",
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test")
    expect(env.HOME).toBe("/tmp/home")
    expect(env.TERM).toBe("xterm-256color")
  })

  test("omits CLAUDE_CODE_OAUTH_TOKEN when oauthToken null", () => {
    const env = buildPtyEnv({
      baseEnv: {},
      homeDir: "/tmp/home",
      oauthToken: null,
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("omits CLAUDE_CODE_OAUTH_TOKEN when oauthToken empty string", () => {
    const env = buildPtyEnv({
      baseEnv: {},
      homeDir: "/tmp/home",
      oauthToken: "",
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("strips ANTHROPIC_API_KEY defensively", () => {
    const env = buildPtyEnv({
      baseEnv: { ANTHROPIC_API_KEY: "should-be-removed" },
      homeDir: "/tmp/home",
      oauthToken: null,
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe("buildPtyCliArgs", () => {
  const baseInput = {
    sessionId: "sess-123",
    model: "claude-sonnet-4-6",
    planMode: false,
    settingsPath: "/tmp/settings.json",
    sessionToken: null,
    forkSession: false,
  }

  test("emits required base flags", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).toContain("--session-id")
    expect(args).toContain("sess-123")
    expect(args).toContain("--model")
    expect(args).toContain("claude-sonnet-4-6")
    expect(args).toContain("--tools")
    expect(args).toContain("mcp__kanna__*")
    expect(args).toContain("--settings")
    expect(args).toContain("/tmp/settings.json")
    expect(args).toContain("--no-update")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("acceptEdits")
  })

  test("plan mode picks 'plan' permission", () => {
    const args = buildPtyCliArgs({ ...baseInput, planMode: true })
    const idx = args.indexOf("--permission-mode")
    expect(args[idx + 1]).toBe("plan")
  })

  test("--effort omitted when undefined", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--effort")
  })

  test("--effort omitted when empty string", () => {
    const args = buildPtyCliArgs({ ...baseInput, effort: "" })
    expect(args).not.toContain("--effort")
  })

  test("--effort appended when provided", () => {
    const args = buildPtyCliArgs({ ...baseInput, effort: "high" })
    const idx = args.indexOf("--effort")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("high")
  })

  test("--resume appended when sessionToken present", () => {
    const args = buildPtyCliArgs({ ...baseInput, sessionToken: "tok-abc" })
    const idx = args.indexOf("--resume")
    expect(args[idx + 1]).toBe("tok-abc")
  })

  test("--fork-session flag when forkSession true", () => {
    const args = buildPtyCliArgs({ ...baseInput, forkSession: true })
    expect(args).toContain("--fork-session")
  })

  test("--add-dir per additional directory", () => {
    const args = buildPtyCliArgs({ ...baseInput, additionalDirectories: ["/a", "/b"] })
    const addDirs = args.reduce<string[]>((acc, val, i) => {
      if (val === "--add-dir") acc.push(args[i + 1])
      return acc
    }, [])
    expect(addDirs).toEqual(["/a", "/b"])
  })

  test("default appended kanna system prompt when no override", () => {
    const args = buildPtyCliArgs(baseInput)
    const idx = args.indexOf("--append-system-prompt")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toContain("Kanna coding agent")
  })

  test("--system-prompt override replaces default append", () => {
    const args = buildPtyCliArgs({ ...baseInput, systemPromptOverride: "custom prompt body" })
    expect(args).not.toContain("--append-system-prompt")
    const idx = args.indexOf("--system-prompt")
    expect(args[idx + 1]).toBe("custom prompt body")
  })

  test("--mcp-config + --strict-mcp-config appended when path provided", () => {
    const args = buildPtyCliArgs({ ...baseInput, mcpConfigPath: "/tmp/mcp-config.json" })
    const idx = args.indexOf("--mcp-config")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json")
    expect(args).toContain("--strict-mcp-config")
  })

  test("--mcp-config omitted when path absent", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--mcp-config")
    expect(args).not.toContain("--strict-mcp-config")
  })
})

describe("OutputRing (B4 stderr ring buffer)", () => {
  test("retains short content verbatim", () => {
    const ring = new OutputRing()
    ring.append("hello ")
    ring.append("world")
    expect(ring.tail()).toBe("hello world")
  })

  test("caps at PTY_STDERR_RING_BYTES, keeping the most recent tail", () => {
    const ring = new OutputRing()
    const big = "A".repeat(PTY_STDERR_RING_BYTES)
    ring.append(big)
    ring.append("TAIL_MARKER")
    const tail = ring.tail()
    expect(tail.length).toBe(PTY_STDERR_RING_BYTES)
    expect(tail.endsWith("TAIL_MARKER")).toBe(true)
    // Oldest bytes evicted.
    expect(tail.startsWith("A")).toBe(true)
    expect(tail).not.toBe(big)
  })

  test("ring size constant is 256 KB", () => {
    expect(PTY_STDERR_RING_BYTES).toBe(256 * 1024)
  })

  test("empty ring tail is empty string", () => {
    expect(new OutputRing().tail()).toBe("")
  })
})
