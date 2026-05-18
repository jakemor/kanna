import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { verifyPtyAuth } from "./auth"
import { startKannaMcpHttpServer, buildMcpConfigJson, type KannaMcpHttpHandle } from "../kanna-mcp-http"
import type { KannaMcpDelegationContext } from "../kanna-mcp"
import type { SubagentOrchestrator } from "../subagent-orchestrator"
import { parseConfiguredContextWindowFromModelId, timestamped } from "../agent"
import { KANNA_SYSTEM_PROMPT_APPEND } from "../../shared/kanna-system-prompt"
import type { PreflightGate } from "./preflight/gate"
import { resolveClaudeBinary } from "./resolve-binary"
import { createJsonlEventParser } from "./jsonl-to-event"
import type { ClaudeSessionHandle } from "../agent"
import type { HarnessEvent, HarnessToolRequest } from "../harness-types"
import type { AccountInfo, SlashCommand } from "../../shared/types"
import type { ToolCallbackService } from "../tool-callback"
import type { TunnelGateway } from "../cloudflare-tunnel/gateway"
import type { ChatPermissionPolicy } from "../../shared/permission-policy"

// Fallback list returned by getSupportedCommands() if claude's system_init
// JSONL message hasn't been observed yet (cold start before first spawn).
// Names follow claude's own format — no leading "/" — so the chat input
// renders `/clear` (not `//clear`) after `applyCommandToInput` prefixes the
// slash. The driver overwrites this with the full live list as soon as
// the spawned claude subprocess emits its system_init entry.
const STATIC_SUPPORTED_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Switch model", argumentHint: "model name" },
  { name: "exit", description: "Exit the session", argumentHint: "" },
  { name: "clear", description: "Clear context", argumentHint: "" },
  { name: "help", description: "List commands", argumentHint: "" },
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
  /**
   * Append text for `--append-system-prompt`. Defaults to the static
   * {@link KANNA_SYSTEM_PROMPT_APPEND} blurb for back-compat with older
   * callers; production callers in `agent.ts` pass the dynamic value
   * from `buildKannaSystemPromptAppend` so the subagent roster is
   * embedded.
   */
  systemPromptAppend?: string
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
  /** Orchestrator for delegate_subagent. Omit to hide the tool from the model. */
  subagentOrchestrator?: SubagentOrchestrator
  /** Per-spawn delegation context (depth / ancestor chain / parentUserMessageId resolver). */
  delegationContext?: KannaMcpDelegationContext
  /** Optional override used by tests to inject a fake HTTP MCP starter. */
  startKannaMcpHttpServer?: typeof startKannaMcpHttpServer
  /**
   * One-shot semantics: after the first `result` entry, close stdin so
   * the subprocess exits. Mirrors the SDK driver's prompt-queue close
   * for single-turn subagent runs.
   */
  oneShot?: boolean
  /** Label of the OAuth-pool token. Surfaces in AccountInfo since the CLI doesn't emit account info in stream-json. */
  oauthLabel?: string
}

/**
 * Derive an AccountInfo from the picked OAuth-pool token label.
 * The claude CLI never emits account info in stream-json, so the
 * user-configured token label is the only account signal PTY has.
 */
export function deriveAccountInfoFromLabel(label?: string): AccountInfo | null {
  if (!label || label.length === 0) return null
  return { organization: label, tokenSource: "kanna-oauth-pool" }
}

export const PLAN_MODE_EXIT_UNSUPPORTED =
  "[claude-pty] leaving plan mode at runtime is unsupported in stream-json mode "
  + "(no control request leaves plan mode). Restart the session to return to acceptEdits."

export type PlanModeRuntimeAction =
  | { kind: "control"; request: Record<string, unknown> }
  | { kind: "warn"; message: string }

export function planModeRuntimeAction(planMode: boolean): PlanModeRuntimeAction {
  if (planMode) {
    return {
      kind: "control",
      request: { type: "set_permission_mode", mode: "plan" },
    }
  }
  return { kind: "warn", message: PLAN_MODE_EXIT_UNSUPPORTED }
}

/** Bounded ring buffer for stderr so a crash/OAuth-failure exit can synthesize an isError result from the tail. */
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
  sessionToken: string | null
  forkSession: boolean
  additionalDirectories?: string[]
  systemPromptOverride?: string
  systemPromptAppend?: string
  /** Absolute path to kanna's own mcp-config JSON. Merged with user's MCP configs (no --strict-mcp-config). */
  mcpConfigPath?: string
}

/**
 * Build claude CLI args for stream-json driver mode.
 *
 * Kanna trusts the claude CLI as the source of truth for tool execution and
 * stays out of the way of user setup:
 *
 *   • No `--tools` restriction — model uses claude's full built-in surface.
 *   • No `--strict-mcp-config` — user's own MCP servers (~/.claude/settings.json,
 *     plugin mcp_servers.json, etc.) are loaded alongside kanna's MCP.
 *   • No `--settings <kanna-spawn-file>` — `--setting-sources user,project,local`
 *     instead, so the user's installed skills, slash commands, plugins, agents,
 *     and project / local settings layers all load normally.
 *   • `--dangerously-skip-permissions` — auto-run tools because the CLI's own
 *     interactive permission prompt cannot render under `--print` mode (no TTY).
 *
 * Kanna only contributes its own MCP server (`offer_download`, `expose_port`,
 * `lsp`) so the model can drive the kanna UI; everything else is the user's.
 */
export function buildPtyCliArgs(args: BuildPtyCliArgsInput): string[] {
  const cliArgs: string[] = [
    "--print",
    "--output-format=stream-json",
    "--input-format=stream-json",
    "--verbose",
    "--model", args.model,
    "--setting-sources", "user,project,local",
    "--permission-mode", args.planMode ? "plan" : "acceptEdits",
    "--dangerously-skip-permissions",
  ]
  // claude CLI rejects `--session-id <id>` whenever it is paired with
  // `--resume <id>` unless `--fork-session` is also set:
  //   "--session-id can only be used with --continue or --resume if
  //    --fork-session is also specified."
  // Translate kanna's intent → CLI flags:
  //   • New session (no sessionToken)                  → --session-id <newUuid>
  //   • Resume existing session (sessionToken set)     → --resume <token>
  //   • Fork existing session (sessionToken + fork)    → --session-id <newUuid> --resume <token> --fork-session
  if (args.sessionToken && !args.forkSession) {
    cliArgs.push("--resume", args.sessionToken)
  } else if (args.sessionToken && args.forkSession) {
    cliArgs.push("--session-id", args.sessionId, "--resume", args.sessionToken, "--fork-session")
  } else {
    cliArgs.push("--session-id", args.sessionId)
  }
  if (args.mcpConfigPath) {
    cliArgs.push("--mcp-config", args.mcpConfigPath)
  }
  if (args.effort && args.effort.length > 0) cliArgs.push("--effort", args.effort)
  if (args.additionalDirectories) {
    for (const dir of args.additionalDirectories) cliArgs.push("--add-dir", dir)
  }
  if (args.systemPromptOverride) {
    cliArgs.push("--system-prompt", args.systemPromptOverride)
  } else {
    cliArgs.push("--append-system-prompt", args.systemPromptAppend ?? KANNA_SYSTEM_PROMPT_APPEND)
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
  spawnEnv.HOME = args.homeDir
  spawnEnv.DISABLE_AUTOUPDATER = "1"
  if (args.oauthToken && args.oauthToken.length > 0) {
    spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = args.oauthToken
  }
  return spawnEnv
}

interface StdinWriter {
  write(data: string | Uint8Array): void
  end(): void
}

interface SpawnedProcess {
  stdin: StdinWriter | null
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill: (signal?: number | NodeJS.Signals) => void
}

export async function startClaudeSessionPTY(args: StartClaudeSessionPtyArgs): Promise<ClaudeSessionHandle> {
  const home = args.homeDir ?? homedir()
  const env = args.env ?? process.env

  console.log("[kanna/pty] startClaudeSessionPTY begin", {
    chatId: args.chatId,
    projectId: args.projectId,
    localPath: args.localPath,
    model: args.model,
    planMode: args.planMode,
    forkSession: args.forkSession,
    hasOauthToken: Boolean(args.oauthToken),
    oauthLabel: args.oauthLabel ?? null,
    hasPreflightGate: Boolean(args.preflightGate),
    sandboxEnvOverride: env.KANNA_PTY_SANDBOX ?? null,
    platform: process.platform,
    anthropicApiKeySet: Boolean(env.ANTHROPIC_API_KEY),
    claudeExecutable: env.CLAUDE_EXECUTABLE ?? null,
  })

  const auth = await verifyPtyAuth({ env, oauthToken: args.oauthToken })
  if (!auth.ok) {
    console.error("[kanna/pty] verifyPtyAuth failed", {
      chatId: args.chatId,
      error: auth.error,
      hasOauthToken: Boolean(args.oauthToken),
      anthropicApiKeySet: Boolean(env.ANTHROPIC_API_KEY),
    })
    throw new Error(auth.error)
  }

  const resolved = await resolveClaudeBinary({ env, homeDir: home })
  console.log("[kanna/pty] resolved claude binary", {
    chatId: args.chatId,
    path: resolved.path,
    source: resolved.source,
  })
  const claudeBinAbs = resolved.path

  // Preflight gate + OS sandbox removed: kanna trusts the claude CLI as the
  // source of truth for tool execution. No probe-based allowlist check, no
  // sandbox-exec / bwrap wrap. The claude binary runs directly under the
  // kanna server's own process boundary.
  void args.preflightGate

  const spawnEnv = buildPtyEnv({
    baseEnv: env,
    homeDir: home,
    oauthToken: args.oauthToken,
  })

  const sessionId = args.sessionToken ?? randomUUID()

  const runtimeDir = await mkdtemp(path.join(tmpdir(), `kanna-pty-${sessionId.slice(0, 8)}-`))

  const mcpConfigPath = path.join(runtimeDir, "mcp-config.json")
  let mcpHandle: KannaMcpHttpHandle
  const startMcp = args.startKannaMcpHttpServer ?? startKannaMcpHttpServer
  try {
    mcpHandle = await startMcp({
      args: {
        projectId: args.projectId,
        localPath: args.localPath,
        chatId: args.chatId,
        sessionId,
        tunnelGateway: args.tunnelGateway ?? null,
        toolCallback: args.toolCallback,
        chatPolicy: args.chatPolicy,
        subagentOrchestrator: args.subagentOrchestrator,
        delegationContext: args.delegationContext,
      },
    })
    await writeFile(mcpConfigPath, buildMcpConfigJson(mcpHandle), { encoding: "utf8", mode: 0o600 })
  } catch (err) {
    try { await (mcpHandle! as KannaMcpHttpHandle | undefined)?.close() } catch { /* swallow */ }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
    throw err
  }

  const claudeBin = claudeBinAbs
  const cliArgs = buildPtyCliArgs({
    sessionId,
    model: args.model,
    effort: args.effort,
    planMode: args.planMode,
    sessionToken: args.sessionToken,
    forkSession: args.forkSession,
    additionalDirectories: args.additionalDirectories,
    systemPromptOverride: args.systemPromptOverride,
    systemPromptAppend: args.systemPromptAppend,
    mcpConfigPath,
  })

  let closed = false
  let cleanedUp = false
  let cachedAccountInfo: AccountInfo | null = deriveAccountInfoFromLabel(args.oauthLabel)
  let sawResultEntry = false
  let cachedSlashCommands: SlashCommand[] | null = null
  const stderrRing = new OutputRing()
  const mergedQueue: HarnessEvent[] = []
  const mergedWaiters: Array<(r: IteratorResult<HarnessEvent>) => void> = []

  async function cleanupResources() {
    if (cleanedUp) return
    cleanedUp = true
    if (args.toolCallback) {
      try { await args.toolCallback.cancelAllForSession(sessionId, "session_closed") } catch { /* swallow */ }
    }
    try { await mcpHandle.close() } catch { /* swallow */ }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
  }

  function pushMerged(ev: HarnessEvent) {
    if (ev.type === "transcript" && ev.entry) {
      const entry = ev.entry as { kind?: string; accountInfo?: unknown; slashCommands?: unknown }
      if (entry.kind === "account_info" && entry.accountInfo !== undefined) {
        cachedAccountInfo = entry.accountInfo as AccountInfo
      }
      if (entry.kind === "result") {
        sawResultEntry = true
      }
      // system_init carries the full slash-command list the spawned claude
      // CLI knows about — including every skill, plugin command, project
      // command, and built-in. Cache it so getSupportedCommands() returns
      // the live set instead of the cold-start fallback.
      if (entry.kind === "system_init" && Array.isArray(entry.slashCommands)) {
        cachedSlashCommands = (entry.slashCommands as string[]).map((name) => ({
          name,
          description: "",
          argumentHint: "",
        }))
      }
    }
    const w = mergedWaiters.shift()
    if (w) w({ value: ev, done: false })
    else mergedQueue.push(ev)

    if (
      args.oneShot
      && ev.type === "transcript"
      && (ev.entry as { kind?: string } | undefined)?.kind === "result"
    ) {
      void oneShotClose()
    }
  }

  let oneShotClosing = false
  async function oneShotClose() {
    if (oneShotClosing || closed) return
    oneShotClosing = true
    try { proc?.stdin?.end() } catch { /* swallow */ }
    try { await proc?.exited } catch { /* swallow */ }
    await cleanupResources()
  }

  let proc: SpawnedProcess
  try {
    console.log("[kanna/pty] spawn begin", {
      chatId: args.chatId,
      command: claudeBin,
      cwd: args.localPath,
      argCount: cliArgs.length,
    })
    const subprocess = Bun.spawn([claudeBin, ...cliArgs], {
      cwd: args.localPath,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const sink = subprocess.stdin as unknown as { write: (data: string | Uint8Array) => number; end: () => void; flush?: () => void } | null
    proc = {
      stdin: sink
        ? {
            write: (data) => { sink.write(data); sink.flush?.() },
            end: () => { try { sink.end() } catch { /* swallow */ } },
          }
        : null,
      stdout: subprocess.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: subprocess.stderr as unknown as ReadableStream<Uint8Array>,
      exited: subprocess.exited,
      kill: (sig) => subprocess.kill(sig as number | undefined),
    }
    console.log("[kanna/pty] proc spawned", {
      chatId: args.chatId,
      sessionId,
    })
  } catch (err) {
    console.error("[kanna/pty] sandbox-wrap or spawn failed", {
      chatId: args.chatId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    try { await mcpHandle.close() } catch { /* swallow */ }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
    throw err
  }

  const parser = createJsonlEventParser({
    configuredContextWindow: parseConfiguredContextWindowFromModelId(args.model),
  })

  async function pumpStdout(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let buffer = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const events = parser.parse(trimmed)
            for (const ev of events) pushMerged(ev)
          } catch (err) {
            console.warn("[kanna/pty] parser threw on line", err)
          }
        }
      }
      const tail = buffer.trim()
      if (tail) {
        try {
          const events = parser.parse(tail)
          for (const ev of events) pushMerged(ev)
        } catch { /* swallow */ }
      }
    } finally {
      try { reader.releaseLock() } catch { /* swallow */ }
    }
  }

  async function pumpStderr(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        stderrRing.append(decoder.decode(value, { stream: true }))
      }
    } finally {
      try { reader.releaseLock() } catch { /* swallow */ }
    }
  }

  void pumpStdout(proc.stdout).catch((err) => {
    console.warn("[kanna/pty] stdout pump threw", err)
  })
  void pumpStderr(proc.stderr).catch((err) => {
    console.warn("[kanna/pty] stderr pump threw", err)
  })

  function drainTerminate(exitCode: number | null) {
    if (closed || oneShotClosing) {
      while (mergedWaiters.length > 0) {
        const w = mergedWaiters.shift()
        if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
      }
      return
    }
    if (!sawResultEntry) {
      const tail = stderrRing.tail().trim()
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
    void cleanupResources()
    while (mergedWaiters.length > 0) {
      const w = mergedWaiters.shift()
      if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
    }
  }

  void proc.exited
    .then((code) => drainTerminate(typeof code === "number" ? code : null))
    .catch(() => drainTerminate(null))

  async function writeJsonLine(obj: Record<string, unknown>) {
    if (closed) throw new Error("session closed")
    if (!proc.stdin) throw new Error("claude PTY stdin not available")
    const line = JSON.stringify(obj) + "\n"
    proc.stdin.write(line)
  }

  if (args.initialPrompt) {
    try {
      await writeJsonLine({
        type: "user",
        message: { role: "user", content: args.initialPrompt },
        parent_tool_use_id: null,
        session_id: args.sessionToken ?? undefined,
      })
    } catch (err) {
      console.warn("[kanna/pty] initialPrompt write failed", err)
    }
  }

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
    interrupt: async () => {
      try {
        await writeJsonLine({
          type: "control_request",
          request_id: randomUUID(),
          request: { type: "interrupt" },
        })
      } catch {
        try { proc.kill("SIGINT") } catch { /* swallow */ }
      }
    },
    sendPrompt: async (content) => {
      await writeJsonLine({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: args.sessionToken ?? undefined,
      })
    },
    setModel: async (model) => {
      try {
        await writeJsonLine({
          type: "control_request",
          request_id: randomUUID(),
          request: { type: "set_model", model },
        })
      } catch (err) {
        console.warn("[kanna/pty] setModel control_request failed", err)
      }
    },
    setPermissionMode: async (planMode) => {
      const action = planModeRuntimeAction(planMode)
      if (action.kind === "control") {
        try {
          await writeJsonLine({
            type: "control_request",
            request_id: randomUUID(),
            request: action.request,
          })
        } catch (err) {
          console.warn("[kanna/pty] setPermissionMode control_request failed", err)
        }
        return
      }
      console.warn(action.message)
    },
    getSupportedCommands: async () => cachedSlashCommands ?? STATIC_SUPPORTED_COMMANDS,
    getAccountInfo: async () => cachedAccountInfo,
    close: () => {
      if (closed) return
      closed = true
      void (async () => {
        try {
          proc?.stdin?.end()
        } catch { /* swallow */ }
        const sigkillTimer = { ref: null as ReturnType<typeof setTimeout> | null }
        const termTimer = setTimeout(() => {
          try { proc.kill("SIGTERM") } catch { /* swallow */ }
          sigkillTimer.ref = setTimeout(() => {
            try { proc.kill("SIGKILL") } catch { /* swallow */ }
          }, 3000)
        }, 2000)
        try {
          await proc.exited
          clearTimeout(termTimer)
          if (sigkillTimer.ref !== null) clearTimeout(sigkillTimer.ref)
        } catch { /* swallow */ }
        await cleanupResources()
        while (mergedWaiters.length > 0) {
          const w = mergedWaiters.shift()
          if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
        }
      })()
    },
  }
}
