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
import { resolveClaudeBinary } from "./resolve-binary"
import { createJsonlEventParser } from "./jsonl-to-event"
import { OutputRing, OUTPUT_RING_DEFAULT_BYTES } from "./output-ring"
import { createSmokeTestGate, createFileSmokeTestCache, buildLiveSmokeProbe, type SmokeTestGate } from "./smoke-test"
import { computeBinarySha256 } from "./preflight/binary-fingerprint"
import { spawnPtyProcess as defaultSpawnPtyProcess, type PtyProcess, type SpawnPtyProcessArgs } from "./pty-process"
import { waitForTuiReady, waitForTuiReadyWithTrustDismiss, sendUserPrompt, sendExitCommand } from "./tui-control"
import { startTranscriptStream } from "./tui-source"
import { computeJsonlPath, computeProjectDir } from "./jsonl-path"
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
  /** Optional smoke-test gate override (used by tests to inject a fake gate). */
  smokeTestGate?: SmokeTestGate
  /** Optional PTY spawn override (used by tests to inject a fake PTY). */
  spawnPtyProcess?: (args: SpawnPtyProcessArgs) => Promise<PtyProcess>
  /** Optional transcript stream factory override (used by tests). */
  startTranscriptStreamFn?: typeof startTranscriptStream
  /**
   * One-shot semantics: after the first `result` entry, close stdin so
   * the subprocess exits. Mirrors the SDK driver's prompt-queue close
   * for single-turn subagent runs.
   */
  oneShot?: boolean
  /** Label of the OAuth-pool token. Surfaces in AccountInfo since the CLI doesn't emit account info in stream-json. */
  oauthLabel?: string
  /** Masked OAuth-pool token (e.g. `sk-ant-oat01...XXXX`). Computed by AgentCoordinator; never the raw token. */
  oauthKeyMasked?: string
}

/**
 * Derive an AccountInfo from the picked OAuth-pool token. The claude CLI
 * never emits account info in stream-json, so the user-configured token
 * label and the coordinator-computed masked key are the only account
 * signals PTY has.
 */
export function deriveAccountInfoFromOauth(args: { label?: string; oauthKeyMasked?: string }): AccountInfo | null {
  const hasLabel = Boolean(args.label && args.label.length > 0)
  const hasMasked = Boolean(args.oauthKeyMasked && args.oauthKeyMasked.length > 0)
  if (!hasLabel && !hasMasked) return null
  const info: AccountInfo = { tokenSource: "kanna-oauth-pool" }
  if (hasLabel) info.organization = args.label
  if (hasMasked) info.oauthKeyMasked = args.oauthKeyMasked
  return info
}

/** VT100 Shift+Tab sequence sent to exit plan mode (one press cycles back to acceptEdits). */
export const SHIFT_TAB_KEY = "\x1b[Z"

export const PLAN_MODE_EXIT_UNSUPPORTED =
  "[claude-pty] cannot exit plan mode: driver-tracked plan mode is inactive "
  + "(plan mode may have been toggled externally via Shift+Tab). "
  + "Restart the session to return to acceptEdits."

/** Backward-compat re-exports — callers that import from driver.ts continue to work. */
export const PTY_STDERR_RING_BYTES = OUTPUT_RING_DEFAULT_BYTES
export { OutputRing }

/**
 * Native CLI built-ins removed from the model's context under PTY (issue
 * #215). The SDK driver intercepts these via the `canUseTool` hook
 * (`buildCanUseTool` in agent.ts); PTY has no such hook, so the CLI
 * auto-rejects them with `is_error: "Answer questions?"` and the model
 * mis-reads it as a user cancel. Disallowing the natives forces the model
 * onto the `mcp__kanna__ask_user_question` / `mcp__kanna__exit_plan_mode`
 * shims, which the PTY driver always registers (forceInteractiveToolCallbacks)
 * and which route through the durable approval protocol to the UI.
 * `EnterPlanMode` is intentionally excluded — it has no user round-trip and
 * the SDK hook never intercepts it, so leaving it native preserves parity.
 */
export const PTY_DISALLOWED_NATIVE_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const

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
 * Build claude CLI args for TUI driver mode.
 *
 * Kanna spawns the claude CLI under a real PTY and watches the on-disk
 * transcript JSONL file as the event source. The CLI runs interactively
 * with `--dangerously-skip-permissions` so tool calls are auto-approved.
 *
 *   • No `--print` / `--output-format` / `--input-format` / `--verbose` —
 *     TUI mode does NOT use the stream-json headless transport.
 *   • No `--session-id` for new sessions — TUI claude generates its own UUID
 *     on first prompt; kanna identifies the session via the transcript file.
 *   • `--strict-mcp-config` — CLI ignores user MCP config; kanna provides
 *     its own via `--mcp-config` so the MCP surface is fully controlled.
 *   • `--setting-sources user,project,local` — user's installed skills,
 *     slash commands, plugins, agents, and project / local settings layers
 *     all load normally.
 *   • `--dangerously-skip-permissions` — auto-run tools because the CLI's
 *     own interactive permission prompt is not routed through kanna's UI.
 */
export function buildPtyCliArgs(args: BuildPtyCliArgsInput): string[] {
  const cliArgs: string[] = [
    "--model", args.model,
    "--setting-sources", "user,project,local",
    "--permission-mode", args.planMode ? "plan" : "acceptEdits",
    "--dangerously-skip-permissions",
  ]
  // TUI mode session handling:
  //   • New session (no sessionToken)                  → no --session-id (TUI ignores it; claude generates its own UUID)
  //   • Resume existing session (sessionToken set)     → --resume <token>
  //   • Fork existing session (sessionToken + fork)    → --session-id <newUuid> --resume <token> --fork-session
  //
  // Interactive TUI claude ignores `--session-id` for new sessions and
  // always generates its own UUID. Watcher uses an mtime filter on the
  // project dir instead — only JSONLs created at or after spawn start are
  // candidates, so stale JSONLs from prior sessions cannot win the race.
  if (args.sessionToken && !args.forkSession) {
    cliArgs.push("--resume", args.sessionToken)
  } else if (args.sessionToken && args.forkSession) {
    cliArgs.push("--session-id", args.sessionId, "--resume", args.sessionToken, "--fork-session")
  }
  if (args.mcpConfigPath) {
    cliArgs.push("--mcp-config", args.mcpConfigPath, "--strict-mcp-config")
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
  // `--disallowedTools` is variadic in the claude CLI (space-separated tool
  // strings as separate argv — code.claude.com/docs/en/cli-reference). Push
  // it LAST so it cannot greedily swallow a subsequent flag value.
  cliArgs.push("--disallowedTools", ...PTY_DISALLOWED_NATIVE_TOOLS)
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

  const binarySha256 = await computeBinarySha256(claudeBinAbs)
  const smokeGate = args.smokeTestGate ?? createSmokeTestGate({
    probe: buildLiveSmokeProbe({
      claudeBinPath: claudeBinAbs,
      model: args.model,
      oauthToken: args.oauthToken ?? "",
      homeDir: home,
    }),
    cache: createFileSmokeTestCache({ cacheDir: path.join(home, ".kanna", "cache", "smoke-test") }),
    ttlMs: 24 * 3600 * 1000,
    now: () => Date.now(),
  })
  const smoke = await smokeGate.canSpawn({ binarySha256, model: args.model })
  if (!smoke.ok) {
    console.error("[kanna/pty] smoke-test refused spawn", { chatId: args.chatId, reason: smoke.reason })
    throw new Error(`PTY smoke-test refused spawn: ${smoke.reason}`)
  }

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
        // PTY has no canUseTool hook — the durable approval protocol is the
        // only host path for AskUserQuestion/ExitPlanMode. Force the shims
        // on regardless of KANNA_MCP_TOOL_CALLBACKS (issue #215). Paired
        // with --disallowedTools AskUserQuestion ExitPlanMode above so the
        // model uses the shim instead of the auto-rejected native built-in.
        forceInteractiveToolCallbacks: true,
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
  let cachedAccountInfo: AccountInfo | null = deriveAccountInfoFromOauth({ label: args.oauthLabel, oauthKeyMasked: args.oauthKeyMasked })
  let sawResultEntry = false
  let cachedSlashCommands: SlashCommand[] | null = null
  let localPlanModeActive = args.planMode
  const mergedQueue: HarnessEvent[] = []
  const mergedWaiters: Array<(r: IteratorResult<HarnessEvent>) => void> = []

  async function cleanupResources() {
    if (cleanedUp) return
    cleanedUp = true
    if (args.toolCallback) {
      try { await args.toolCallback.cancelAllForSession(sessionId, "session_closed") } catch (err) {
        console.warn("[kanna/pty] toolCallback.cancelAllForSession failed", { chatId: args.chatId, sessionId, err })
      }
    }
    try { await mcpHandle.close() } catch (err) {
      // Logged because a swallowed mcpHandle close error means the loopback
      // HTTP server may still be listening — a real resource leak.
      console.warn("[kanna/pty] mcpHandle.close failed (HTTP server may leak)", { chatId: args.chatId, sessionId, err })
    }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch (err) {
      console.warn("[kanna/pty] runtimeDir cleanup failed", { chatId: args.chatId, runtimeDir, err })
    }
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
  // pty is declared before use; assigned in the spawn try-block below.
  let pty: PtyProcess

  const ring = new OutputRing()
  const spawnPty = args.spawnPtyProcess ?? defaultSpawnPtyProcess
  try {
    console.log("[kanna/pty] spawn begin", {
      chatId: args.chatId,
      command: claudeBin,
      cwd: args.localPath,
    })
    pty = await spawnPty({
      command: claudeBin,
      args: cliArgs,
      cwd: args.localPath,
      env: spawnEnv,
      onOutput: (chunk) => { ring.append(chunk) },
    })
    console.log("[kanna/pty] pty spawned", { chatId: args.chatId, sessionId })
  } catch (err) {
    console.error("[kanna/pty] spawn failed", {
      chatId: args.chatId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    try { await mcpHandle.close() } catch { /* swallow */ }
    try { await rm(runtimeDir, { recursive: true, force: true }) } catch { /* swallow */ }
    throw err
  }

  // Wait for TUI to render its input box, dismissing the trust dialog if
  // present. The combined helper handles the ANSI-encoded trust dialog text
  // and keeps polling until the real "❯ " input box appears after dismiss.
  const tuiReadyMs = Number((args.env ?? process.env).KANNA_PTY_TUI_BOOT_MS ?? 3000)
  const trustDismiss = (args.env ?? process.env).KANNA_PTY_TRUST_DISMISS ?? "enabled"
  if (trustDismiss !== "disabled") {
    // +5 s over the base cap to absorb trust-dialog dismiss + project reload.
    const readyResult = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: tuiReadyMs + 5_000 })
    if (readyResult === "timeout") {
      console.warn("[kanna/pty] TUI ready marker not detected after trust dismiss", { chatId: args.chatId, hardCapMs: tuiReadyMs + 5_000 })
    } else {
      console.log("[kanna/pty] TUI ready", { chatId: args.chatId })
    }
  } else {
    const readyResult = await waitForTuiReady(ring, { hardCapMs: tuiReadyMs })
    if (readyResult === "timeout") {
      console.warn("[kanna/pty] TUI ready marker not detected within hard cap", { chatId: args.chatId, hardCapMs: tuiReadyMs })
    }
  }

  // Open transcript-file event stream.
  const projectDir = computeProjectDir({ homeDir: home, cwd: args.localPath })
  // knownFilePath: only known up-front when resuming (we know the
  // sessionToken). For new sessions interactive TUI claude generates its
  // own UUID and ignores `--session-id`, so the path is unknown — fall
  // back to discovery via `findLatestTranscript` with an mtime floor at
  // spawn-start time to filter out stale JSONLs from prior sessions in
  // the same project dir.
  const knownFilePath = args.sessionToken && !args.forkSession
    ? computeJsonlPath({ homeDir: home, cwd: args.localPath, sessionId: args.sessionToken })
    : undefined
  const spawnStartedAtMs = Date.now()
  const startStream = args.startTranscriptStreamFn ?? startTranscriptStream
  const transcriptStream = await startStream({
    projectDir,
    knownFilePath,
    minMtimeMs: spawnStartedAtMs,
    pollMode: (args.env ?? process.env).KANNA_PTY_TRANSCRIPT_WATCH === "poll",
  })

  const parser = createJsonlEventParser({
    configuredContextWindow: parseConfiguredContextWindowFromModelId(args.model),
  })

  // Pipe transcript JSONL lines through the parser into the merged event queue.
  void (async () => {
    try {
      for await (const line of transcriptStream.lines) {
        try {
          const events = parser.parse(line)
          for (const ev of events) pushMerged(ev)
        } catch (err) {
          console.warn("[kanna/pty] parser threw on line", err)
        }
      }
    } catch (err) {
      console.warn("[kanna/pty] transcript stream errored", err)
    }
  })()

  function drainTerminate(exitCode: number | null) {
    if (closed || oneShotClosing) {
      while (mergedWaiters.length > 0) {
        const w = mergedWaiters.shift()
        if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
      }
      return
    }
    if (!sawResultEntry) {
      const tail = ring.tail().trim()
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

  void pty.exited
    .then((code) => drainTerminate(typeof code === "number" ? code : null))
    .catch(() => drainTerminate(null))

  async function oneShotClose() {
    if (oneShotClosing || closed) return
    oneShotClosing = true
    try { await sendExitCommand(pty) } catch { /* swallow */ }
    try { await pty.exited } catch { /* swallow */ }
    try { transcriptStream.close() } catch { /* swallow */ }
    await cleanupResources()
  }

  if (args.initialPrompt) {
    try {
      await sendUserPrompt(pty, ring, args.initialPrompt)
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
      try { await pty.sendInput("\x03") } catch { /* swallow */ }
    },
    sendPrompt: async (content) => {
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n")
          : String(content)
      await sendUserPrompt(pty, ring, text)
    },
    setModel: async (model) => {
      try {
        await pty.sendInput(`/model ${model}\r`)
      } catch (err) {
        console.warn("[kanna/pty] setModel via /model slash command failed", err)
      }
    },
    setPermissionMode: async (planMode) => {
      if (planMode) {
        try {
          await pty.sendInput("/plan\r")
          localPlanModeActive = true
        } catch (err) {
          console.warn("[kanna/pty] /plan slash command failed", err)
        }
        return
      }
      if (localPlanModeActive) {
        try {
          await pty.sendInput(SHIFT_TAB_KEY)
          localPlanModeActive = false
        } catch (err) {
          console.warn("[kanna/pty] Shift+Tab exit-plan failed", err)
        }
        return
      }
      console.warn(PLAN_MODE_EXIT_UNSUPPORTED)
    },
    getSupportedCommands: async () => cachedSlashCommands ?? STATIC_SUPPORTED_COMMANDS,
    getAccountInfo: async () => cachedAccountInfo,
    close: () => {
      if (closed) return
      closed = true
      void (async () => {
        // 3-stage shutdown escalation:
        //   1. /exit (graceful REPL exit)               — 2 s grace
        //   2. SIGTERM (terminal.close + proc.kill)     — 3 s grace
        //   3. SIGKILL (force kill, unblocks hung TUI)
        // Each timer is cleared if pty.exited resolves before the deadline.
        try { await sendExitCommand(pty) } catch { /* swallow */ }
        const sigkillTimer = { ref: null as ReturnType<typeof setTimeout> | null }
        const termTimer = setTimeout(() => {
          try { pty.close() } catch { /* swallow */ }
          sigkillTimer.ref = setTimeout(() => {
            try { pty.kill("SIGKILL") } catch { /* swallow */ }
          }, 3000)
        }, 2000)
        try {
          await pty.exited
        } catch { /* swallow */ }
        clearTimeout(termTimer)
        if (sigkillTimer.ref !== null) clearTimeout(sigkillTimer.ref)
        try { transcriptStream.close() } catch { /* swallow */ }
        await cleanupResources()
        while (mergedWaiters.length > 0) {
          const w = mergedWaiters.shift()
          if (w) w({ value: undefined as unknown as HarnessEvent, done: true })
        }
      })()
    },
  }
}
