import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { requireClaudeExecutable } from "./claude-executable"
import type { ClaudeSdkModelInfo } from "./provider-catalog"

/** Claude Code's slowest first answer seen (a Bedrock backend starting up) fits well inside this. */
export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 25_000

/**
 * The query options for a probe that only reads Claude Code's model list.
 * Kept close to T3 Code's capabilities probe (apps/server/src/provider/
 * ClaudeProvider.ts, buildClaudeCapabilitiesProbeQueryOptions), which runs
 * the same kind of probe on every provider check:
 *
 * - The settings files still load (user, project, local), because they decide
 *   which models an account sees (`availableModels`, model env overrides).
 * - Hooks are off, so a SessionStart hook doesn't run on every probe.
 * - No MCP servers start: strict config with none passed, claude.ai
 *   connectors off, and no IDE auto-connect.
 * - No tools, and the session is not persisted, so nothing lands in
 *   ~/.claude/projects even if Claude Code gets further than it should.
 */
export function claudeModelProbeOptions(args: { executablePath: string; cwd: string; abortController: AbortController; env: NodeJS.ProcessEnv }) {
  const { CLAUDECODE: _, ...env } = args.env
  return {
    cwd: args.cwd,
    pathToClaudeCodeExecutable: args.executablePath,
    abortController: args.abortController,
    persistSession: false,
    settingSources: ["user", "project", "local"] as ("user" | "project" | "local")[],
    settings: { disableAllHooks: true, disableClaudeAiConnectors: true },
    tools: [] as string[],
    allowedTools: [] as string[],
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    } as NodeJS.ProcessEnv,
    stderr: () => {},
  }
}

/**
 * Ask the installed Claude Code for the account's model list without a turn.
 * The prompt stream never yields, so no message reaches the API: Claude Code
 * starts, answers supportedModels() over the control channel, and is aborted.
 * No tokens, no session file. Throws when Claude Code is missing, outdated or
 * signed out, or does not answer in time.
 */
export async function probeClaudeModels(cwd: string): Promise<ClaudeSdkModelInfo[]> {
  const executablePath = await requireClaudeExecutable()
  const abortController = new AbortController()
  const q = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }))
    })(),
    options: claudeModelProbeOptions({ executablePath, cwd, abortController, env: process.env }),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code did not list its models in time")), CLAUDE_MODEL_PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
    abortController.abort()
    q.close()
  }
}
