import path from "node:path"
import { CodexAppServerManager } from "../codex-app-server"
import { CursorCliManager } from "../cursor-cli"
import { GrokCliManager } from "../grok-cli"
import { PiAgentManager } from "../pi-agent"
import { startKannaServer, type StartKannaServerOptions } from "../server"

function unavailable(cli: string): never {
  throw new Error(`${cli} is not available to a test server`)
}

/**
 * A machine with no agent CLIs, no login shell and no LLM provider file of its
 * own. Every spawn fails the way a missing binary does, so model discovery
 * keeps the static catalog and no test sees this machine's accounts.
 */
export function offlineMachine(dataDir: string): NonNullable<StartKannaServerOptions["machine"]> {
  return {
    codexManager: new CodexAppServerManager({ spawnProcess: () => unavailable("codex") }),
    cursorManager: new CursorCliManager({ spawnProcess: () => unavailable("cursor-agent") }),
    grokManager: new GrokCliManager({ spawnProcess: () => unavailable("grok") }),
    piManager: new PiAgentManager({ dataDir: path.join(dataDir, "pi") }),
    startClaudeSession: async () => unavailable("claude"),
    inheritShellPath: async () => {},
    llmProviderFile: path.join(dataDir, "llm-provider.json"),
  }
}

/** startKannaServer on an {@link offlineMachine}. Needs a dataDir to keep its files in. */
export function startTestServer(options: StartKannaServerOptions & { dataDir: string }) {
  return startKannaServer({ ...options, machine: { ...offlineMachine(options.dataDir), ...options.machine } })
}
