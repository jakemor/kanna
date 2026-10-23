/**
 * Which `claude` runs Kanna's Claude turns: the one the user installed, the
 * same way codex, cursor-agent and grok run from the user's install.
 *
 * The Agent SDK ships its own copy of Claude Code (the platform package
 * @anthropic-ai/claude-agent-sdk-<os>-<arch>) and runs it unless handed a
 * path. That copy is pinned to the SDK version, so turns ran a different
 * Claude Code than the provider card's `claude auth status`, family aliases
 * like "opus" resolved to whatever that older copy knew, and wrappers on
 * PATH were skipped. The SDK is only the wire protocol here; the binary is
 * the user's.
 *
 * The SDK does no version handshake: an older CLI handed an option it does
 * not know exits with "unknown option" partway into a turn. So a CLI older
 * than the one the SDK was built against counts as outdated, and the
 * provider card offers `claude update`.
 */

import { Effect, FileSystem, Option, Schema } from "effect"
// Read at build time: the published server is a bundle with the SDK inlined
// (scripts/build-server.ts), so there's no SDK folder on disk to look in. By
// path, because the SDK's `exports` doesn't list package.json.
import sdkPackage from "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" }
import { compareVersions } from "./cli-runtime"
import { Machine } from "./platform/machine"
import { type CommandSpawnError, resolveCommandPath, runCommand } from "./process-utils"

/** Set to a wrapper script (Bedrock, Foundry…) to run it instead of `claude`. */
export const CLAUDE_EXECUTABLE_ENV_VAR = "CLAUDE_EXECUTABLE"

export const CLAUDE_INSTALL_HINT =
  "Install Claude Code from Settings → Providers, or run `curl -fsSL https://claude.ai/install.sh | bash`."

/** How long `claude --version` may run before it is killed and read as unknown. */
const VERSION_TIMEOUT_MS = 15_000

export type ClaudeExecutable =
  | { ok: true; path: string; version: string | null }
  | { ok: false; reason: "not_installed"; message: string }
  | { ok: false; reason: "outdated"; message: string; path: string; version: string }

/** No usable `claude`: not installed, or older than the SDK pairs with. */
export class ClaudeExecutableError extends Schema.TaggedError<ClaudeExecutableError>()(
  "@kanna/server/claude-executable/ClaudeExecutableError",
  {
    reason: Schema.Literals(["not_installed", "outdated"]),
    message: Schema.String,
  },
) {}

/**
 * The Claude Code version this Agent SDK was built against (its
 * `claudeCodeVersion`; SDK 0.3.N pairs with Claude Code 2.1.N).
 */
export function claudeCodeMinimumVersion(): string {
  const version = (sdkPackage as { claudeCodeVersion?: unknown }).claudeCodeVersion
  return typeof version === "string" ? version : "0.0.0"
}

/** `CLAUDE_EXECUTABLE`, with a leading ~ expanded to `homeDirectory` (the SDK spawns it verbatim). */
export function claudeExecutableOverride(env: Record<string, string | undefined>, homeDirectory: string): string | null {
  const value = env[CLAUDE_EXECUTABLE_ENV_VAR]?.trim()
  return value ? value.replace(/^~(?=\/|$)/, homeDirectory) : null
}

/** `claudeExecutableOverride` for the machine's environment and home. */
export const machineClaudeExecutableOverride = Effect.fn("ClaudeExecutable.machineOverride")(function* () {
  const machine = yield* Machine
  return claudeExecutableOverride(machine.env.snapshot(), machine.homeDirectory)
})

/** "2.1.280 (Claude Code)" → "2.1.280". */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

export function isClaudeVersionSupported(version: string, minimum = claudeCodeMinimumVersion()) {
  return compareVersions(version, minimum) >= 0
}

export function outdatedClaudeMessage(version: string, minimum = claudeCodeMinimumVersion()) {
  return `Claude Code ${version} is older than Kanna supports (${minimum} or newer). Update it from Settings → Providers, or run \`claude update\`.`
}

export interface ResolveClaudeExecutableDeps {
  /** Default: the machine's environment. */
  env?: Record<string, string | undefined>
  /** Where `command` is on PATH (default: process-utils' login-shell lookup). */
  resolveCommandPath?: (command: string) => Effect.Effect<string | null, never, ResolveCommandPathServices>
  /** `claude --version`, parsed (default: run it, cached per binary). */
  readVersion?: (binaryPath: string) => Effect.Effect<string | null, CommandSpawnError, FileSystem.FileSystem>
  minimumVersion?: string
}

/** What process-utils' lookup runs on. */
export type ResolveCommandPathServices = Effect.Services<ReturnType<typeof resolveCommandPath>>

/** process-utils' lookup, which asks a login shell when PATH misses. */
export const resolveCommandPathEffect = (command: string) => resolveCommandPath(command)

/** Types a result in place, so its `ok` stays a literal. */
const executable = (value: ClaudeExecutable): ClaudeExecutable => value

/**
 * `claude --version` costs a process start, so it runs once per binary and
 * again only when the file changes (an update replaces it).
 */
const versionCache = new Map<string, { mtimeMs: number; version: string | null }>()

export const readClaudeVersion = Effect.fn("ClaudeExecutable.readVersion")(function* (binaryPath: string) {
  yield* Effect.annotateCurrentSpan("binaryPath", binaryPath)
  const fs = yield* FileSystem.FileSystem
  // Unreadable: run it anyway and let the spawn report the problem.
  const mtimeMs = yield* fs.stat(binaryPath).pipe(
    Effect.map((info) => Option.match(info.mtime, { onNone: () => -1, onSome: (mtime) => mtime.getTime() })),
    Effect.orElseSucceed(() => -1),
  )
  const cached = versionCache.get(binaryPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.version

  // A CLI that hangs is killed after the timeout, and its version is unknown.
  const output = yield* runCommand([binaryPath, "--version"], { stdout: true, stderr: true }).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
  )
  const version = Option.match(output, {
    onNone: () => null,
    onSome: ({ stdout, stderr }) => parseClaudeVersion(`${stdout}\n${stderr}`),
  })
  versionCache.set(binaryPath, { mtimeMs, version })
  return version
})

export const resolveClaudeExecutable = Effect.fn("ClaudeExecutable.resolve")(function* (
  deps: ResolveClaudeExecutableDeps = {},
) {
  // An explicit override is trusted as-is: wrappers often don't answer
  // --version the way claude does.
  const machine = yield* Machine
  const override = claudeExecutableOverride(deps.env ?? machine.env.snapshot(), machine.homeDirectory)
  if (override) return executable({ ok: true, path: override, version: null })

  const binaryPath = yield* (deps.resolveCommandPath ?? resolveCommandPathEffect)("claude")
  if (!binaryPath) {
    return executable({ ok: false, reason: "not_installed", message: `Claude Code isn't installed. ${CLAUDE_INSTALL_HINT}` })
  }

  const version = yield* (deps.readVersion ?? readClaudeVersion)(binaryPath)
  const minimum = deps.minimumVersion ?? claudeCodeMinimumVersion()
  // An unreadable version is let through: the turn's own error is more
  // useful than a guess.
  if (version && !isClaudeVersionSupported(version, minimum)) {
    return executable({
      ok: false,
      reason: "outdated",
      message: outdatedClaudeMessage(version, minimum),
      path: binaryPath,
      version,
    })
  }
  return executable({ ok: true, path: binaryPath, version })
})

/** The path to hand the SDK, or a `ClaudeExecutableError` that explains what to do. */
export const requireClaudeExecutable = Effect.fn("ClaudeExecutable.require")(function* (
  deps?: ResolveClaudeExecutableDeps,
) {
  const resolved = yield* resolveClaudeExecutable(deps)
  if (!resolved.ok) {
    return yield* new ClaudeExecutableError({ reason: resolved.reason, message: resolved.message })
  }
  return resolved.path
})
