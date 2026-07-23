import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { AgentProvider } from "../shared/types"

/**
 * Whether a provider's native session artifact for a chat still exists on disk.
 *
 * - `present`  — the session file/dir is there; a normal resume will work.
 * - `missing`  — the provider's project-level dir exists but this session's
 *   artifact is gone (e.g. the CLI garbage-collected it). Safe to restore.
 * - `unknown`  — we can't tell (unsupported provider, no token, hostile token,
 *   or the provider's project dir itself is absent). Never triggers a restore,
 *   so the turn behaves exactly as it does today.
 */
export type SessionArtifactStatus = "present" | "missing" | "unknown"

export interface SessionArtifactQuery {
  cwd: string
  sessionToken: string | null | undefined
  /** Injectable home directory; defaults to the real one. Tests pass a temp dir. */
  home?: string
}

/**
 * Session tokens name a file/dir on disk. Reject anything that isn't a plain
 * token so a malformed value can never escape the provider's session dir or be
 * mistaken for a real (missing) artifact.
 */
const SAFE_TOKEN = /^[A-Za-z0-9][\w.-]*$/

function isSafeToken(token: string | null | undefined): token is string {
  return typeof token === "string" && SAFE_TOKEN.test(token)
}

/** Claude Code munges the cwd into its project dir name: non-alphanumerics → "-". */
function claudeProjectDir(home: string, cwd: string) {
  return path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
}

/** Cursor keys its chat dir by the md5 hex of the absolute cwd. */
function cursorChatsDir(home: string, cwd: string) {
  const hash = createHash("md5").update(cwd).digest("hex")
  return path.join(home, ".cursor", "chats", hash)
}

/**
 * A restore is only safe when the provider's project-level dir exists but the
 * specific session artifact within it is gone. If the whole project dir is
 * absent (CLI never ran here, or changed its storage layout), we return
 * `unknown` rather than `missing` — this guards against restore-loops if a
 * future CLI version relocates its sessions.
 */
function statusFor(parentDir: string, artifactPath: string): SessionArtifactStatus {
  if (existsSync(artifactPath)) return "present"
  if (!existsSync(parentDir)) return "unknown"
  return "missing"
}

export function checkSessionArtifact(
  provider: AgentProvider,
  query: SessionArtifactQuery
): SessionArtifactStatus {
  if (!isSafeToken(query.sessionToken)) return "unknown"
  const home = query.home ?? homedir()

  switch (provider) {
    case "claude": {
      const parent = claudeProjectDir(home, query.cwd)
      return statusFor(parent, path.join(parent, `${query.sessionToken}.jsonl`))
    }
    case "cursor": {
      const parent = cursorChatsDir(home, query.cwd)
      return statusFor(parent, path.join(parent, query.sessionToken))
    }
    // codex surfaces its own resume failure (isRecoverableResumeError); pi is
    // out of scope. Neither is checked on disk.
    default:
      return "unknown"
  }
}
