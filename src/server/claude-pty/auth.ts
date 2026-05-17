import { stat } from "node:fs/promises"
import path from "node:path"

export type VerifyPtyAuthResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Checks the spawn-time auth preconditions for PTY mode.
 *
 * `ANTHROPIC_API_KEY` is always rejected: PTY mode exists to preserve
 * subscription billing via OAuth; an API key would silently flip the CLI
 * back to API billing.
 *
 * Either of the following authenticates the spawn:
 * - A non-empty `oauthToken` arg, which the driver injects via
 *   `CLAUDE_CODE_OAUTH_TOKEN`. Per the upstream docs, that env var
 *   silently overrides `~/.claude/.credentials.json` and the macOS
 *   keychain (anthropics/claude-code#16238), so no on-disk credentials
 *   file is needed in that mode.
 * - An existing `~/.claude/.credentials.json` produced by a prior
 *   interactive `claude /login`.
 *
 * Either path lets the CLI subprocess complete OAuth without an
 * interactive browser handshake. Requiring `.credentials.json` even
 * when a token is supplied blocks Kanna OAuth-pool-only deployments
 * (CI runners, ephemeral VMs).
 */
export async function verifyPtyAuth(args: {
  homeDir: string
  env: NodeJS.ProcessEnv
  oauthToken?: string | null
}): Promise<VerifyPtyAuthResult> {
  if (typeof args.env.ANTHROPIC_API_KEY === "string" && args.env.ANTHROPIC_API_KEY.length > 0) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY is set in the environment. PTY mode uses Claude's subscription billing via OAuth keychain; remove the env var or use the SDK driver.",
    }
  }
  if (typeof args.oauthToken === "string" && args.oauthToken.length > 0) {
    return { ok: true }
  }
  const credentialsPath = path.join(args.homeDir, ".claude", ".credentials.json")
  try {
    await stat(credentialsPath)
  } catch {
    return {
      ok: false,
      error: `No Claude credentials available. Either supply an OAuth pool token in Kanna settings or run \`claude /login\` to create ${credentialsPath}.`,
    }
  }
  return { ok: true }
}
