/**
 * Whether Kanna's Claude sessions get Claude in Chrome (the browser
 * extension's `mcp__claude-in-chrome__*` tools).
 *
 * The CLI loads that MCP server in an interactive session when the user has
 * turned it on by default (`/chrome` → "Enabled by default", stored as
 * `claudeInChromeDefaultEnabled` in Claude's global config). A headless
 * session — which is what the Agent SDK spawns — ignores that preference and
 * only connects with an explicit `--chrome`. So Kanna reads the same
 * preference and passes the flag, and a chat behaves like the user's own
 * `claude` would.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

/** Claude's global config: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeGlobalConfigPath(env: Record<string, string | undefined> = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  return path.join(configDir || homedir(), ".claude.json")
}

export async function isClaudeInChromeEnabled(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(claudeGlobalConfigPath(env), "utf8")) as unknown
    return Boolean(config && typeof config === "object"
      && (config as Record<string, unknown>).claudeInChromeDefaultEnabled === true)
  } catch {
    // No config yet, or one mid-write by a running `claude`: no Chrome.
    return false
  }
}
