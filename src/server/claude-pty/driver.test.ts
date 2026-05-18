import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startClaudeSessionPTY, buildPtyEnv, buildPtyCliArgs, OutputRing, PTY_STDERR_RING_BYTES, deriveAccountInfoFromLabel, planModeRuntimeAction, PLAN_MODE_EXIT_UNSUPPORTED } from "./driver"
import { KANNA_SYSTEM_PROMPT_APPEND } from "../../shared/kanna-system-prompt"
import type { HarnessEvent } from "../harness-types"



describe("startClaudeSessionPTY", () => {
  test("auth precheck fails when credentials missing", async () => {
    if (process.platform === "win32") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-driver-"))
    try {
      let err: unknown
      try {
        await startClaudeSessionPTY({
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
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/OAuth pool token/)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test("auth precheck fails when ANTHROPIC_API_KEY is set", async () => {
    if (process.platform === "win32") return
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-driver-"))
    try {
      let err: unknown
      try {
        await startClaudeSessionPTY({
          chatId: "c",
          projectId: "p",
          localPath: "/tmp",
          model: "claude-sonnet-4-6",
          planMode: false,
          forkSession: false,
          oauthToken: "sk-ant-oat-x",
          sessionToken: null,
          onToolRequest: async () => null,
          homeDir,
          env: { ANTHROPIC_API_KEY: "sk-x" },
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/ANTHROPIC_API_KEY/)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  // Preflight gate removed: kanna trusts the claude CLI as the source of
  // truth for tool execution. The PreflightGate arg is still accepted on the
  // driver interface (back-compat with callers) but is never invoked.

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

  // OS sandbox wrap removed: kanna trusts the claude CLI as the source of
  // truth and runs it directly under the kanna server's own process boundary.
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
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
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
    sessionToken: null,
    forkSession: false,
  }

  test("emits required base flags", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).toContain("--session-id")
    expect(args).toContain("sess-123")
    expect(args).toContain("--model")
    expect(args).toContain("claude-sonnet-4-6")
    expect(args).not.toContain("--no-update")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("acceptEdits")
  })

  test("does NOT restrict tools — model uses claude built-ins", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--tools")
    expect(args).not.toContain("mcp__kanna__*")
  })

  test("loads user/project/local setting sources (no --settings override)", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--settings")
    const idx = args.indexOf("--setting-sources")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("user,project,local")
  })

  test("emits stream-json driver flags (--print + I/O format + verbose)", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).toContain("--print")
    expect(args).toContain("--output-format=stream-json")
    expect(args).toContain("--input-format=stream-json")
    expect(args).toContain("--verbose")
  })

  test("emits --dangerously-skip-permissions (personal-use bypass)", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).toContain("--dangerously-skip-permissions")
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

  test("resume mode: --resume only, no --session-id (claude rejects both together)", () => {
    const args = buildPtyCliArgs({ ...baseInput, sessionToken: "tok-abc" })
    expect(args).not.toContain("--session-id")
    expect(args).not.toContain("--fork-session")
    const idx = args.indexOf("--resume")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("tok-abc")
  })

  test("new-session mode (no token, no fork): --session-id, no --resume", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--resume")
    expect(args).not.toContain("--fork-session")
    const idx = args.indexOf("--session-id")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("sess-123")
  })

  test("fork mode: --session-id + --resume + --fork-session all three", () => {
    const args = buildPtyCliArgs({ ...baseInput, sessionToken: "tok-abc", forkSession: true })
    expect(args).toContain("--fork-session")
    const sid = args.indexOf("--session-id")
    expect(sid).toBeGreaterThan(-1)
    expect(args[sid + 1]).toBe("sess-123")
    const resume = args.indexOf("--resume")
    expect(resume).toBeGreaterThan(-1)
    expect(args[resume + 1]).toBe("tok-abc")
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

  test("D8: appended prompt is the shared KANNA_SYSTEM_PROMPT_APPEND when no override is supplied", () => {
    const args = buildPtyCliArgs(baseInput)
    const idx = args.indexOf("--append-system-prompt")
    expect(args[idx + 1]).toBe(KANNA_SYSTEM_PROMPT_APPEND)
    // Regression guard: PTY must carry the full trusted-developer /
    // security-research guidance, not the old one-sentence stub.
    expect(args[idx + 1]).toContain("Reverse-engineering, security research")
  })

  test("D8b: systemPromptAppend overrides the static default (dynamic subagent roster path)", () => {
    const dynamic = `${KANNA_SYSTEM_PROMPT_APPEND}\n\n## Available subagents\n\n- codereview [id=sa-1]: review PR diffs`
    const args = buildPtyCliArgs({ ...baseInput, systemPromptAppend: dynamic })
    const idx = args.indexOf("--append-system-prompt")
    expect(args[idx + 1]).toBe(dynamic)
    expect(args[idx + 1]).toContain("Available subagents")
    expect(args[idx + 1]).toContain("codereview [id=sa-1]")
  })

  test("--system-prompt override replaces default append", () => {
    const args = buildPtyCliArgs({ ...baseInput, systemPromptOverride: "custom prompt body" })
    expect(args).not.toContain("--append-system-prompt")
    const idx = args.indexOf("--system-prompt")
    expect(args[idx + 1]).toBe("custom prompt body")
  })

  test("--mcp-config appended without --strict-mcp-config (user MCPs merge with kanna's)", () => {
    const args = buildPtyCliArgs({ ...baseInput, mcpConfigPath: "/tmp/mcp-config.json" })
    const idx = args.indexOf("--mcp-config")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json")
    expect(args).not.toContain("--strict-mcp-config")
  })

  test("--mcp-config omitted when path absent", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--mcp-config")
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

describe("deriveAccountInfoFromLabel (C1)", () => {
  test("undefined label → null (UI falls back, no bogus chip)", () => {
    expect(deriveAccountInfoFromLabel(undefined)).toBeNull()
  })

  test("empty label → null", () => {
    expect(deriveAccountInfoFromLabel("")).toBeNull()
  })

  test("label → AccountInfo with organization + kanna-oauth-pool source", () => {
    expect(deriveAccountInfoFromLabel("work-account")).toEqual({
      organization: "work-account",
      tokenSource: "kanna-oauth-pool",
    })
  })
})

describe("planModeRuntimeAction (stream-json control_request)", () => {
  test("planMode=true → control_request set_permission_mode=plan", () => {
    const action = planModeRuntimeAction(true)
    expect(action.kind).toBe("control")
    if (action.kind !== "control") throw new Error("expected control action")
    expect(action.request).toEqual({ type: "set_permission_mode", mode: "plan" })
  })

  test("planMode=false → warn (stream-json mode has no leave-plan)", () => {
    const action = planModeRuntimeAction(false)
    expect(action.kind).toBe("warn")
    if (action.kind !== "warn") throw new Error("expected warn action")
    expect(action.message).toBe(PLAN_MODE_EXIT_UNSUPPORTED)
  })
})
