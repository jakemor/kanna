import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, Match } from "effect"

import type { AgentProvider } from "../shared/types"
import { grokSessionDir } from "./grok-cli"
import { Machine } from "./platform/machine"

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
  /** Injectable home directory; defaults to the machine's. Tests pass a temp dir. */
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
const statusFor = Effect.fn("SessionArtifacts.statusFor")(function* (parentDir: string, artifactPath: string) {
  const fs = yield* FileSystem.FileSystem
  // A path that cannot be checked counts as absent, as `existsSync` had it.
  const exists = (filePath: string) =>
    fs.exists(filePath).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))
  if (yield* exists(artifactPath)) return "present"
  if (!(yield* exists(parentDir))) return "unknown"
  return "missing"
})

export const checkSessionArtifact = Effect.fn("SessionArtifacts.check")(function* (
  provider: AgentProvider,
  query: SessionArtifactQuery,
) {
  yield* Effect.annotateCurrentSpan("provider", provider)
  const sessionToken = query.sessionToken
  if (!isSafeToken(sessionToken)) return "unknown" satisfies SessionArtifactStatus
  const home = query.home ?? (yield* Machine).homeDirectory

  return yield* Match.value(provider).pipe(
    Match.when("claude", () => {
      const parent = claudeProjectDir(home, query.cwd)
      return statusFor(parent, path.join(parent, `${sessionToken}.jsonl`))
    }),
    Match.when("cursor", () => {
      const parent = cursorChatsDir(home, query.cwd)
      return statusFor(parent, path.join(parent, sessionToken))
    }),
    Match.when("grok", () => {
      const parent = grokSessionDir(home, query.cwd)
      return statusFor(parent, path.join(parent, sessionToken))
    }),
    // codex surfaces its own resume failure (isRecoverableResumeError); pi is
    // out of scope. Neither is checked on disk.
    Match.whenOr("codex", "pi", () => Effect.succeed<SessionArtifactStatus>("unknown")),
    Match.exhaustive,
  )
})
