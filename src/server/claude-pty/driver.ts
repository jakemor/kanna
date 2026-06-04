import { homedir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createRuntimeDir, writeRuntimeFile, removeRuntimeDir } from "./runtime-dir.adapter"
import { verifyPtyAuth } from "./auth"
import { startKannaMcpHttpServer, buildMcpConfigJson, type KannaMcpHttpHandle } from "../kanna-mcp-http"
import { KANNA_MCP_SERVER_NAME } from "../../shared/tools"
import type { KannaMcpDelegationContext } from "../kanna-mcp"
import type { SubagentOrchestrator } from "../subagent-orchestrator"
import { parseConfiguredContextWindowFromModelId, timestamped } from "../agent"
import { KANNA_SYSTEM_PROMPT_APPEND } from "../../shared/kanna-system-prompt"
import { resolveClaudeBinary } from "./resolve-binary.adapter"
import { createJsonlEventParser } from "./jsonl-to-event"
import { OutputRing, OUTPUT_RING_DEFAULT_BYTES } from "./output-ring"
import { createSmokeTestGate, createFileSmokeTestCache, buildLiveSmokeProbe, type SmokeTestGate } from "./smoke-test"
import { computeBinarySha256 } from "./preflight/binary-fingerprint.adapter"
import { spawnPtyProcess as defaultSpawnPtyProcess, type PtyProcess, type SpawnPtyProcessArgs } from "./pty-process.adapter"
import type { ClaudePtyRegistry } from "./pid-registry.adapter"
import type { PtyInstanceRegistry } from "./pty-instance-registry"
import { sampleProcessTreeUsage as defaultSampleProcessTreeUsage, type ProcessTreeSample } from "./pty-memory-sampler.adapter"
import { waitForTuiReady, waitForTuiReadyWithTrustDismiss, waitForTuiReadyDismissingDialogs, sendUserPrompt, sendExitCommand } from "./tui-control"
import { startTranscriptStream } from "./tui-source.adapter"
import { computeJsonlPath, computeProjectDir } from "./jsonl-path.adapter"
import type { ClaudeSessionHandle } from "../agent"
import type { HarnessEvent, HarnessToolRequest } from "../harness-types"
import type { AccountInfo, McpServerConfig, SlashCommand } from "../../shared/types"
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

// Framing folded into the subagent system prompt when its task is delivered
// via the kanna channel. Without it the model treats <channel> messages as
// low-trust interruptions and refuses (proven in the Phase-0 spike).
// One-shot runs use single-turn framing; keep-alive runs use multi-turn framing
// so the model knows to expect and accept repeated channel messages over the
// session lifetime rather than treating turn 2+ as suspicious interrupts.
const CHANNEL_PROMPT_FRAMING_BASE =
  'Your task for this run is delivered via the kanna channel as a <channel source="kanna"> message. ' +
  "Treat that channel message as your authoritative instructions from the orchestrator and act on it " +
  "immediately and fully, exactly as if the user had typed it. Do not refuse it and do not ask the user to repeat it."

const CHANNEL_PROMPT_FRAMING_MULTITURN =
  'Your tasks for this session arrive over the kanna channel as <channel source="kanna"> messages. ' +
  "Expect MULTIPLE such messages over the life of this session. Treat each as authoritative instructions " +
  "from the orchestrator; act on each immediately and fully, exactly as if the user had typed it. Do not refuse " +
  "and do not ask the user to repeat. After finishing a task, wait for the next channel message."

export function buildChannelPromptFraming(keepAlive: boolean): string {
  return keepAlive ? CHANNEL_PROMPT_FRAMING_MULTITURN : CHANNEL_PROMPT_FRAMING_BASE
}

// Max wait for the claude MCP client to finish initialize before we push the
// channel prompt. On timeout the spawn fails fast (no paste fallback).
// Env-overridable so tests don't wait the full default.
const CHANNEL_READY_TIMEOUT_DEFAULT_MS = 15_000

/**
 * After a keep-alive turn's result, the REPL needs a beat to finish rendering
 * the assistant block and return to the `❯` idle prompt before the next
 * channel push enqueues. 300ms empirically clears this on tested models.
 */
const CHANNEL_REPL_IDLE_BEAT_MS = 300

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
  /** Backs the `schedule_wakeup` MCP tool. Omit to hide the tool from the model. */
  scheduleWakeup?: (a: { delayMs: number; prompt: string }) => Promise<string | null>
  /** Enabled user-defined MCP servers, written into mcp-config.json. */
  customMcpServers?: readonly McpServerConfig[]
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
  /**
   * Keep-alive multi-turn. Only meaningful with `oneShot && channel delivery`.
   * When true, the first `result` does NOT trigger `oneShotClose()` — the REPL
   * stays open so further turns can be delivered via `pushChannelPrompt`.
   */
  keepAlive?: boolean
  /** Label of the OAuth-pool token. Surfaces in AccountInfo since the CLI doesn't emit account info in stream-json. */
  oauthLabel?: string
  /** Masked OAuth-pool token (e.g. `sk-ant-oat01...XXXX`). Computed by AgentCoordinator; never the raw token. */
  oauthKeyMasked?: string
  /**
   * Optional on-disk registry of claude PTY children so a non-graceful
   * server crash can reap orphan processes on the next boot. When set,
   * the driver registers the spawn's pid + runtimeDir before sending the
   * first prompt and unregisters during cleanup.
   */
  ptyRegistry?: ClaudePtyRegistry
  /**
   * Optional in-memory live-status registry surfaced to the client UI.
   * Driver upserts phase transitions; ws-router fans deltas out to
   * subscribed sockets.
   */
  ptyInstanceRegistry?: PtyInstanceRegistry
  /**
   * Optional registry for workflow runs. When set, the driver registers
   * the chat's workflows dir once the transcript file path is known and
   * unregisters on cleanup.
   */
  workflowRegistry?: import("../workflow-registry").WorkflowRegistry
  /** Optional sampler override (tests inject deterministic values). */
  sampleProcessTreeUsage?: (pid: number) => Promise<ProcessTreeSample | null>
  /** Optional poll-interval override (ms). Defaults to 2000. */
  memorySamplerIntervalMs?: number
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
 *
 * `ScheduleWakeup` is disallowed for the same reason: the native CLI wake is
 * a dead-letter under Kanna's spawn model (the fire lands as an isMeta:true
 * transcript line that `jsonl-to-event.ts` drops, and the in-memory cron dies
 * on restart). Kanna force-registers `mcp__kanna__schedule_wakeup` instead,
 * which owns the timer via the event-sourced ScheduleManager. The shim is only
 * registered when a `scheduleWakeup` callback is supplied (main chats), so
 * subagent spawns simply lose the no-op native tool — which is correct, they
 * should not self-schedule. See adr-20260603-agent-self-scheduled-wake.
 */
export const PTY_DISALLOWED_NATIVE_TOOLS = ["AskUserQuestion", "ExitPlanMode", "ScheduleWakeup"] as const

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
  /** When set, registers this MCP server as a dev channel so the host can
   *  push prompts via notifications/claude/channel (subagent one-shot only). */
  channelServerName?: string
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
  if (args.channelServerName) {
    cliArgs.push(
      "--dangerously-load-development-channels",
      `server:${args.channelServerName}`,
    )
  }
  // `--disallowedTools` is variadic in the claude CLI (space-separated tool
  // strings as separate argv — code.claude.com/docs/en/cli-reference). Push
  // it LAST so it cannot greedily swallow a subsequent flag value.
  cliArgs.push("--disallowedTools", ...PTY_DISALLOWED_NATIVE_TOOLS)
  return cliArgs
}

/**
 * Resolve the UUID the spawn runs under.
 *   - new session (no token)     → fresh uuid (claude generates its own anyway)
 *   - resume (token, no fork)     → reuse the token so the transcript path is known up-front
 *   - fork (token + forkSession)  → MUST be a FRESH uuid, distinct from the source token.
 *
 * Forking with `sessionId === sessionToken` emits
 * `--session-id <tok> --resume <tok> --fork-session`, collides the new fork id
 * with the source session, and claude refuses the fork — so PTY-created
 * conversations could not be forked. Always mint a new id for forks.
 */
export function resolveSpawnSessionId(
  args: { sessionToken: string | null; forkSession: boolean },
  newId: () => string = randomUUID,
): string {
  if (args.forkSession) return newId()
  return args.sessionToken ?? newId()
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

  const spawnStartedAt = Date.now()
  args.ptyInstanceRegistry?.upsert(args.chatId, {
    cwd: args.localPath,
    model: args.model,
    accountLabel: args.oauthLabel ?? null,
    oauthMasked: args.oauthKeyMasked ?? null,
    phase: "spawning",
    startedAt: spawnStartedAt,
    lastEventAt: spawnStartedAt,
    planMode: args.planMode,
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

  const sessionId = resolveSpawnSessionId({
    sessionToken: args.sessionToken,
    forkSession: args.forkSession,
  })

  const runtimeDir = await createRuntimeDir(`kanna-pty-${sessionId.slice(0, 8)}-`)

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
        scheduleWakeup: args.scheduleWakeup,
        // PTY has no canUseTool hook — the durable approval protocol is the
        // only host path for AskUserQuestion/ExitPlanMode. Force the shims
        // on regardless of KANNA_MCP_TOOL_CALLBACKS (issue #215). Paired
        // with --disallowedTools AskUserQuestion ExitPlanMode above so the
        // model uses the shim instead of the auto-rejected native built-in.
        forceInteractiveToolCallbacks: true,
      },
    })
    await writeRuntimeFile(
      mcpConfigPath,
      buildMcpConfigJson(mcpHandle, args.customMcpServers ?? []),
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (err) {
    try { await (mcpHandle! as KannaMcpHttpHandle | undefined)?.close() } catch { /* swallow */ }
    try { await removeRuntimeDir(runtimeDir) } catch { /* swallow */ }
    throw err
  }

  const channelEnv = (args.env ?? process.env).KANNA_PTY_CHANNEL_DELIVERY ?? "enabled"
  const channelDeliveryEnabled =
    Boolean(args.oneShot) && Boolean(args.initialPrompt) && channelEnv !== "disabled"

  const effectiveSystemPromptOverride =
    channelDeliveryEnabled && args.systemPromptOverride
      ? `${args.systemPromptOverride}\n\n${buildChannelPromptFraming(Boolean(args.keepAlive))}`
      : args.systemPromptOverride

  const claudeBin = claudeBinAbs
  const cliArgs = buildPtyCliArgs({
    sessionId,
    model: args.model,
    effort: args.effort,
    planMode: args.planMode,
    sessionToken: args.sessionToken,
    forkSession: args.forkSession,
    additionalDirectories: args.additionalDirectories,
    systemPromptOverride: effectiveSystemPromptOverride,
    systemPromptAppend: args.systemPromptAppend,
    mcpConfigPath,
    channelServerName: channelDeliveryEnabled ? KANNA_MCP_SERVER_NAME : undefined,
  })

  let closed = false
  let cleanedUp = false
  // This handle's own OS pid, captured once the child spawns. Teardown is
  // scoped to it so a stale re-spawn handle (same chatId + sessionId, older
  // pid) cannot clobber the live registry entry on its delayed exit.
  let ownPid: number | null = null
  let workflowRegistrationCancelled = false
  let cachedAccountInfo: AccountInfo | null = deriveAccountInfoFromOauth({ label: args.oauthLabel, oauthKeyMasked: args.oauthKeyMasked })
  let sawResultEntry = false
  let cachedSlashCommands: SlashCommand[] | null = null
  let localPlanModeActive = args.planMode
  const mergedQueue: HarnessEvent[] = []
  const mergedWaiters: Array<(r: IteratorResult<HarnessEvent>) => void> = []

  async function cleanupResources() {
    if (cleanedUp) return
    cleanedUp = true
    stopMemorySampler()
    // Guard against the re-spawn clobber: only flip the chat to "exited" if
    // its live registry entry still belongs to THIS handle's pid. A newer
    // spawn for the same chatId already overwrote pid → leave it alone.
    if (ownPid !== null) {
      args.ptyInstanceRegistry?.markExitedIfCurrent(args.chatId, ownPid, {
        phase: "exited",
        exitedAt: Date.now(),
        lastEventAt: Date.now(),
      })
    }
    // PTY teardown no longer cancels pending tool-callback records. close()
    // also fires on transparent rotation / idle sweep where the model's
    // turn is still live; denying mid-prompt asks was the source of the
    // "ask_user_question dropped" UX bug. Pendings now resolve only via
    // explicit chat.cancel / chat.delete (cancelAllForChat in ws-router)
    // or recoverOnStartup fail-close on the next server boot.
    try { await mcpHandle.close() } catch (err) {
      // Logged because a swallowed mcpHandle close error means the loopback
      // HTTP server may still be listening — a real resource leak.
      console.warn("[kanna/pty] mcpHandle.close failed (HTTP server may leak)", { chatId: args.chatId, sessionId, err })
    }
    try { await removeRuntimeDir(runtimeDir) } catch (err) {
      console.warn("[kanna/pty] runtimeDir cleanup failed", { chatId: args.chatId, runtimeDir, err })
    }
    if (args.ptyRegistry && ownPid !== null) {
      // Unregister by THIS handle's pid (not sessionId): a live re-spawn
      // shares the sessionId, so a sessionId-scoped unregister would delete
      // the live process's reap entry. See pid-registry.adapter.ts.
      try { await args.ptyRegistry.unregister(ownPid) } catch (err) {
        // A stale entry on disk only matters across server restarts — log
        // for observability but do not fail cleanup.
        console.warn("[kanna/pty] ptyRegistry.unregister failed", { chatId: args.chatId, sessionId, pid: ownPid, err })
      }
    }
    workflowRegistrationCancelled = true
    args.workflowRegistry?.unregister(args.chatId)
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
      && !args.keepAlive
      && ev.type === "transcript"
      && (ev.entry as { kind?: string } | undefined)?.kind === "result"
    ) {
      void oneShotClose()
    }
  }

  let oneShotClosing = false
  // pty is declared before use; assigned in the spawn try-block below.
  let pty: PtyProcess

  let memorySamplerHandle: ReturnType<typeof setInterval> | null = null
  let rssPeakBytes = 0
  let cpuPeakPercent = 0

  function stopMemorySampler(): void {
    if (memorySamplerHandle !== null) {
      clearInterval(memorySamplerHandle)
      memorySamplerHandle = null
    }
  }

  function startMemorySampler(rootPid: number): void {
    if (memorySamplerHandle !== null) return
    const sampler = args.sampleProcessTreeUsage ?? defaultSampleProcessTreeUsage
    const intervalMs = args.memorySamplerIntervalMs ?? 2000
    const tick = async (): Promise<void> => {
      let sample: ProcessTreeSample | null
      try {
        sample = await sampler(rootPid)
      } catch {
        sample = null
      }
      if (sample === null) return
      if (sample.rssBytes > rssPeakBytes) rssPeakBytes = sample.rssBytes
      if (sample.cpuPercent > cpuPeakPercent) cpuPeakPercent = sample.cpuPercent
      args.ptyInstanceRegistry?.upsert(args.chatId, {
        rssBytes: sample.rssBytes,
        rssPeakBytes,
        cpuPercent: sample.cpuPercent,
        cpuPeakPercent,
      })
    }
    memorySamplerHandle = setInterval(() => { void tick() }, intervalMs)
    void tick()
  }

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
    console.log("[kanna/pty] pty spawned", { chatId: args.chatId, sessionId, pid: pty.pid })
    ownPid = pty.pid
    args.ptyInstanceRegistry?.upsert(args.chatId, {
      sessionId,
      pid: pty.pid,
      phase: "trust-dialog",
      lastEventAt: Date.now(),
    })
    startMemorySampler(pty.pid)
    // Record the live PTY in the on-disk registry so a non-graceful
    // server crash can reap this orphan on the next boot. Persistence is
    // best-effort — failure to write must not block the spawn.
    if (args.ptyRegistry) {
      try {
        await args.ptyRegistry.register({
          chatId: args.chatId,
          sessionId,
          pid: pty.pid,
          cwd: args.localPath,
          runtimeDir,
        })
      } catch (err) {
        console.warn("[kanna/pty] ptyRegistry.register failed (orphan reap on crash disabled for this session)", { chatId: args.chatId, sessionId, err })
      }
    }
  } catch (err) {
    console.error("[kanna/pty] spawn failed", {
      chatId: args.chatId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    try { await mcpHandle.close() } catch { /* swallow */ }
    try { await removeRuntimeDir(runtimeDir) } catch { /* swallow */ }
    throw err
  }

  // Wait for TUI to render its input box, dismissing the trust dialog if
  // present. The combined helper handles the ANSI-encoded trust dialog text
  // and keeps polling until the real "❯ " input box appears after dismiss.
  const tuiReadyMs = Number((args.env ?? process.env).KANNA_PTY_TUI_BOOT_MS ?? 3000)
  const tuiReadyQuietRaw = (args.env ?? process.env).KANNA_PTY_TUI_READY_QUIET_MS
  const tuiReadyQuietMs = tuiReadyQuietRaw !== undefined ? Number(tuiReadyQuietRaw) : undefined
  const trustDismiss = (args.env ?? process.env).KANNA_PTY_TRUST_DISMISS ?? "enabled"
  if (channelDeliveryEnabled && trustDismiss !== "disabled") {
    // Channel path: dismiss both trust dialog AND dev-channels dialog.
    // +8 s over the base cap to absorb both dialogs + project reload.
    const readyResult = await waitForTuiReadyDismissingDialogs(pty, ring, { hardCapMs: tuiReadyMs + 8_000 })
    if (readyResult === "timeout") {
      console.warn("[kanna/pty] TUI ready marker not detected after dialogs dismiss (channel path)", { chatId: args.chatId, hardCapMs: tuiReadyMs + 8_000 })
    } else {
      console.log("[kanna/pty] TUI ready (channel path)", { chatId: args.chatId })
    }
  } else if (trustDismiss !== "disabled") {
    // +5 s over the base cap to absorb trust-dialog dismiss + project reload.
    const readyResult = await waitForTuiReadyWithTrustDismiss(pty, ring, { hardCapMs: tuiReadyMs + 5_000, quietPeriodMs: tuiReadyQuietMs })
    if (readyResult === "timeout") {
      console.warn("[kanna/pty] TUI ready marker not detected after trust dismiss", { chatId: args.chatId, hardCapMs: tuiReadyMs + 5_000 })
    } else {
      console.log("[kanna/pty] TUI ready", { chatId: args.chatId })
    }
  } else {
    const readyResult = await waitForTuiReady(ring, { hardCapMs: tuiReadyMs, quietPeriodMs: tuiReadyQuietMs })
    if (readyResult === "timeout") {
      console.warn("[kanna/pty] TUI ready marker not detected within hard cap", { chatId: args.chatId, hardCapMs: tuiReadyMs })
    }
  }

  args.ptyInstanceRegistry?.upsert(args.chatId, {
    phase: "ready",
    lastEventAt: Date.now(),
  })

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
    // Race-free discovery via claude's per-PID session registry at
    // `${home}/.claude/sessions/<pid>.json`. Falls back to the mtime
    // heuristic if the registry file does not appear in time (older
    // claude versions, broken HOME, etc).
    claudeChildPid: pty.pid,
    homeDir: home,
  })

  // Once the transcript file is discovered, register the workflows dir with the
  // workflow registry. The actual session UUID (used by Claude for the on-disk
  // subdir) is embedded in the JSONL path — it is NOT `sessionId` (which is
  // kanna's internal spawn id). We derive it as: basename(filePath, '.jsonl').
  if (args.workflowRegistry) {
    const registry = args.workflowRegistry
    const chatId = args.chatId
    void transcriptStream.filePath.then((filePath) => {
      const sessionUUID = path.basename(filePath, ".jsonl")
      const workflowsDir = path.join(projectDir, sessionUUID, "workflows")
      if (!workflowRegistrationCancelled) registry.register(chatId, workflowsDir)
    }).catch((err) => {
      console.warn("[kanna/pty] workflowRegistry.register skipped: transcript file not found", { chatId: args.chatId, err })
    })
  }

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
          console.warn("[kanna/pty] parser threw on line", { chatId: args.chatId, sessionId, err })
        }
      }
      console.log("[kanna/pty] transcript stream ended", { chatId: args.chatId, sessionId })
    } catch (err) {
      console.warn("[kanna/pty] transcript stream errored", { chatId: args.chatId, sessionId, err })
    }
  })()

  function drainTerminate(exitCode: number | null) {
    console.log("[kanna/pty] drainTerminate", {
      chatId: args.chatId,
      sessionId,
      exitCode,
      closed,
      oneShotClosing,
      sawResultEntry,
      oneShot: Boolean(args.oneShot),
      waitersAwaitingEvent: mergedWaiters.length,
    })
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
      console.warn("[kanna/pty] synthesizing error-result for early PTY exit (no turn_duration / result row seen)", {
        chatId: args.chatId,
        sessionId,
        exitCode,
        ringTailBytes: tail.length,
      })
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
    .then((code) => {
      console.log("[kanna/pty] pty.exited resolved", { chatId: args.chatId, sessionId, pid: pty.pid, code })
      drainTerminate(typeof code === "number" ? code : null)
    })
    .catch((err) => {
      console.warn("[kanna/pty] pty.exited rejected", { chatId: args.chatId, sessionId, pid: pty.pid, err })
      drainTerminate(null)
    })

  async function oneShotClose() {
    if (oneShotClosing || closed) return
    oneShotClosing = true
    console.log("[kanna/pty] oneShotClose start", { chatId: args.chatId, sessionId, sawResultEntry })
    try { await sendExitCommand(pty) } catch (err) {
      console.warn("[kanna/pty] oneShotClose sendExitCommand failed", { chatId: args.chatId, sessionId, err })
    }
    try { await pty.exited } catch { /* swallow */ }
    try { transcriptStream.close() } catch { /* swallow */ }
    await cleanupResources()
    console.log("[kanna/pty] oneShotClose finished", { chatId: args.chatId, sessionId })
  }

  if (channelDeliveryEnabled && args.initialPrompt) {
    const readyTimeoutMs = Number(
      (args.env ?? process.env).KANNA_PTY_CHANNEL_READY_TIMEOUT_MS ?? CHANNEL_READY_TIMEOUT_DEFAULT_MS,
    )
    try {
      await Promise.race([
        mcpHandle.channelClientReady,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("channel client not ready")), readyTimeoutMs),
        ),
      ])
      // Settle: the channel handler registers just after the dev-channels
      // dialog is accepted and the client reports initialized.
      await new Promise((r) => setTimeout(r, 300))
      await mcpHandle.pushChannelPrompt(args.initialPrompt)
      console.log("[kanna/pty] delivered initial prompt via channel push", { chatId: args.chatId })
    } catch (err) {
      // FAIL FAST: do not paste. A silent paste would re-introduce the
      // multi-line truncation bug. Surface a clear spawn failure instead.
      const message = err instanceof Error ? err.message : String(err)
      console.error("[kanna/pty] channel delivery failed; failing spawn (no paste fallback)", { chatId: args.chatId, sessionId, error: message })
      try { transcriptStream.close() } catch { /* swallow */ }
      try { pty.close() } catch { /* swallow */ }
      try { await mcpHandle.close() } catch { /* swallow */ }
      try { await removeRuntimeDir(runtimeDir) } catch { /* swallow */ }
      throw new Error(`PTY channel delivery failed: ${message}`, { cause: err })
    }
  } else if (args.initialPrompt) {
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
    pushChannelPrompt: (channelDeliveryEnabled && args.keepAlive)
      ? async (text: string) => {
          // Ready promise already resolved during turn-1 delivery; settle a
          // beat so the REPL is back at idle before the next enqueue.
          await new Promise((r) => setTimeout(r, CHANNEL_REPL_IDLE_BEAT_MS))
          await mcpHandle.pushChannelPrompt(text)
        }
      : undefined,
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
