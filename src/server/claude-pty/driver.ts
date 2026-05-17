import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { verifyPtyAuth } from "./auth"
import { computeJsonlPath } from "./jsonl-path"
import { createJsonlReader } from "./jsonl-reader"
import { spawnPtyProcess } from "./pty-process"
import { writeSlashCommand } from "./slash-commands"
import { writeSpawnSettings } from "./settings-writer"
import { isSandboxEnabledAsync } from "./sandbox/platform"
import { wrapWithSandbox } from "./sandbox/wrap"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { startKannaMcpHttpServer, buildMcpConfigJson, type KannaMcpHttpHandle } from "../kanna-mcp-http"
import { parseConfiguredContextWindowFromModelId, timestamped } from "../agent"
import { KANNA_SYSTEM_PROMPT_APPEND } from "../../shared/kanna-system-prompt"
import { verifyBinaryUnchanged } from "./preflight/gate"
import type { PreflightGate } from "./preflight/gate"
import type { ClaudeSessionHandle } from "../agent"
import type { HarnessEvent, HarnessToolRequest } from "../harness-types"
import type { AccountInfo, SlashCommand } from "../../shared/types"
import type { ToolCallbackService } from "../tool-callback"
import type { TunnelGateway } from "../cloudflare-tunnel/gateway"
import type { ChatPermissionPolicy } from "../../shared/permission-policy"

const STATIC_SUPPORTED_COMMANDS: SlashCommand[] = [
  { name: "/model", description: "Switch model", argumentHint: "model name" },
  { name: "/exit", description: "Exit the session", argumentHint: "" },
  { name: "/clear", description: "Clear context", argumentHint: "" },
  { name: "/help", description: "List commands", argumentHint: "" },
]

export interface StartClaudeSessionPtyArgs {
  chatId: string
  projectId: string
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  forkSession: boolean
  oauthToken: string | null
  sessionToken: string | null
  additionalDirectories?: string[]
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  systemPromptOverride?: string
  initialPrompt?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  preflightGate?: PreflightGate
  /** Routes AskUserQuestion/ExitPlanMode + built-in shims through durable approval when KANNA_MCP_TOOL_CALLBACKS=1. */
  toolCallback?: ToolCallbackService
  /** Tunnel gateway for kanna-mcp expose_port. */
  tunnelGateway?: TunnelGateway | null
  /** Per-chat permission policy for kanna-mcp built-in shims. */
  chatPolicy?: ChatPermissionPolicy
  /** Optional override used by tests to inject a fake HTTP MCP starter. */
  startKannaMcpHttpServer?: typeof startKannaMcpHttpServer
  /**
   * One-shot semantics: after `initialPrompt` completes one turn (first
   * `result` entry), gracefully close the REPL. Mirrors the SDK driver
   * closing its prompt queue after a single subagent prompt. Default false.
   */
  oneShot?: boolean
  /**
   * C1 — label of the OAuth-pool token the coordinator picked for this
   * spawn. The claude CLI never writes account info to the JSONL
   * transcript (confirmed: `SDKSystemMessage` has no account fields,
   * `q.accountInfo()` is an SDK-only API). PTY mode surfaces the
   * user-configured token label so the UI can still show which account
   * the chat is running under, instead of returning null forever.
   */
  oauthLabel?: string
}

/**
 * C1 — derive an AccountInfo from the picked OAuth-pool token label.
 * The claude CLI never emits account info to the JSONL transcript, so
 * the user-configured token label is the only account signal PTY has.
 * Returns null when no label (single-account / no-pool setups) so the
 * UI falls back instead of showing a bogus account chip.
 */
export function deriveAccountInfoFromLabel(label?: string): AccountInfo | null {
  if (!label || label.length === 0) return null
  return { organization: label, tokenSource: "kanna-oauth-pool" }
}

export const PLAN_MODE_EXIT_UNSUPPORTED =
  "[claude-pty] leaving plan mode at runtime is unsupported in PTY mode "
  + "(no slash command exits plan mode; awaiting anthropics/claude-code#59891). "
  + "Restart the session to return to acceptEdits."

export type PlanModeRuntimeAction =
  | { kind: "slash"; command: string }
  | { kind: "warn"; message: string }

/**
 * D4 (partial) — maps an SDK-style `setPermissionMode(planMode)` call to
 * the runtime action the PTY driver can actually perform.
 *
 * ENTER plan (`planMode === true`) → `/plan` slash command. Per
 * code.claude.com/docs/en/commands, `/plan` "enters plan mode directly
 * from the prompt" — a real, deterministic mode change over the REPL.
 *
 * EXIT plan (`planMode === false`) → warn only. No slash command sets
 * acceptEdits; the only exit is the relative Shift+Tab TUI cycle whose
 * correct keypress count depends on unobservable TUI state (PTY drains
 * output unparsed). Restart required. Tracked: anthropics/claude-code#59891.
 */
export function planModeRuntimeAction(planMode: boolean): PlanModeRuntimeAction {
  if (planMode) return { kind: "slash", command: "plan" }
  return { kind: "warn", message: PLAN_MODE_EXIT_UNSUPPORTED }
}

/** B4 — bounded ring buffer for PTY output so a crash/OAuth-failure exit can synthesize an isError result from the tail. */
export const PTY_STDERR_RING_BYTES = 256 * 1024

export class OutputRing {
  private buf = ""
  append(chunk: string): void {
    this.buf += chunk
    if (this.buf.length > PTY_STDERR_RING_BYTES) {
      this.buf = this.buf.slice(this.buf.length - PTY_STDERR_RING_BYTES)
    }
  }
  tail(): string {
    return this.buf
  }
}

export interface BuildPtyCliArgsInput {
  sessionId: string
  model: string
  effort?: string
  planMode: boolean
  settingsPath: string
  sessionToken: string | null
  forkSession: boolean
  additionalDirectories?: string[]
  systemPromptOverride?: string
  /** Absolute path to mcp-config JSON. When provided, --strict-mcp-config is also set. */
  mcpConfigPath?: string
}

export function buildPtyCliArgs(args: BuildPtyCliArgsInput): string[] {
  const cliArgs: string[] = [
    "--session-id", args.sessionId,
    "--model", args.model,
    "--tools", "mcp__kanna__*",
    "--settings", args.settingsPath,
    "--no-update",
    "--permission-mode", args.planMode ? "plan" : "acceptEdits",
  ]
  if (args.mcpConfigPath) {
    cliArgs.push("--mcp-config", args.mcpConfigPath, "--strict-mcp-config")
  }
  if (args.effort && args.effort.length > 0) cliArgs.push("--effort", args.effort)
  if (args.sessionToken) cliArgs.push("--resume", args.sessionToken)
  if (args.forkSession) cliArgs.push("--fork-session")
  if (args.additionalDirectories) {
    for (const dir of args.additionalDirectories) cliArgs.push("--add-dir", dir)
  }
  if (args.systemPromptOverride) {
    cliArgs.push("--system-prompt", args.systemPromptOverride)
  } else {
    cliArgs.push("--append-system-prompt", KANNA_SYSTEM_PROMPT_APPEND)
  }
  return cliArgs
}

export function buildPtyEnv(args: {
  baseEnv: NodeJS.ProcessEnv
  homeDir: string
  oauthToken: string | null
}): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = { ...args.baseEnv }
  delete spawnEnv.ANTHROPIC_API_KEY
  spawnEnv.TERM = "xterm-256color"
  spawnEnv.NO_COLOR = "0"
  spawnEnv.HOME = args.homeDir
  if (args.oauthToken && args.oauthToken.length > 0) {
    spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = args.oauthToken
  }
  return spawnEnv
}

export async function startClaudeSessionPTY(args: StartClaudeSessionPtyArgs): Promise<ClaudeSessionHandle> {
  const home = args.homeDir ?? homedir()
  const env = args.env ?? process.env

  const auth = await verifyPtyAuth({ homeDir: home, env, oauthToken: args.oauthToken })
  if (!auth.ok) {
    throw new Error(auth.error)
  }

  let preflightBinarySha256: string | null = null
  let preflightClaudeBin: string | null = null
  if (args.preflightGate) {
    const claudeBinAbs = env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, home) || "/usr/local/bin/claude"
    const check = await args.preflightGate.canSpawn({ binaryPath: claudeBinAbs, model: args.model })
    if (!check.ok) {
      throw new Error(`PTY preflight failed: ${check.reason}`)
    }
    preflightBinarySha256 = check.binarySha256
    preflightClaudeBin = claudeBinAbs
  }

  const spawnEnv = buildPtyEnv({
    baseEnv: env,
    homeDir: home,
    oauthToken: args.oauthToken,
  })

  const sessionId = args.sessionToken ?? randomUUID()
  const jsonlPath = computeJsonlPath({ homeDir: home, cwd: args.localPath, sessionId })

  const runtimeDir = await mkdtemp(path.join(tmpdir(), `kanna-pty-${sessionId.slice(0, 8)}-`))
  const { settingsPath } = await writeSpawnSettings({ runtimeDir })

  const sandboxOn = await isSandboxEnabledAsync({ platform: process.platform, env: env.KANNA_PTY_SANDBOX })

  const startMcp = args.startKannaMcpHttpServer ?? startKannaMcpHttpServer
  const mcpHandle: KannaMcpHttpHandle = await startMcp({
    args: {
      projectId: args.projectId,
      localPath: args.localPath,
      chatId: args.chatId,
      sessionId,
      tunnelGateway: args.tunnelGateway ?? null,
      toolCallback: args.toolCallback,
      chatPolicy: args.chatPolicy,
    },
  })
  const mcpConfigPath = path.join(runtimeDir, "mcp-config.json")
  await writeFile(mcpConfigPath, buildMcpConfigJson(mcpHandle), { encoding: "utf8", mode: 0o600 })

  const claudeBin = env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, home) ?? "claude"
  const cliArgs = buildPtyCliArgs({
    sessionId,
    model: args.model,
    effort: args.effort,
    planMode: args.planMode,
    settingsPath,
    sessionToken: args.sessionToken,
    forkSession: args.forkSession,
    additionalDirectories: args.additionalDirectories,
    systemPromptOverride: args.systemPromptOverride,
    mcpConfigPath,
  })

  // Fix 1+5: shared closed flag used by close(), iterator, and pty.exited watcher
  let closed = false
  let pendingModelSwitch: { model: string; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null
  // C1 — seed AccountInfo from the picked OAuth-pool token label. A later
  // JSONL `account_info` entry (none exists today) would override via
  // pushMerged; until then this is the only account signal PTY has.
  let cachedAccountInfo: AccountInfo | null = deriveAccountInfoFromLabel(args.oauthLabel)
  // B4 — track whether the turn produced a `result` entry. If the process
  // exits without one (silent crash / OAuth failure / preflight kill), we
  // synthesize an isError result so agent.ts can run auth/rate detection
  // and rotation/retry just like the SDK driver's thrown-error path.
  let sawResultEntry = false
  const outputRing = new OutputRing()
  const mergedQueue: HarnessEvent[] = []
  const mergedWaiters: Array<(r: IteratorResult<HarnessEvent>) => void> = []

  // Fix 2: track all pending timers so close() can cancel them
  const pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set()

  // Fix 3: safe type guard for accountInfo
  function pushMerged(ev: HarnessEvent) {
    if (ev.type === "transcript" && ev.entry) {
      const entry = ev.entry as { kind?: string; accountInfo?: unknown; model?: string }
      if (entry.kind === "account_info" && entry.accountInfo !== undefined) {
        cachedAccountInfo = entry.accountInfo as AccountInfo
      }
      if (entry.kind === "result") {
        sawResultEntry = true
      }
      if (pendingModelSwitch && entry.kind === "system_init" && typeof entry.model === "string" && entry.model === pendingModelSwitch.model) {
        clearTimeout(pendingModelSwitch.timer)
        pendingTimers.delete(pendingModelSwitch.timer)
        pendingModelSwitch.resolve()
        pendingModelSwitch = null
      }
    }
    const w = mergedWaiters.shift()
    if (w) w({ value: ev, done: false })
    else mergedQueue.push(ev)

    // D7 — one-shot: terminate after the single turn's result entry so
    // subagent sessions don't sit on an open REPL forever.
    if (
      args.oneShot &&
      ev.type === "transcript" &&
      (ev.entry as { kind?: string } | undefined)?.kind === "result"
    ) {
      void oneShotClose()
    }
  }

  let oneShotClosing = false
  async function oneShotClose() {
    if (oneShotClosing || closed) return
    oneShotClosing = true
    try { await writeSlashCommand(pty, "exit") } catch { /* swallow */ }
  }

  let wrapped: Awaited<ReturnType<typeof wrapWithSandbox>>
  let pty: Awaited<ReturnType<typeof spawnPtyProcess>>
  try {
    // TOCTOU narrowing — re-hash the `claude` binary immediately before
    // the sandbox wrap + spawn and refuse if it changed since the
    // preflight gate ran. Does NOT close the window completely (still a
    // race between this hash and exec), but cuts it from
    // "seconds-to-minutes of suite latency" down to "one extra hash
    // delta". A full close needs an fd threaded through `spawnPtyProcess`
    // (no Node API for `execveat` / `fexecve` on Bun spawn) — out of
    // scope here. Tracked in #163.
    if (preflightBinarySha256 && preflightClaudeBin) {
      const verify = await verifyBinaryUnchanged(preflightClaudeBin, preflightBinarySha256)
      if (!verify.ok) {
        throw new Error(`PTY preflight failed: ${verify.reason}`)
      }
    }
    wrapped = await wrapWithSandbox({
      platform: process.platform,
      enabled: sandboxOn,
      policy: POLICY_DEFAULT,
      homeDir: home,
      runtimeDir,
      command: claudeBin,
      args: cliArgs,
    })
    pty = await spawnPtyProcess({
      command: wrapped.command,
      args: wrapped.args,
      cwd: args.localPath,
      env: spawnEnv,
      cols: 120,
      rows: 40,
      onOutput: (chunk) => outputRing.append(chunk),
    })
  } catch (err) {
    try { await mcpHandle.close() } catch { /* swallow */ }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
    throw err
  }

  const reader = createJsonlReader({
    filePath: jsonlPath,
    configuredContextWindow: parseConfiguredContextWindowFromModelId(args.model),
  })

  void (async () => {
    for await (const ev of reader) pushMerged(ev)
  })()

  // Fix 5 + B4: observe pty.exited so a crash terminates the stream. If the
  // process died without ever emitting a `result` entry, synthesize an
  // isError result from the captured output tail before draining done so
  // agent.ts can detect auth/rate failures and trigger rotation/retry.
  function drainTerminate(exitCode: number | null) {
    if (closed || oneShotClosing) {
      reader.close()
      while (mergedWaiters.length > 0) {
        const w = mergedWaiters.shift()
        if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
      }
      return
    }
    if (!sawResultEntry) {
      const tail = outputRing.tail().trim()
      const codeNote = exitCode === null ? "signal" : `exit code ${exitCode}`
      const resultText = tail.length > 0
        ? tail
        : `claude PTY process exited (${codeNote}) before producing a result.`
      pushMerged({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: resultText,
          debugRaw: JSON.stringify({ source: "pty-exit", exitCode }),
        }),
      })
    }
    reader.close()
    while (mergedWaiters.length > 0) {
      const w = mergedWaiters.shift()
      if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
    }
  }

  void pty.exited
    .then((code) => drainTerminate(typeof code === "number" ? code : null))
    .catch(() => drainTerminate(null))

  if (args.initialPrompt) {
    await pty.sendInput(`${args.initialPrompt}\r`)
  }

  // Fix 5: iterator returns done:true when closed and queue is empty
  const stream: AsyncIterable<HarnessEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<HarnessEvent>> {
          if (mergedQueue.length > 0) {
            const ev = mergedQueue.shift()
            if (ev) return Promise.resolve({ value: ev, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as HarnessEvent, done: true })
          }
          return new Promise((resolve) => {
            mergedWaiters.push(resolve)
          })
        },
      }
    },
  }

  return {
    provider: "claude",
    stream,
    // Fix 2: track timer for Ctrl-C send
    interrupt: async () => {
      await pty.sendInput("\x1b")
      const t = setTimeout(() => {
        pendingTimers.delete(t)
        void pty.sendInput("\x03")
      }, 1000)
      pendingTimers.add(t)
    },
    sendPrompt: async (content) => {
      await pty.sendInput(`${content}\r`)
    },
    setModel: async (model) => {
      await writeSlashCommand(pty, "model", model)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingModelSwitch && pendingModelSwitch.model === model) {
            pendingTimers.delete(pendingModelSwitch.timer)
            pendingModelSwitch.resolve()
            pendingModelSwitch = null
          }
        }, 10_000)
        pendingTimers.add(timer)
        pendingModelSwitch = { model, resolve: () => { pendingTimers.delete(timer); resolve() }, timer }
      })
    },
    setPermissionMode: async (planMode) => {
      // D4 (partial). See planModeRuntimeAction for the asymmetry rationale.
      const action = planModeRuntimeAction(planMode)
      if (action.kind === "slash") {
        await writeSlashCommand(pty, action.command)
        return
      }
      console.warn(action.message)
    },
    getSupportedCommands: async () => STATIC_SUPPORTED_COMMANDS,
    getAccountInfo: async () => cachedAccountInfo,
    // Fix 1: close() guard, ordered teardown, runtimeDir cleanup
    close: () => {
      if (closed) return
      closed = true
      // Fix 2: cancel all pending timers before scheduling new ones
      for (const t of pendingTimers) clearTimeout(t)
      pendingTimers.clear()
      if (pendingModelSwitch) {
        pendingModelSwitch.resolve()
        pendingModelSwitch = null
      }
      void (async () => {
        try { await writeSlashCommand(pty, "exit") } catch { /* swallow */ }
        const timer = setTimeout(() => {
          try { pty.close() } catch { /* swallow */ }
        }, 2000)
        try {
          await pty.exited
          clearTimeout(timer)
        } catch { /* swallow */ }
        reader.close()
        // B6: cancel pending tool-callback requests so they resolve as
        // session_closed instead of waiting for the 10-min default timeout.
        if (args.toolCallback) {
          try {
            await args.toolCallback.cancelAllForSession(sessionId, "session_closed")
          } catch { /* swallow */ }
        }
        try { await mcpHandle.close() } catch { /* swallow */ }
        try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
        // Drain any waiters that weren't resolved by pty.exited watcher
        while (mergedWaiters.length > 0) {
          const w = mergedWaiters.shift()
          if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
        }
      })()
    },
  }
}
