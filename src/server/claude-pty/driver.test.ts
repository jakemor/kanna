import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startClaudeSessionPTY, buildPtyEnv, buildPtyCliArgs, OutputRing, PTY_STDERR_RING_BYTES, PTY_DISALLOWED_NATIVE_TOOLS, deriveAccountInfoFromOauth, PLAN_MODE_EXIT_UNSUPPORTED, SHIFT_TAB_KEY } from "./driver"
import type { TranscriptStream } from "./tui-source"
import type { PtyProcess, SpawnPtyProcessArgs } from "./pty-process"
import { KANNA_SYSTEM_PROMPT_APPEND } from "../../shared/kanna-system-prompt"
import type { HarnessEvent } from "../harness-types"
import { readAppSettingsSnapshot } from "../app-settings"



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

  // ANTHROPIC_API_KEY in the parent env no longer fails the auth precheck:
  // PTY mode is OAuth-only and buildPtyEnv unconditionally strips the key
  // from the child env, so the CLI can never bill API. Coverage moved to
  // auth.test.ts ("ANTHROPIC_API_KEY in parent env does not block ...") and
  // the "strips ANTHROPIC_API_KEY defensively" buildPtyEnv test below.

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

  test.skipIf(process.env.KANNA_PTY_E2E !== "1")(
    "E2E: setPermissionMode(true/false) — plan mode enter via /plan, exit via Shift+Tab",
    async () => {
      if (process.platform === "win32") return
      const settings = await readAppSettingsSnapshot()
      const activeEntry = settings.claudeAuth.tokens.find((t) => t.status === "active")
      if (!activeEntry) {
        console.warn("[e2e] no active OAuth token in Kanna settings — skipping plan-mode E2E")
        return
      }
      const dir = await mkdtemp(path.join(tmpdir(), "kanna-pty-pm-e2e-"))
      try {
        const handle = await startClaudeSessionPTY({
          chatId: "e2e-pm", projectId: "e2e-pm", localPath: dir,
          model: "claude-haiku-4-5-20251001",
          planMode: false, forkSession: false,
          oauthToken: activeEntry.token,
          sessionToken: null,
          onToolRequest: async () => null,
        })
        try {
          const iter = handle.stream[Symbol.asyncIterator]()

          async function awaitResult(label: string, timeoutMs = 30_000) {
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
              const next = await Promise.race([
                iter.next(),
                new Promise<IteratorResult<HarnessEvent>>((r) =>
                  setTimeout(() => r({ value: undefined as unknown as HarnessEvent, done: false }), 500),
                ),
              ])
              const ev = next.value as HarnessEvent | undefined
              if (ev?.type === "transcript"
                && (ev.entry as { kind?: string } | undefined)?.kind === "result") {
                return true
              }
            }
            throw new Error(`${label}: timed out waiting for result entry`)
          }

          // Enter plan mode; wait for TUI to process slash command.
          await handle.setPermissionMode(true)
          await new Promise((r) => setTimeout(r, 800))

          await handle.sendPrompt("Reply with exactly the word: plantest")
          await awaitResult("plan-mode prompt")

          // Exit plan mode via Shift+Tab; wait for TUI to process keypress.
          await handle.setPermissionMode(false)
          await new Promise((r) => setTimeout(r, 800))

          // Session must still accept prompts after the Shift+Tab key sequence.
          await handle.sendPrompt("Reply with exactly the word: normaltest")
          await awaitResult("post-shift-tab prompt")
        } finally {
          handle.close()
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    90_000,
  )

  // OS sandbox wrap removed: kanna trusts the claude CLI as the source of
  // truth and runs it directly under the kanna server's own process boundary.
})

describe("startClaudeSessionPTY smoke-test gate", () => {
  test("refuses spawn when gate returns ok:false", async () => {
    const failingGate: import("./smoke-test").SmokeTestGate = {
      async canSpawn() { return { ok: false, reason: "disallowedTools regression" } },
    }
    await expect(startClaudeSessionPTY({
      chatId: "c1", projectId: "p1", localPath: "/tmp",
      model: "claude-opus-4-7", planMode: false, forkSession: false,
      oauthToken: "test-token", sessionToken: null,
      onToolRequest: async () => null,
      smokeTestGate: failingGate,
      env: { HOME: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
    })).rejects.toThrow(/smoke-test refused/i)
  })
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

describe("buildPtyCliArgs TUI mode", () => {
  test("does NOT include --print", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "m", planMode: false,
      sessionToken: null, forkSession: false,
    })
    expect(args).not.toContain("--print")
  })

  test("does NOT include --output-format / --input-format / --verbose", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "m", planMode: false,
      sessionToken: null, forkSession: false,
    })
    expect(args.find((a) => a.startsWith("--output-format"))).toBeUndefined()
    expect(args.find((a) => a.startsWith("--input-format"))).toBeUndefined()
    expect(args).not.toContain("--verbose")
  })

  test("includes core TUI args", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "claude-opus-4-7", planMode: false,
      sessionToken: null, forkSession: false,
    })
    expect(args).toContain("--model")
    expect(args).toContain("claude-opus-4-7")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("acceptEdits")
    expect(args).toContain("--dangerously-skip-permissions")
  })

  test("new sessions omit --session-id (interactive TUI ignores it; mtime filter handles JSONL discovery)", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "m", planMode: false,
      sessionToken: null, forkSession: false,
    })
    expect(args).not.toContain("--session-id")
    expect(args).not.toContain("--resume")
  })

  test("resume passes --resume <token> without --session-id", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "m", planMode: false,
      sessionToken: "tok-abc", forkSession: false,
    })
    expect(args).toContain("--resume")
    expect(args).toContain("tok-abc")
    expect(args).not.toContain("--session-id")
    expect(args).not.toContain("--fork-session")
  })

  test("fork passes --session-id + --resume + --fork-session", () => {
    const args = buildPtyCliArgs({
      sessionId: "fork-uuid", model: "m", planMode: false,
      sessionToken: "old-tok", forkSession: true,
    })
    expect(args).toContain("--session-id")
    expect(args).toContain("fork-uuid")
    expect(args).toContain("--resume")
    expect(args).toContain("old-tok")
    expect(args).toContain("--fork-session")
  })

  test("plan mode uses plan permission mode", () => {
    const args = buildPtyCliArgs({
      sessionId: "s1", model: "m", planMode: true,
      sessionToken: null, forkSession: false,
    })
    expect(args).toContain("plan")
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

  test("new-session mode (no token, no fork): no --session-id, no --resume, no --fork-session", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--resume")
    expect(args).not.toContain("--fork-session")
    expect(args).not.toContain("--session-id")
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

  test("--mcp-config appended WITH --strict-mcp-config (TUI mode: strict so CLI ignores user MCP config)", () => {
    const args = buildPtyCliArgs({ ...baseInput, mcpConfigPath: "/tmp/mcp-config.json" })
    const idx = args.indexOf("--mcp-config")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json")
    expect(args).toContain("--strict-mcp-config")
  })

  test("--mcp-config omitted when path absent", () => {
    const args = buildPtyCliArgs(baseInput)
    expect(args).not.toContain("--mcp-config")
  })

  // ── Issue #215: disallow native AskUserQuestion/ExitPlanMode under PTY ────

  test("disallows native AskUserQuestion + ExitPlanMode (forces the mcp__kanna__ shims)", () => {
    const args = buildPtyCliArgs(baseInput)
    const idx = args.indexOf("--disallowedTools")
    expect(idx).toBeGreaterThan(-1)
    expect(args.slice(idx + 1)).toEqual(["AskUserQuestion", "ExitPlanMode"])
    expect(PTY_DISALLOWED_NATIVE_TOOLS).toEqual(["AskUserQuestion", "ExitPlanMode"])
    // EnterPlanMode is intentionally NOT disallowed (no user round-trip;
    // SDK canUseTool never intercepts it — keeps SDK↔PTY parity).
    expect(args).not.toContain("EnterPlanMode")
  })

  test("--disallowedTools is last so its variadic args cannot swallow another flag", () => {
    const args = buildPtyCliArgs({ ...baseInput, mcpConfigPath: "/tmp/mcp-config.json" })
    const idx = args.indexOf("--disallowedTools")
    expect(idx).toBe(args.length - PTY_DISALLOWED_NATIVE_TOOLS.length - 1)
  })

  test("--disallowedTools coexists with --append-system-prompt (index assertion still holds)", () => {
    const args = buildPtyCliArgs(baseInput)
    const idx = args.indexOf("--append-system-prompt")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe(KANNA_SYSTEM_PROMPT_APPEND)
    expect(args).toContain("--disallowedTools")
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

describe("deriveAccountInfoFromOauth (C1)", () => {
  test("no label and no masked key → null (UI falls back, no bogus chip)", () => {
    expect(deriveAccountInfoFromOauth({})).toBeNull()
  })

  test("empty label and empty masked → null", () => {
    expect(deriveAccountInfoFromOauth({ label: "", oauthKeyMasked: "" })).toBeNull()
  })

  test("label only → AccountInfo with organization + kanna-oauth-pool source", () => {
    expect(deriveAccountInfoFromOauth({ label: "work-account" })).toEqual({
      organization: "work-account",
      tokenSource: "kanna-oauth-pool",
    })
  })

  test("masked key only → AccountInfo with oauthKeyMasked + kanna-oauth-pool source", () => {
    expect(deriveAccountInfoFromOauth({ oauthKeyMasked: "sk-ant-oat01...1234" })).toEqual({
      oauthKeyMasked: "sk-ant-oat01...1234",
      tokenSource: "kanna-oauth-pool",
    })
  })

  test("label + masked → AccountInfo with both fields", () => {
    expect(deriveAccountInfoFromOauth({ label: "work-account", oauthKeyMasked: "sk-ant-oat01...1234" })).toEqual({
      organization: "work-account",
      oauthKeyMasked: "sk-ant-oat01...1234",
      tokenSource: "kanna-oauth-pool",
    })
  })
})

describe("PLAN_MODE_EXIT_UNSUPPORTED (state-unknown warning)", () => {
  test("PLAN_MODE_EXIT_UNSUPPORTED references plan mode and acceptEdits", () => {
    expect(PLAN_MODE_EXIT_UNSUPPORTED).toContain("plan mode")
    expect(PLAN_MODE_EXIT_UNSUPPORTED).toContain("acceptEdits")
  })
})

describe("SHIFT_TAB_KEY constant", () => {
  test("is the VT100 Shift+Tab sequence", () => {
    expect(SHIFT_TAB_KEY).toBe("\x1b[Z")
  })
})

// ── F1: setPermissionMode — plan mode exit via Shift+Tab ────────────────────

async function makeTestHandle(opts?: { planMode?: boolean }) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pm-"))
  const sentInputs: string[] = []
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((r) => { exitResolve = r })

  const fakePty: PtyProcess = {
    async sendInput(data) { sentInputs.push(data) },
    resize() {},
    exited,
    close() { exitResolve(0) },
    kill() { exitResolve(137) },
  }

  const fakeSpawn = async (spawnArgs: SpawnPtyProcessArgs): Promise<PtyProcess> => {
    spawnArgs.onOutput?.("❯ ")
    return fakePty
  }

  const fakeSmoke: import("./smoke-test").SmokeTestGate = {
    async canSpawn() { return { ok: true } },
  }

  const neverStream: TranscriptStream = {
    lines: {
      [Symbol.asyncIterator]() {
        return { next(): Promise<IteratorResult<string, undefined>> { return new Promise(() => {}) } }
      },
    },
    filePath: new Promise<string>(() => {}),
    close() {},
  }

  const handle = await startClaudeSessionPTY({
    chatId: "test", projectId: "test", localPath: homeDir,
    model: "claude-haiku-4-5-20251001",
    planMode: opts?.planMode ?? false,
    forkSession: false,
    oauthToken: "test-token",
    sessionToken: null,
    onToolRequest: async () => null,
    homeDir,
    env: {
      HOME: homeDir,
      CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      KANNA_PTY_TRUST_DISMISS: "disabled",
      CLAUDE_EXECUTABLE: "/bin/sh",
    },
    spawnPtyProcess: fakeSpawn,
    startKannaMcpHttpServer: async () => ({ url: "http://127.0.0.1:0/mcp", bearerToken: "test", close: async () => {} }),
    startTranscriptStreamFn: async () => neverStream,
    smokeTestGate: fakeSmoke,
  })

  return {
    handle,
    sentInputs,
    async cleanup() {
      exitResolve(0)
      handle.close()
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

describe("setPermissionMode (F1 — plan mode exit)", () => {
  test("setPermissionMode(true) sends /plan\\r and tracks state", async () => {
    if (process.platform === "win32") return
    const { handle, sentInputs, cleanup } = await makeTestHandle()
    try {
      await handle.setPermissionMode(true)
      expect(sentInputs).toContain("/plan\r")
    } finally {
      await cleanup()
    }
  }, 10_000)

  test("setPermissionMode(false) after true sends Shift+Tab \\x1b[Z", async () => {
    if (process.platform === "win32") return
    const { handle, sentInputs, cleanup } = await makeTestHandle()
    try {
      await handle.setPermissionMode(true)
      sentInputs.length = 0
      await handle.setPermissionMode(false)
      expect(sentInputs).toContain(SHIFT_TAB_KEY)
    } finally {
      await cleanup()
    }
  }, 10_000)

  test("setPermissionMode(false) when started with planMode:true sends Shift+Tab", async () => {
    if (process.platform === "win32") return
    const { handle, sentInputs, cleanup } = await makeTestHandle({ planMode: true })
    try {
      await handle.setPermissionMode(false)
      expect(sentInputs).toContain(SHIFT_TAB_KEY)
    } finally {
      await cleanup()
    }
  }, 10_000)

  test("setPermissionMode(false) without prior entry does NOT send Shift+Tab", async () => {
    if (process.platform === "win32") return
    const { handle, sentInputs, cleanup } = await makeTestHandle()
    try {
      await handle.setPermissionMode(false)
      expect(sentInputs).not.toContain(SHIFT_TAB_KEY)
    } finally {
      await cleanup()
    }
  }, 10_000)
})

describe("session close escalation (graceful → SIGTERM → SIGKILL)", () => {
  test("close() escalates to SIGKILL when SIGTERM does not terminate within the grace window", async () => {
    if (process.platform === "win32") return
    // Stand-alone fake PTY: ignore SIGTERM (close()), only exit on SIGKILL (kill()).
    let killSignal: NodeJS.Signals | number | undefined
    let exitResolve!: (code: number) => void
    const exited = new Promise<number>((r) => { exitResolve = r })
    const stubbornPty: PtyProcess = {
      async sendInput() { /* swallow */ },
      resize() {},
      exited,
      close() { /* deliberately ignore SIGTERM to simulate a hung TUI */ },
      kill(signal) { killSignal = signal; exitResolve(137) },
    }
    const tmp = await mkdtemp(path.join(tmpdir(), "kanna-pty-close-"))
    try {
      const handle = await startClaudeSessionPTY({
        chatId: "test-close", projectId: "p", localPath: tmp,
        model: "claude-haiku-4-5-20251001",
        planMode: false, forkSession: false,
        oauthToken: "test-token", sessionToken: null,
        onToolRequest: async () => null,
        homeDir: tmp,
        env: { HOME: tmp, CLAUDE_CODE_OAUTH_TOKEN: "test-token", KANNA_PTY_TRUST_DISMISS: "disabled", CLAUDE_EXECUTABLE: "/bin/sh" },
        spawnPtyProcess: async (s) => { s.onOutput?.("❯ "); return stubbornPty },
        startKannaMcpHttpServer: async () => ({ url: "http://127.0.0.1:0/mcp", bearerToken: "t", close: async () => {} }),
        startTranscriptStreamFn: async () => ({
          lines: { [Symbol.asyncIterator]() { return { next(): Promise<IteratorResult<string, undefined>> { return new Promise(() => {}) } } } },
          filePath: new Promise<string>(() => {}),
          close() {},
        }),
        smokeTestGate: { async canSpawn() { return { ok: true } } },
      })
      handle.close()
      // 2 s SIGTERM grace + 3 s SIGKILL grace + a safety margin.
      const code = await Promise.race([
        exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("escalation timed out")), 8_000)),
      ])
      expect(code).toBe(137)
      expect(killSignal).toBe("SIGKILL")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 10_000)
})
