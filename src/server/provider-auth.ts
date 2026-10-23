import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import {
  type Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  AUTH_SERVICE_LABELS,
  AUTH_SERVICE_ORDER,
  DEFAULT_OPENROUTER_SDK_MODEL,
  type AuthLoginFlowState,
  type AuthServiceId,
  type AuthServiceSnapshot,
  type LlmProviderSnapshot,
  type ProviderAuthSnapshot,
} from "../shared/types"
import { Analytics } from "./analytics"
import {
  claudeCodeMinimumVersion,
  claudeExecutableOverride,
  isClaudeVersionSupported,
  outdatedClaudeMessage,
  parseClaudeVersion,
  resolveCommandPathEffect,
} from "./claude-executable"
import { compareVersions } from "./cli-runtime"
import { parseGrokAuthStatus, parseGrokDeviceLogin, parseGrokVersion } from "./grok-cli"
import { type LlmProviderFileError, readLlmProviderSnapshot, writeLlmProviderSnapshot } from "./llm-provider"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { CommandSpawnError, ProcessSpawner } from "./platform/process-spawner"
import { PtySpawner } from "./platform/pty"

export { parseGrokAuthStatus, parseGrokDeviceLogin, parseGrokVersion }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Non-forced status probes within this window reuse the last read. */
const STATUS_TTL_MS = 60_000
/** Latest-version feeds are slow-moving; check at most hourly. */
const VERSION_TTL_MS = 60 * 60_000
/** Overall watchdog for a login flow that never resolves. */
const LOGIN_WATCHDOG_MS = 16 * 60_000
/** If `claude auth login` shows no OAuth URL by then, assume a menu and press Enter. */
const CLAUDE_MENU_FALLBACK_MS = 5_000
/** Give up waiting for the claude OAuth URL after this long. */
const CLAUDE_URL_TIMEOUT_MS = 30_000
/** After a pasted code, probe once this much later in case the CLI lingers. */
const CLAUDE_CODE_SAFETY_NET_MS = 15_000
/** How long a login CLI's last output may trail its exit before the flow moves on. */
const OUTPUT_DRAIN_MS = 1_000
/** The tail of a login CLI's output kept for parsing and failure details. */
const TRANSCRIPT_LIMIT = 16_384

/**
 * The GitHub CLI's public OAuth client id — we run the standard OAuth device
 * flow against it directly (deterministic, no PTY scraping), then hand the
 * resulting token to `gh auth login --with-token` so gh owns storage exactly
 * as if the user had run `gh auth login` themselves.
 */
const GH_CLIENT_ID = "178c6fc778ccc68e1d6a"
const GH_SCOPES = "repo read:org gist workflow"

type CliServiceId = Exclude<AuthServiceId, "openrouter">

const CLI_BINARIES: Record<CliServiceId, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  grok: "grok",
  gh: "gh",
}

const NPM_PACKAGES: Partial<Record<AuthServiceId, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
}

const CODEX_DEVICE_AUTH_HINT =
  "Device-code login may need to be enabled in your ChatGPT security settings (or by your workspace admin)."

// ---------------------------------------------------------------------------
// Pure parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences (CSI, OSC incl. OSC-8 hyperlinks, simple ESC). */
export function stripAnsi(text: string): string {
  return text
    // OSC sequences: ESC ] ... (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences: ESC [ ...
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Remaining single-char escapes
    .replace(/\x1b[@-_]/g, "")
}

export { parseClaudeVersion }

const GhUserJson = Schema.fromJsonString(Schema.Struct({
  login: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
}))

/**
 * Derive a git commit identity from a `gh api user` payload.
 *
 * The email is GitHub's privacy-preserving `<id>+<login>@users.noreply.github.com`
 * form — the same address the web UI commits under. We prefer it over the
 * account's profile email because that field is null for anyone who hasn't made
 * their address public, and because repos with email-privacy enforcement reject
 * pushes carrying a real address. Accounts predating numeric ids fall back to
 * the legacy `<login>@users.noreply.github.com`.
 */
export function parseGhUserIdentity(output: string): { name: string; email: string } | null {
  const decoded = Schema.decodeUnknownOption(GhUserJson)(output)
  if (Option.isNone(decoded)) return null
  const parsed = decoded.value
  const login = typeof parsed.login === "string" ? parsed.login.trim() : ""
  if (!login) return null
  const id = typeof parsed.id === "number" && Number.isInteger(parsed.id) && parsed.id > 0 ? parsed.id : null
  const displayName = typeof parsed.name === "string" ? parsed.name.trim() : ""
  return {
    name: displayName || login,
    email: `${id === null ? "" : `${id}+`}${login}@users.noreply.github.com`,
  }
}

export function parseCodexVersion(output: string): string | null {
  return /codex-cli\s+(\S+)/i.exec(output)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

export function parseCursorVersion(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? ""
  return line.length > 0 ? line : null
}

export function parseGhVersion(output: string): string | null {
  return /gh version\s+(\S+)/i.exec(output)?.[1] ?? null
}

export interface ClaudeAuthStatusParsed {
  loggedIn: boolean
  account: string | null
}

const ClaudeAuthStatusJson = Schema.fromJsonString(Schema.Struct({
  loggedIn: Schema.optional(Schema.Unknown),
  email: Schema.optional(Schema.Unknown),
  account: Schema.optional(Schema.Unknown),
  oauthAccount: Schema.optional(Schema.Unknown),
}))

const OauthAccount = Schema.Struct({ emailAddress: Schema.String })

/** `claude auth status --json` → { loggedIn, authMethod, ... } (exit 0 either way). */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatusParsed | null {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  const decoded = Schema.decodeUnknownOption(ClaudeAuthStatusJson)(stdout.slice(start, end + 1))
  if (Option.isNone(decoded)) return null
  const parsed = decoded.value
  const oauthEmail = Schema.decodeUnknownOption(OauthAccount)(parsed.oauthAccount).pipe(
    Option.map((account) => account.emailAddress),
  )
  const account =
    typeof parsed.email === "string" ? parsed.email
    : typeof parsed.account === "string" ? parsed.account
    : Option.getOrNull(oauthEmail)
  return { loggedIn: parsed.loggedIn === true, account }
}

export interface CursorStatusParsed {
  loggedIn: boolean
  account: string | null
}

/** `cursor-agent status` prints "Not logged in" or account info (exit 0 either way). */
export function parseCursorStatus(stdout: string): CursorStatusParsed {
  const text = stripAnsi(stdout)
  if (/not logged in/i.test(text)) return { loggedIn: false, account: null }
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0] ?? null
  return { loggedIn: true, account: email }
}

/** Account login from `gh auth status` output ("Logged in to github.com account NAME (…)"). */
export function parseGhAccount(output: string): string | null {
  return /account\s+(\S+)/i.exec(output)?.[1] ?? null
}

export interface DeviceLoginParsed {
  verificationUrl: string
  userCode: string | null
}

/**
 * `codex login --device-auth` output (ANSI already stripped):
 *   1. Open this link in your browser… https://auth.openai.com/codex/device
 *   2. Enter this one-time code (expires in 15 minutes) XXXX-XXXXX
 */
export function parseCodexDeviceLogin(text: string): DeviceLoginParsed | null {
  const url = /(https:\/\/\S*(?:device|auth\.openai\.com)\S*)/i.exec(text)?.[1] ?? null
  const code = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/.exec(text)?.[1] ?? null
  if (!url || !code) return null
  return { verificationUrl: url.replace(/[.,)]+$/, ""), userCode: code }
}

/** `cursor-agent login` (NO_OPEN_BROWSER=1): "…navigate to this link: https://cursor.com/…". */
export function parseCursorLogin(text: string): DeviceLoginParsed | null {
  const url = /(https:\/\/(?:www\.)?cursor\.com\/\S+)/i.exec(text)?.[1] ?? null
  if (!url) return null
  return { verificationUrl: url.replace(/[.,)]+$/, ""), userCode: null }
}

/**
 * Extract the OAuth authorize URL from raw `claude auth login` PTY output.
 * The full URL appears uninterrupted inside OSC-8 hyperlink params even when
 * the visible text wraps, so match the raw text (terminated by BEL/ESC/space).
 */
export function parseClaudeOauthUrl(rawText: string): string | null {
  const matches = rawText.match(/https:\/\/[^\s\x07\x1b"'\\]+/g) ?? []
  for (const candidate of matches) {
    if (/oauth/i.test(candidate) && /authorize/i.test(candidate)) {
      return candidate.replace(/[.,)]+$/, "")
    }
  }
  return null
}

export function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function truncateOutput(output: string, max = 400): string {
  const cleaned = output.trim().replace(/\s+/g, " ")
  return cleaned.length > max ? `…${cleaned.slice(-max)}` : cleaned
}

/** CLI rejected the invocation's syntax — it predates a flag/subcommand we rely on. */
function isUnknownCliSyntax(output: string): boolean {
  return /unknown (?:option|command|argument)|unexpected argument|unrecognized/i.test(output)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

const GhDeviceCode = Schema.Struct({
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
})

const GhTokenPoll = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
})

const GhRelease = Schema.Struct({ tag_name: Schema.optional(Schema.Unknown) })
const GrokUpdateCheckJson = Schema.fromJsonString(Schema.Struct({ latestVersion: Schema.optional(Schema.Unknown) }))
const OpenRouterKey = Schema.Struct({ key: Schema.optional(Schema.Unknown) })

// ---------------------------------------------------------------------------
// Errors and dependencies
// ---------------------------------------------------------------------------

/**
 * A provider-auth request that can't go ahead (a login for a CLI that isn't
 * installed, a code with no flow waiting for it, a failed OpenRouter
 * exchange), or a login/install step that failed. `message` is what the user
 * sees.
 */
export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  "@kanna/server/provider-auth/ProviderAuthError",
  {
    operation: Schema.Literals(["install", "login", "openrouter"]),
    service: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** A latest-version feed (npm) could not be read. */
export class LatestVersionError extends Schema.TaggedError<LatestVersionError>()(
  "@kanna/server/provider-auth/LatestVersionError",
  {
    packageName: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  readonly stdin?: string
  readonly env?: Record<string, string>
  /** Kill the process after this long; what it printed so far is still returned. */
  readonly timeoutMs?: number
}

/**
 * A login CLI that is running. It belongs to the scope it was spawned in and
 * is killed when that scope closes, if it hasn't exited by then.
 */
export interface LoginChild {
  /** Interleaved stdout/stderr (or the PTY's output), as text. Ends when the process exits. */
  readonly output: Stream.Stream<string>
  readonly exited: Effect.Effect<number>
  /** Present on PTY children (claude login needs code paste-back). */
  readonly write?: (data: string) => Effect.Effect<void>
}

type LlmProviderWrite =
  Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>

export interface ProviderAuthOptions {
  /** Run a command to completion (default: a real process). */
  readonly exec?: (argv: ReadonlyArray<string>, options?: ExecOptions) => Effect.Effect<ExecResult, CommandSpawnError>
  /** Start a login CLI with piped output (default: a real process). */
  readonly spawnStreaming?: (
    argv: ReadonlyArray<string>,
    options?: { readonly env?: Record<string, string> },
  ) => Effect.Effect<LoginChild, CommandSpawnError, Scope.Scope>
  /** Start a login CLI on a PTY (default: a real process on the machine's `PtySpawner`). */
  readonly spawnPty?: (argv: ReadonlyArray<string>) => Effect.Effect<LoginChild, CommandSpawnError, Scope.Scope>
  /** Default: the user's llm-provider.json. */
  readonly readLlmProvider?: Effect.Effect<LlmProviderSnapshot, LlmProviderFileError>
  readonly writeLlmProvider?: (value: LlmProviderWrite) => Effect.Effect<LlmProviderSnapshot, LlmProviderFileError>
  readonly fetch?: typeof fetch
  /** Latest published version of an npm package; without it claude/codex never offer an update. */
  readonly fetchLatestNpmVersion?: (packageName: string) => Effect.Effect<string, LatestVersionError>
  /** Default: process-utils' login-shell lookup. */
  readonly resolveCommandPath?: (command: string) => Effect.Effect<string | null>
  /** Whether a path is an executable file (default: the filesystem). */
  readonly isExecutable?: (filePath: string) => Effect.Effect<boolean>
  /** Oldest Claude Code Kanna runs turns on (default: the Agent SDK's pairing). */
  readonly claudeMinimumVersion?: string
  /** After a sign-in is verified (CLI flows) or saved (OpenRouter). */
  readonly onSignedIn?: (service: AuthServiceId) => Effect.Effect<void>
  readonly platform?: NodeJS.Platform
}

/**
 * Each provider CLI's install and sign-in state (claude, codex, cursor-agent,
 * grok, gh) plus OpenRouter's key, for the provider cards. Probes are
 * TTL-coalesced; installs and logins run the CLIs themselves, and a login's
 * process lives until the flow ends, is cancelled or superseded, or the layer
 * is released.
 *
 * `changes` emits each snapshot after the current one, never the current one
 * itself; read that with `snapshot`.
 */
export class ProviderAuth extends Context.Service<ProviderAuth, {
  readonly snapshot: Effect.Effect<ProviderAuthSnapshot>
  readonly changes: Stream.Stream<ProviderAuthSnapshot>
  /** Refresh every service's installed/signed-in state (TTL-coalesced unless forced). */
  readonly refresh: (options?: { readonly force?: boolean }) => Effect.Effect<void>
  /** Force-probe one service (post login/install). */
  readonly probeService: (service: AuthServiceId) => Effect.Effect<void>
  /** Install or update a CLI. Progress and failures land in the snapshot. */
  readonly install: (service: AuthServiceId) => Effect.Effect<void, ProviderAuthError>
  readonly startLogin: (service: AuthServiceId) => Effect.Effect<void, ProviderAuthError>
  readonly submitLoginCode: (service: AuthServiceId, code: string) => Effect.Effect<void, ProviderAuthError>
  readonly cancelLogin: (service: AuthServiceId) => Effect.Effect<void>
  readonly startOpenRouterAuth: (callbackUrl: string) => Effect.Effect<{ authUrl: string }, ProviderAuthError>
  readonly exchangeOpenRouterCode: (
    code: string,
  ) => Effect.Effect<LlmProviderSnapshot, ProviderAuthError | LlmProviderFileError>
}>()("@kanna/server/ProviderAuth") {
  static readonly layer = (options: ProviderAuthOptions = {}) => Layer.effect(this, makeProviderAuth(options))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** How a login flow ended. */
type FlowEnd =
  /** The CLI finished; only a probe that reads signed-in counts. */
  | { readonly _tag: "Exited" }
  /** Already verified signed in (claude's pasted-code safety net). */
  | { readonly _tag: "SignedIn" }
  | { readonly _tag: "Failed"; readonly message: string; readonly hint: string | null }
  /** Nothing left to report. */
  | { readonly _tag: "Ended" }

const exitedEnd: FlowEnd = { _tag: "Exited" }
const failedEnd = (message: string, hint: string | null = null): FlowEnd => ({ _tag: "Failed", message, hint })

interface LoginFlow {
  readonly service: CliServiceId
  /** The CLI process, its output reader and the flow's timers. */
  readonly scope: Scope.Closeable
  /** Completed by a timer that ends the flow early. */
  readonly ended: Deferred.Deferred<FlowEnd>
  fiber: Fiber.Fiber<void> | null
  child: LoginChild | null
  codeSubmitted: boolean
  /** Raw output tail kept for a debuggable failure detail (never in snapshots). */
  transcript: string
}

function initialServiceSnapshot(service: AuthServiceId): AuthServiceSnapshot {
  return {
    service,
    label: AUTH_SERVICE_LABELS[service],
    installed: service === "openrouter",
    version: null,
    latestVersion: null,
    updateAvailable: false,
    authStatus: "unknown",
    account: null,
    statusDetail: null,
    login: { phase: "idle" },
    installState: "idle",
    installError: null,
    checkedAt: null,
  }
}

function applyPatch(previous: AuthServiceSnapshot, patch: Partial<AuthServiceSnapshot>): AuthServiceSnapshot {
  const next: AuthServiceSnapshot = { ...previous, ...patch }
  next.updateAvailable = Boolean(
    next.installed &&
    next.version &&
    next.latestVersion &&
    compareVersions(next.version, next.latestVersion) < 0
  )
  return next
}

type RefreshAction =
  | { readonly _tag: "join"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "start"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "skip" }

const makeProviderAuth = Effect.fn("ProviderAuth.make")(function* (options: ProviderAuthOptions) {
  const analytics = yield* Analytics
  const layerScope = yield* Effect.scope
  const machine = yield* Machine
  const files = yield* FileSystemExtras
  // Only the platform: the whole context would carry the layer's Scope over the caller's.
  const platformContext = Context.pick(FileSystem.FileSystem, ProcessSpawner, PtySpawner, Machine, FileSystemExtras)(
    yield* Effect.context<FileSystem.FileSystem | ProcessSpawner | PtySpawner | Machine | FileSystemExtras>(),
  )

  const exec = options.exec
    ?? ((argv: ReadonlyArray<string>, execOptions?: ExecOptions) => execCommand(argv, execOptions).pipe(Effect.provide(platformContext)))
  const spawnStreaming = options.spawnStreaming
    ?? ((argv: ReadonlyArray<string>, spawnOptions?: { readonly env?: Record<string, string> }) =>
      spawnStreamingCommand(argv, spawnOptions).pipe(Effect.provide(platformContext)))
  const spawnPty = options.spawnPty
    ?? ((argv: ReadonlyArray<string>) => spawnPtyCommand(argv).pipe(Effect.provide(platformContext)))
  const readLlmProvider = options.readLlmProvider
    ?? readLlmProviderSnapshot().pipe(Effect.provide(platformContext))
  const writeLlmProvider = options.writeLlmProvider
    ?? ((value: LlmProviderWrite) =>
      writeLlmProviderSnapshot({ ...value, faveModels: value.faveModels ?? [] }).pipe(
        Effect.provide(platformContext),
      ))
  const fetchFn = options.fetch ?? fetch
  const resolveCommand = options.resolveCommandPath
    ?? ((command: string) => resolveCommandPathEffect(command).pipe(Effect.provide(platformContext)))
  const isExecutable = options.isExecutable ?? files.isExecutableFile
  const platform = options.platform ?? machine.platform
  const claudeOverride = () => claudeExecutableOverride(machine.env.snapshot(), machine.homeDirectory)
  const onSignedIn = options.onSignedIn ?? (() => Effect.void)

  const ref = yield* SubscriptionRef.make<ProviderAuthSnapshot>({
    services: AUTH_SERVICE_ORDER.map(initialServiceSnapshot),
  })
  const flows = new Map<AuthServiceId, LoginFlow>()
  const commandPaths = new Map<string, string | null>()
  /** Latest probe started per service; an older probe's result is dropped. */
  const probeSeq = new Map<AuthServiceId, number>()
  const lastStatusRefreshAt = yield* Ref.make(Option.none<number>())
  const refreshInFlight = yield* Ref.make(Option.none<Deferred.Deferred<void>>())
  let lastVersionCheckAt: number | null = null
  let openRouterVerifier: string | null = null

  const track = (eventName: string, service: AuthServiceId) => analytics.track(eventName, { service })

  const serviceSnapshot = (service: AuthServiceId) =>
    SubscriptionRef.get(ref).pipe(
      Effect.map((snapshot) => snapshot.services.find((entry) => entry.service === service) ?? initialServiceSnapshot(service)),
    )

  const patchService = (service: AuthServiceId, patch: Partial<AuthServiceSnapshot>) =>
    SubscriptionRef.update(ref, (snapshot) => ({
      services: snapshot.services.map((entry) => entry.service === service ? applyPatch(entry, patch) : entry),
    }))

  const setLogin = (service: AuthServiceId, login: AuthLoginFlowState) => patchService(service, { login })

  const resolvePath = Effect.fn("ProviderAuth.resolvePath")(function* (command: string, resolve?: { fresh?: boolean }) {
    if (!resolve?.fresh && commandPaths.has(command)) {
      return commandPaths.get(command) ?? null
    }
    const resolved = yield* resolveCommand(command)
    commandPaths.set(command, resolved)
    return resolved
  })

  /** The binary the card probes and updates: the same `claude` turns run (claude-executable.ts). */
  const cliPath = (service: CliServiceId) => {
    const override = service === "claude" ? claudeOverride() : null
    return override !== null ? Effect.succeed(override) : resolvePath(CLI_BINARIES[service])
  }

  const request = (service: AuthServiceId, operation: ProviderAuthError["operation"], url: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: (signal) => fetchFn(url, { ...init, signal }),
      catch: (cause) => new ProviderAuthError({ operation, service, message: errorMessage(cause), cause }),
    })

  const readJson = (service: AuthServiceId, operation: ProviderAuthError["operation"], response: Response) =>
    Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new ProviderAuthError({ operation, service, message: errorMessage(cause), cause }),
    })

  // -------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------

  const probeCliService = Effect.fn("ProviderAuth.probeCliService")(function* (service: CliServiceId) {
    const override = service === "claude" ? claudeOverride() : null
    const binaryPath = yield* cliPath(service)
    if (!binaryPath) {
      return {
        installed: false,
        version: null,
        authStatus: "not_installed",
        account: null,
        statusDetail: null,
      } satisfies Partial<AuthServiceSnapshot>
    }

    const versionResult = yield* exec([binaryPath, "--version"], { timeoutMs: 15_000 })
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
    const version = Match.value(service).pipe(
      Match.when("claude", () => parseClaudeVersion(versionOutput)),
      Match.when("codex", () => parseCodexVersion(versionOutput)),
      Match.when("cursor", () => parseCursorVersion(versionResult.stdout)),
      Match.when("grok", () => parseGrokVersion(versionOutput)),
      Match.when("gh", () => parseGhVersion(versionOutput)),
      Match.exhaustive,
    )

    type Status = Pick<AuthServiceSnapshot, "authStatus" | "account" | "statusDetail">
    const status: Status = yield* Match.value(service).pipe(
      Match.when("claude", () => Effect.gen(function* () {
        const result = yield* exec([binaryPath, "auth", "status", "--json"], { timeoutMs: 20_000 })
        const parsed = parseClaudeAuthStatus(result.stdout)
        let next: Status
        if (parsed) {
          next = { authStatus: parsed.loggedIn ? "signed_in" : "signed_out", account: parsed.account, statusDetail: null }
        } else if (result.code !== 0 && isUnknownCliSyntax(`${result.stderr}\n${result.stdout}`)) {
          // The CLI predates `auth status --json` (e.g. v1.0.x rejects the
          // flag): its auth state is unreadable, so mark it outdated instead
          // of echoing the raw CLI error — the card requires an update.
          next = {
            authStatus: "outdated",
            account: null,
            statusDetail: `Claude Code ${version ?? "(unknown version)"} is too old for Kanna — update it to continue.`,
          }
        } else {
          next = {
            authStatus: result.code === 0 ? "signed_out" : "error",
            account: null,
            statusDetail: result.code === 0 ? null : truncateOutput(result.stderr || result.stdout),
          }
        }
        // Turns refuse a CLI older than the SDK's pairing, so the card says so
        // first and offers the update. A wrapper (the override) is trusted.
        const minimum = options.claudeMinimumVersion ?? claudeCodeMinimumVersion()
        if (!override && version && next.authStatus !== "outdated" && !isClaudeVersionSupported(version, minimum)) {
          next = { ...next, authStatus: "outdated", statusDetail: outdatedClaudeMessage(version, minimum) }
        }
        return next
      })),
      Match.when("codex", () => Effect.gen(function* () {
        const result = yield* exec([binaryPath, "login", "status"], { timeoutMs: 20_000 })
        if (result.code === 0) {
          const match = /logged in (?:using|with|as)\s+(.+)/i.exec(stripAnsi(`${result.stdout}\n${result.stderr}`))
          return { authStatus: "signed_in", account: match?.[1]?.trim() ?? null, statusDetail: null } satisfies Status
        }
        if (isUnknownCliSyntax(`${result.stderr}\n${result.stdout}`)) {
          return {
            authStatus: "outdated",
            account: null,
            statusDetail: `Codex ${version ?? "(unknown version)"} is too old for Kanna — update it to continue.`,
          } satisfies Status
        }
        return { authStatus: "signed_out", account: null, statusDetail: null } satisfies Status
      })),
      Match.when("cursor", () => exec([binaryPath, "status"], { timeoutMs: 20_000 }).pipe(
        Effect.map((result): Status => {
          const parsed = parseCursorStatus(`${result.stdout}\n${result.stderr}`)
          return {
            authStatus: parsed.loggedIn && result.code === 0 ? "signed_in" : "signed_out",
            account: parsed.loggedIn ? parsed.account : null,
            statusDetail: null,
          }
        }),
      )),
      Match.when("grok", () => exec([binaryPath, "models"], { timeoutMs: 20_000 }).pipe(
        Effect.map((result): Status => {
          const parsed = parseGrokAuthStatus(`${result.stdout}\n${result.stderr}`)
          return {
            authStatus: parsed.loggedIn && result.code === 0 ? "signed_in" : "signed_out",
            account: parsed.loggedIn ? parsed.account : null,
            statusDetail: null,
          }
        }),
      )),
      Match.when("gh", () => exec([binaryPath, "auth", "status"], { timeoutMs: 20_000 }).pipe(
        Effect.map((result): Status => result.code === 0
          ? { authStatus: "signed_in", account: parseGhAccount(`${result.stdout}\n${result.stderr}`), statusDetail: null }
          : { authStatus: "signed_out", account: null, statusDetail: null }),
      )),
      Match.exhaustive,
    )

    return { installed: true, version, ...status } satisfies Partial<AuthServiceSnapshot>
  })

  const probeOpenRouter = readLlmProvider.pipe(
    Effect.map((provider): Partial<AuthServiceSnapshot> => {
      const signedIn = provider.provider === "openrouter" && provider.apiKey.length > 0
      return {
        installed: true,
        authStatus: signedIn ? "signed_in" : "signed_out",
        account: null,
        statusDetail: null,
      }
    }),
  )

  const probeService = Effect.fn("ProviderAuth.probeService")(function* (service: AuthServiceId) {
    yield* Effect.annotateCurrentSpan("service", service)
    // A probe takes seconds, and a page-open refresh can start one just
    // before an update swaps the binary. If it finished after the install's
    // own probe, it would write the old version back over the new one.
    const seq = (probeSeq.get(service) ?? 0) + 1
    probeSeq.set(service, seq)
    const probeFailed = (error: CommandSpawnError | LlmProviderFileError) =>
      Effect.succeed<Partial<AuthServiceSnapshot>>({ authStatus: "error", statusDetail: errorMessage(error) })
    const probe: Effect.Effect<Partial<AuthServiceSnapshot>, CommandSpawnError | LlmProviderFileError> =
      service === "openrouter" ? probeOpenRouter : probeCliService(service)
    const patch = yield* probe.pipe(
      Effect.catchTags({
        "@kanna/server/process-utils/CommandSpawnError": probeFailed,
        "@kanna/server/llm-provider/LlmProviderFileError": probeFailed,
      }),
    )
    if (probeSeq.get(service) !== seq) return
    yield* patchService(service, { ...patch, checkedAt: yield* Clock.currentTimeMillis })
  })

  // -------------------------------------------------------------------------
  // Latest versions
  // -------------------------------------------------------------------------

  // Every feed is best-effort: unavailable, rate-limited or offline keeps
  // whatever we had.
  const checkLatestVersions = Effect.fn("ProviderAuth.checkLatestVersions")(function* () {
    const now = yield* Clock.currentTimeMillis
    if (lastVersionCheckAt !== null && now - lastVersionCheckAt < VERSION_TTL_MS) return
    lastVersionCheckAt = now

    const fetchLatestNpmVersion = options.fetchLatestNpmVersion
    if (fetchLatestNpmVersion) {
      for (const service of ["claude", "codex"] as const) {
        const latest = yield* fetchLatestNpmVersion(NPM_PACKAGES[service]!).pipe(Effect.option)
        if (Option.isSome(latest)) yield* patchService(service, { latestVersion: latest.value })
      }
    }

    const ghRelease = yield* request("gh", "install", "https://api.github.com/repos/cli/cli/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    }).pipe(
      Effect.flatMap((response) => response.ok ? readJson("gh", "install", response).pipe(Effect.map(Option.some)) : Effect.succeedNone),
      Effect.option,
      Effect.map(Option.flatten),
      Effect.map(Option.flatMap(Schema.decodeUnknownOption(GhRelease))),
    )
    if (Option.isSome(ghRelease)) {
      const tag = ghRelease.value.tag_name
      if (typeof tag === "string" && tag.trim()) {
        yield* patchService("gh", { latestVersion: tag.replace(/^v/i, "") })
      }
    }

    // cursor uses calendar versioning with no public feed: never offer an update chip.
    const grokPath = yield* resolvePath(CLI_BINARIES.grok)
    if (grokPath) {
      const result = yield* exec([grokPath, "update", "--check", "--json"], { timeoutMs: 20_000 }).pipe(Effect.option)
      if (Option.isSome(result) && result.value.code === 0 && result.value.stdout.trim()) {
        const parsed = Schema.decodeUnknownOption(GrokUpdateCheckJson)(result.value.stdout)
        if (Option.isSome(parsed)) {
          const latest = parsed.value.latestVersion
          if (typeof latest === "string" && latest.trim()) {
            yield* patchService("grok", { latestVersion: latest.trim() })
          }
        }
      }
    }
  })

  /** Fire-and-forget, in the layer's scope. */
  const checkLatestVersionsInBackground = checkLatestVersions().pipe(Effect.forkIn(layerScope), Effect.asVoid)

  const doRefresh = Effect.fn("ProviderAuth.doRefresh")(function* (force: boolean) {
    if (force) commandPaths.clear()
    yield* Effect.forEach(AUTH_SERVICE_ORDER, probeService, { concurrency: "unbounded", discard: true })
    yield* Ref.set(lastStatusRefreshAt, Option.some(yield* Clock.currentTimeMillis))
    yield* checkLatestVersionsInBackground
  })

  const refresh = Effect.fn("ProviderAuth.refresh")(function* (refreshOptions: { readonly force?: boolean } = {}) {
    const now = yield* Clock.currentTimeMillis
    const lastAt = yield* Ref.get(lastStatusRefreshAt)
    const fresh = Option.isSome(lastAt) && now - lastAt.value < STATUS_TTL_MS
    const done = yield* Deferred.make<void>()
    const action = yield* Ref.modify(refreshInFlight, (current): [RefreshAction, Option.Option<Deferred.Deferred<void>>] => {
      if (Option.isSome(current)) return [{ _tag: "join", done: current.value }, current]
      if (!refreshOptions.force && fresh) return [{ _tag: "skip" }, current]
      return [{ _tag: "start", done }, Option.some(done)]
    })
    yield* Match.value(action).pipe(
      Match.tagsExhaustive({
        skip: () => Effect.void,
        join: ({ done }) => Deferred.await(done),
        // The probes run in the layer's scope, not the caller's: a caller that
        // goes away does not cancel them for the others waiting.
        start: ({ done }) =>
          doRefresh(refreshOptions.force ?? false).pipe(
            Effect.ensuring(Ref.set(refreshInFlight, Option.none()).pipe(Effect.andThen(Deferred.succeed(done, undefined)))),
            Effect.forkIn(layerScope, { startImmediately: true }),
            Effect.andThen(Deferred.await(done)),
          ),
      }),
    )
  })

  // -------------------------------------------------------------------------
  // Install / update
  // -------------------------------------------------------------------------

  const installFailure = (service: AuthServiceId, message: string) =>
    new ProviderAuthError({ operation: "install", service, message })

  const installCommand = Effect.fn("ProviderAuth.installCommand")(function* (service: CliServiceId) {
    return yield* Match.value(service).pipe(
      Match.when("claude", () => Effect.gen(function* () {
        // Native-first: the official installer is per-user (~/.local/bin),
        // needs no root, and self-updates — `npm install -g` fails wherever the
        // global prefix is root-owned (e.g. cloud dev-boxes). For existing
        // installs try the binary's own self-update, falling back to the
        // native installer (which also migrates npm-managed installs).
        const existing = yield* cliPath("claude")
        const nativeInstall = "curl -fsSL https://claude.ai/install.sh | bash"
        if (existing) return `${shellQuote(existing)} update || (${nativeInstall})`
        return nativeInstall
      })),
      Match.when("codex", () => Effect.gen(function* () {
        // Update the codex the card runs, not whichever npm a login bash finds.
        // The install runs in `bash -l`, which doesn't read ~/.zshrc, so there a
        // bare `npm` was Homebrew's while the card ran nvm's codex: updates
        // landed in the other install and the version never moved. So use the
        // npm (or bun) beside that codex, with its folder first on PATH so that
        // npm runs on its own node and installs into its own prefix.
        const pkg = NPM_PACKAGES.codex!
        const existing = yield* cliPath("codex")
        const beside = (tool: string) => Effect.gen(function* () {
          if (!existing) return null
          const candidate = path.join(path.dirname(existing), tool)
          return (yield* isExecutable(candidate)) ? candidate : null
        })
        const besideBun = yield* beside("bun")
        const npm = (yield* beside("npm")) ?? (besideBun ? null : yield* resolvePath("npm"))
        const bun = besideBun ?? (yield* resolvePath("bun"))
        const run = (tool: string) => `PATH=${shellQuote(path.dirname(tool))}:"$PATH" ${shellQuote(tool)}`
        if (npm) return `${run(npm)} install -g ${pkg}`
        if (bun) return `${run(bun)} add -g ${pkg}`
        return yield* installFailure(service, "Neither npm nor bun is available to install the package.")
      })),
      Match.when("cursor", () => resolvePath(CLI_BINARIES.cursor).pipe(
        Effect.map((existing) => existing ? `${shellQuote(existing)} update` : "curl https://cursor.com/install -fsS | bash"),
      )),
      Match.when("grok", () => resolvePath(CLI_BINARIES.grok).pipe(
        Effect.map((existing) => existing ? `${shellQuote(existing)} update` : "curl -fsSL https://x.ai/cli/install.sh | bash"),
      )),
      Match.when("gh", () => Effect.gen(function* () {
        if (platform === "darwin") {
          // brew refreshes its formula index at most daily on its own, so without
          // this an update inside that window is a silent no-op that exits 0.
          // A failed index refresh (offline) still lets the install run.
          if (yield* resolvePath("brew")) return "brew update --quiet; brew install gh || brew upgrade gh"
          // No Homebrew: fall through to the release download below. The macOS
          // build is signed and notarized, and ~/.local/bin is on the lookup path
          // (process-utils USER_BIN_DIRS) even when the user's PATH lacks it.
        }
        return ghReleaseInstallScript(platform)
      })),
      Match.exhaustive,
    )
  })

  const runInstall = Effect.fn("ProviderAuth.runInstall")(function* (service: CliServiceId) {
    const command = yield* installCommand(service)
    // Prefer bash: on Debian/Ubuntu `sh` is dash, which chokes on bash-isms
    // in the user's profile files ("source: not found") and buries the real
    // installer error in noise.
    const shell = (yield* resolvePath("bash")) ? "bash" : "sh"
    const result = yield* exec([shell, "-lc", command], { timeoutMs: 10 * 60_000 })
    if (result.code !== 0) {
      return yield* installFailure(
        service,
        truncateOutput(result.stderr || result.stdout) || `Installer exited with code ${result.code}`,
      )
    }
    // Re-resolve the binary (fresh — the install may have added it to PATH).
    commandPaths.delete(CLI_BINARIES[service])
    lastVersionCheckAt = null
    yield* track("auth_cli_install_succeeded", service)
    // Stay "installing" until the probe has read the new version. The probe
    // takes seconds, and going idle first showed the old version's Update
    // button in between, which looked like the update had failed.
    yield* probeService(service)
    // An installer can exit 0 without moving the version on PATH: Homebrew
    // with a stale index, or npm installing beside a brew/bun copy that
    // still wins. Say so, or the card silently shows Update again.
    const probed = yield* serviceSnapshot(service)
    const stale = probed.updateAvailable
      ? `The update finished, but ${probed.label} still reports ${probed.version} (latest is ${probed.latestVersion}).`
      : null
    yield* patchService(service, { installState: stale ? "error" : "idle", installError: stale })
    yield* checkLatestVersionsInBackground
  })

  const install = Effect.fn("ProviderAuth.install")(function* (service: AuthServiceId) {
    yield* Effect.annotateCurrentSpan("service", service)
    if (service === "openrouter") return yield* installFailure(service, "OpenRouter has no CLI to install.")
    const current = yield* serviceSnapshot(service)
    if (current.installState === "installing") return

    yield* patchService(service, { installState: "installing", installError: null })
    yield* track("auth_cli_install_started", service)

    const installFailed = (error: ProviderAuthError | CommandSpawnError) =>
      patchService(service, { installState: "error", installError: error.message }).pipe(
        Effect.andThen(track("auth_cli_install_failed", service)),
      )
    yield* runInstall(service).pipe(
      Effect.catchTags({
        "@kanna/server/provider-auth/ProviderAuthError": installFailed,
        "@kanna/server/process-utils/CommandSpawnError": installFailed,
      }),
    )
  })

  // -------------------------------------------------------------------------
  // Login flows
  // -------------------------------------------------------------------------

  const loginError = (service: AuthServiceId, message: string, cause?: unknown) =>
    new ProviderAuthError({ operation: "login", service, message, cause })

  /** End the flow early from one of its timers; the first ending wins. */
  const endFlow = (flow: LoginFlow, end: FlowEnd) => Deferred.succeed(flow.ended, end).pipe(Effect.asVoid)

  /** Is `flow` still the one the card shows? */
  const isCurrent = (flow: LoginFlow) => flows.get(flow.service) === flow

  /**
   * Feed the CLI's output tail to `onOutput` as it arrives, from a fiber in
   * the flow's scope.
   */
  const readOutput = (flow: LoginFlow, child: LoginChild, onOutput: (transcript: string) => Effect.Effect<void>) =>
    child.output.pipe(
      Stream.runForEach((chunk) => {
        flow.transcript = (flow.transcript + chunk).slice(-TRANSCRIPT_LIMIT)
        return onOutput(flow.transcript)
      }),
      Effect.forkIn(flow.scope),
    )

  /** The CLI's exit code, once the output it printed before exiting has been read. */
  const awaitExit = (child: LoginChild, reading: Fiber.Fiber<void>) =>
    child.exited.pipe(
      Effect.tap(() => Fiber.join(reading).pipe(Effect.timeoutOption(OUTPUT_DRAIN_MS))),
    )

  /** Device-code CLIs (codex, grok, cursor): show the URL/code they print, then wait for them to exit. */
  const showDeviceLogin = (
    service: CliServiceId,
    flow: LoginFlow,
    child: LoginChild,
    parse: (text: string) => DeviceLoginParsed | null,
    expiresInMs: number | null,
  ) =>
    readOutput(flow, child, (transcript) => Effect.gen(function* () {
      const current = yield* serviceSnapshot(service)
      if (current.login.phase !== "starting") return
      const parsed = parse(stripAnsi(transcript))
      if (!parsed) return
      const startedAt = yield* Clock.currentTimeMillis
      yield* setLogin(service, {
        phase: "waiting_for_approval",
        verificationUrl: parsed.verificationUrl,
        userCode: parsed.userCode,
        startedAt,
        expiresAt: expiresInMs === null ? null : startedAt + expiresInMs,
      })
    }))

  /**
   * Give git a global commit identity when the machine has none.
   *
   * `gh auth setup-git` (run just before) installs the credential helper, which
   * is enough to *push* but not to *commit*: with no `user.name`/`user.email`,
   * git refuses with "Author identity unknown" after guessing a bogus
   * `user@host.(none)` address. Fresh boxes, devboxes and containers routinely
   * ship without a `~/.gitconfig` identity, so onboarding would complete and
   * then the first commit, merge or rebase Kanna attempts would fail.
   *
   * Only missing values are filled in — an identity the user already set is
   * never overwritten — and every failure is swallowed by the caller, because
   * sign-in itself has already succeeded and must not be reported as broken.
   */
  const ensureGitIdentity = Effect.fn("ProviderAuth.ensureGitIdentity")(function* () {
    const gitPath = yield* resolvePath("git")
    const ghPath = yield* resolvePath(CLI_BINARIES.gh)
    if (!gitPath || !ghPath) return

    // `--get` exits 1 when the key is unset, which is the signal we want.
    const readConfig = (key: string) =>
      exec([gitPath, "config", "--global", "--get", key], { timeoutMs: 10_000 }).pipe(
        Effect.map((result) => result.code === 0 ? result.stdout.trim() : ""),
      )
    const [existingName, existingEmail] = yield* Effect.all(
      [readConfig("user.name"), readConfig("user.email")],
      { concurrency: "unbounded" },
    )
    if (existingName && existingEmail) return

    const userResult = yield* exec([ghPath, "api", "user"], { timeoutMs: 20_000 })
    if (userResult.code !== 0) return
    const identity = parseGhUserIdentity(userResult.stdout)
    if (!identity) return

    if (!existingName) {
      yield* exec([gitPath, "config", "--global", "user.name", identity.name], { timeoutMs: 10_000 })
    }
    if (!existingEmail) {
      yield* exec([gitPath, "config", "--global", "user.email", identity.email], { timeoutMs: 10_000 })
    }
  })

  const runGhLogin = Effect.fn("ProviderAuth.runGhLogin")(function* (_flow: LoginFlow) {
    const ghPath = yield* resolvePath(CLI_BINARIES.gh)
    if (!ghPath) return yield* loginError("gh", "GitHub CLI is not installed.")

    const deviceResponse = yield* request("gh", "login", "https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `client_id=${GH_CLIENT_ID}&scope=${encodeURIComponent(GH_SCOPES)}`,
    })
    if (!deviceResponse.ok) {
      return yield* loginError("gh", `GitHub device authorization failed (${deviceResponse.status}).`)
    }
    const device = Schema.decodeUnknownOption(GhDeviceCode)(yield* readJson("gh", "login", deviceResponse))
    const deviceCode = Option.getOrUndefined(device)?.device_code
    const userCode = Option.getOrUndefined(device)?.user_code
    if (Option.isNone(device) || !deviceCode || !userCode) {
      return yield* loginError("gh", "GitHub did not return a device code.")
    }

    const startedAt = yield* Clock.currentTimeMillis
    const expiresAt = startedAt + (device.value.expires_in ?? 900) * 1000
    let intervalSeconds = Math.max(5, device.value.interval ?? 5)
    yield* setLogin("gh", {
      phase: "waiting_for_approval",
      verificationUrl: device.value.verification_uri ?? "https://github.com/login/device",
      userCode,
      startedAt,
      expiresAt,
    })

    while (true) {
      yield* Effect.sleep(intervalSeconds * 1000)
      if ((yield* Clock.currentTimeMillis) > expiresAt) {
        return failedEnd("The sign-in code expired. Try again.")
      }

      // A transient network failure keeps polling.
      const polled = yield* request("gh", "login", "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body:
          `client_id=${GH_CLIENT_ID}` +
          `&device_code=${encodeURIComponent(deviceCode)}` +
          `&grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:device_code")}`,
      }).pipe(
        Effect.flatMap((response) => readJson("gh", "login", response)),
        Effect.option,
      )
      if (Option.isNone(polled)) continue
      const payload = Option.getOrElse(Schema.decodeUnknownOption(GhTokenPoll)(polled.value), () => ({} as typeof GhTokenPoll.Type))

      if (payload.access_token) {
        yield* setLogin("gh", { phase: "finishing" })
        const login = yield* exec([ghPath, "auth", "login", "--with-token"], {
          stdin: payload.access_token,
          timeoutMs: 60_000,
        })
        if (login.code !== 0) {
          return failedEnd(`gh auth login failed: ${truncateOutput(login.stderr || login.stdout)}`)
        }
        yield* exec([ghPath, "auth", "setup-git"], { timeoutMs: 30_000 }).pipe(Effect.ignore)
        yield* ensureGitIdentity().pipe(Effect.ignore)
        return exitedEnd
      }
      if (payload.error === "authorization_pending") continue
      if (payload.error === "slow_down") {
        intervalSeconds += 5
        continue
      }
      return failedEnd(payload.error_description ?? payload.error ?? "GitHub rejected the sign-in.")
    }
  })

  const runCodexLogin = Effect.fn("ProviderAuth.runCodexLogin")(function* (flow: LoginFlow) {
    const codexPath = yield* resolvePath(CLI_BINARIES.codex)
    if (!codexPath) return yield* loginError("codex", "Codex CLI is not installed.")

    const child = yield* spawnStreaming([codexPath, "login", "--device-auth"])
    flow.child = child
    const reading = yield* showDeviceLogin("codex", flow, child, parseCodexDeviceLogin, 15 * 60_000)

    const exitCode = yield* awaitExit(child, reading)
    if (exitCode === 0) return exitedEnd
    // A config parse failure means Codex can't run at all — device-auth
    // settings are not the problem, the named config.toml line is.
    const transcriptText = stripAnsi(flow.transcript)
    const configLoadFailed = /(?:error loading|failed to load) configuration/i.test(transcriptText)
    return failedEnd(
      `Codex sign-in failed: ${truncateOutput(transcriptText) || `exit code ${exitCode}`}`,
      configLoadFailed
        ? "Codex could not read ~/.codex/config.toml — fix or remove the line it names (or update Codex), then try again."
        : CODEX_DEVICE_AUTH_HINT,
    )
  })

  const runGrokLogin = Effect.fn("ProviderAuth.runGrokLogin")(function* (flow: LoginFlow) {
    const grokPath = yield* resolvePath(CLI_BINARIES.grok)
    if (!grokPath) return yield* loginError("grok", "Grok Build CLI is not installed.")

    const child = yield* spawnStreaming([grokPath, "login", "--device-auth"])
    flow.child = child
    const reading = yield* showDeviceLogin("grok", flow, child, parseGrokDeviceLogin, 15 * 60_000)

    const exitCode = yield* awaitExit(child, reading)
    if (exitCode === 0) return exitedEnd
    return failedEnd(
      `Grok sign-in failed: ${truncateOutput(stripAnsi(flow.transcript)) || `exit code ${exitCode}`}`,
      "Device-code login prints a URL (and sometimes a code). Open it, approve, and wait for this card to finish.",
    )
  })

  const runCursorLogin = Effect.fn("ProviderAuth.runCursorLogin")(function* (flow: LoginFlow) {
    const cursorPath = yield* resolvePath(CLI_BINARIES.cursor)
    if (!cursorPath) return yield* loginError("cursor", "Cursor CLI is not installed.")

    const child = yield* spawnStreaming([cursorPath, "login"], { env: { NO_OPEN_BROWSER: "1" } })
    flow.child = child
    const reading = yield* showDeviceLogin("cursor", flow, child, parseCursorLogin, null)

    const exitCode = yield* awaitExit(child, reading)
    if (exitCode === 0) return exitedEnd
    return failedEnd(`Cursor sign-in failed: ${truncateOutput(stripAnsi(flow.transcript)) || `exit code ${exitCode}`}`)
  })

  const runClaudeLogin = Effect.fn("ProviderAuth.runClaudeLogin")(function* (flow: LoginFlow) {
    const claudePath = yield* resolvePath(CLI_BINARIES.claude)
    if (!claudePath) return yield* loginError("claude", "Claude Code is not installed.")

    const child = yield* spawnPty([claudePath, "auth", "login"])
    flow.child = child
    const reading = yield* readOutput(flow, child, (transcript) => Effect.gen(function* () {
      const current = yield* serviceSnapshot("claude")
      if (current.login.phase !== "starting") return
      const url = parseClaudeOauthUrl(transcript)
      if (url) {
        yield* setLogin("claude", {
          phase: "waiting_for_code_entry",
          verificationUrl: url,
          startedAt: yield* Clock.currentTimeMillis,
        })
      }
    }))

    const stillStarting = serviceSnapshot("claude").pipe(Effect.map((current) => current.login.phase === "starting"))

    // The Ink app may show a login-method menu before printing the URL —
    // press Enter once to accept the default if nothing appeared yet.
    yield* Effect.gen(function* () {
      if ((yield* stillStarting) && child.write) yield* child.write("\r")
    }).pipe(Effect.delay(CLAUDE_MENU_FALLBACK_MS), Effect.forkIn(flow.scope))

    // If no URL surfaced at all, fail with the transcript tail for debugging.
    yield* Effect.gen(function* () {
      if (!(yield* stillStarting)) return
      yield* endFlow(flow, failedEnd(
        `Claude sign-in did not produce a login link: ${truncateOutput(stripAnsi(flow.transcript))}`,
        "On macOS the Keychain may need approval the first time — try running `claude auth login` in a terminal once.",
      ))
    }).pipe(Effect.delay(CLAUDE_URL_TIMEOUT_MS), Effect.forkIn(flow.scope))

    const exitCode = yield* awaitExit(child, reading)
    const phase = (yield* serviceSnapshot("claude")).login.phase
    if (flow.codeSubmitted || (exitCode === 0 && phase !== "error")) return exitedEnd
    if (phase !== "error") {
      return failedEnd(`Claude sign-in ended unexpectedly: ${truncateOutput(stripAnsi(flow.transcript)) || `exit code ${exitCode}`}`)
    }
    return { _tag: "Ended" } satisfies FlowEnd as FlowEnd
  })

  /** Re-probe after a flow reports success; only a verified signed-in state counts. */
  const finishLogin = Effect.fn("ProviderAuth.finishLogin")(function* (service: AuthServiceId) {
    yield* setLogin(service, { phase: "finishing" })
    yield* probeService(service)
    const snapshot = yield* serviceSnapshot(service)
    if (snapshot.authStatus === "signed_in") {
      yield* setLogin(service, { phase: "idle" })
      yield* track("auth_login_succeeded", service)
      yield* onSignedIn(service)
    } else {
      yield* setLogin(service, {
        phase: "error",
        message: "Sign-in finished but the CLI still reports signed out.",
        hint: null,
      })
      yield* track("auth_login_failed", service)
    }
  })

  /**
   * The whole flow, from spawning the CLI to the card's final state. Forked
   * in the layer's scope; cancelling or superseding it interrupts it, and
   * closing the flow's scope kills the CLI.
   */
  const runFlow = (flow: LoginFlow) => Effect.gen(function* () {
    const { service } = flow
    const runner = Match.value(service).pipe(
      Match.when("gh", () => runGhLogin(flow)),
      Match.when("codex", () => runCodexLogin(flow)),
      Match.when("cursor", () => runCursorLogin(flow)),
      Match.when("grok", () => runGrokLogin(flow)),
      Match.when("claude", () => runClaudeLogin(flow)),
      Match.exhaustive,
    )
    const failed = (error: ProviderAuthError | CommandSpawnError) => Effect.succeed(failedEnd(error.message))
    // The CLI's side runs in the flow's scope, started now so the CLI is
    // running by the time `startLogin` returns. It ends the flow like the
    // timers do: whichever finishes first decides how.
    yield* runner.pipe(
      Scope.provide(flow.scope),
      Effect.catchTags({
        "@kanna/server/provider-auth/ProviderAuthError": failed,
        "@kanna/server/process-utils/CommandSpawnError": failed,
      }),
      // A bug in a flow still ends it with a message rather than leaving
      // the card spinning, as before.
      Effect.catchDefect((defect) => Effect.succeed(failedEnd(errorMessage(defect)))),
      Effect.flatMap((end) => endFlow(flow, end)),
      Effect.forkIn(flow.scope, { startImmediately: true }),
    )
    const end = yield* Deferred.await(flow.ended)

    // The flow is over: forget it, stop its timers and kill what's left of the CLI.
    if (isCurrent(flow)) flows.delete(service)
    yield* Scope.close(flow.scope, Exit.void)

    yield* Match.value(end).pipe(
      Match.tagsExhaustive({
        Exited: () => finishLogin(service),
        SignedIn: () => setLogin(service, { phase: "idle" }).pipe(
          Effect.andThen(track("auth_login_succeeded", service)),
          Effect.andThen(onSignedIn(service)),
        ),
        Failed: ({ message, hint }) => setLogin(service, { phase: "error", message, hint }).pipe(
          Effect.andThen(track("auth_login_failed", service)),
        ),
        Ended: () => Effect.void,
      }),
    )
  }).pipe(Effect.withSpan("ProviderAuth.runFlow", { attributes: { service: flow.service } }))

  /** Stop a flow: interrupt it and kill its CLI. */
  const teardownFlow = Effect.fn("ProviderAuth.teardownFlow")(function* (service: AuthServiceId) {
    const flow = flows.get(service)
    if (!flow) return
    flows.delete(service)
    if (flow.fiber) yield* Fiber.interrupt(flow.fiber)
    yield* Scope.close(flow.scope, Exit.void)
  })

  const startLogin = Effect.fn("ProviderAuth.startLogin")(function* (service: AuthServiceId) {
    yield* Effect.annotateCurrentSpan("service", service)
    if (service === "openrouter") {
      return yield* loginError(service, "Use the OpenRouter OAuth flow (auth.openrouter.start).")
    }
    yield* teardownFlow(service)

    const current = yield* serviceSnapshot(service)
    if (!current.installed || current.authStatus === "not_installed") {
      return yield* loginError(service, `${current.label} is not installed.`)
    }
    if (current.authStatus === "outdated") {
      return yield* loginError(service, `${current.label} is too old for Kanna — update it first.`)
    }

    const flow: LoginFlow = {
      service,
      scope: yield* Scope.fork(layerScope),
      ended: yield* Deferred.make<FlowEnd>(),
      fiber: null,
      child: null,
      codeSubmitted: false,
      transcript: "",
    }
    flows.set(service, flow)
    yield* setLogin(service, { phase: "starting" })
    yield* track("auth_login_started", service)

    // Overall watchdog: never leave a flow hanging forever.
    yield* endFlow(flow, failedEnd("Sign-in timed out.")).pipe(
      Effect.delay(LOGIN_WATCHDOG_MS),
      Effect.forkIn(flow.scope),
    )
    // Started now, so the CLI is running by the time this returns.
    flow.fiber = yield* runFlow(flow).pipe(Effect.forkIn(layerScope, { startImmediately: true }))
  })

  const submitLoginCode = Effect.fn("ProviderAuth.submitLoginCode")(function* (service: AuthServiceId, code: string) {
    yield* Effect.annotateCurrentSpan("service", service)
    const flow = flows.get(service)
    const snapshot = yield* serviceSnapshot(service)
    if (!flow || snapshot.login.phase !== "waiting_for_code_entry") {
      return yield* loginError(service, "No sign-in flow is waiting for a code.")
    }
    const cleaned = code.trim()
    if (!cleaned) return yield* loginError(service, "Enter the code from the sign-in page.")
    const write = flow.child?.write
    if (!write) return yield* loginError(service, "Sign-in process is not accepting input.")
    flow.codeSubmitted = true
    yield* setLogin(service, { phase: "finishing" })
    yield* write(`${cleaned}\r`)
    // Safety net: if the Ink app lingers after a successful login instead of
    // exiting, probe once — a verified signed-in state completes the flow.
    yield* Effect.gen(function* () {
      yield* probeService(service)
      if ((yield* serviceSnapshot(service)).authStatus === "signed_in") {
        yield* endFlow(flow, { _tag: "SignedIn" })
      }
    }).pipe(Effect.delay(CLAUDE_CODE_SAFETY_NET_MS), Effect.forkIn(flow.scope))
  })

  const cancelLogin = Effect.fn("ProviderAuth.cancelLogin")(function* (service: AuthServiceId) {
    yield* Effect.annotateCurrentSpan("service", service)
    // With no flow this still clears a stale error state.
    yield* teardownFlow(service)
    yield* setLogin(service, { phase: "idle" })
  })

  // -------------------------------------------------------------------------
  // OpenRouter PKCE (server-mediated: works on plain-HTTP LAN hosts too)
  // -------------------------------------------------------------------------

  const openRouterError = (message: string, cause?: unknown) =>
    new ProviderAuthError({ operation: "openrouter", service: "openrouter", message, cause })

  const startOpenRouterAuth = Effect.fn("ProviderAuth.startOpenRouterAuth")(function* (callbackUrl: string) {
    const parsed = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: (cause) => openRouterError(errorMessage(cause), cause),
    })
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return yield* openRouterError("Invalid callback URL.")
    }
    const verifier = randomBytes(32).toString("base64url")
    openRouterVerifier = verifier
    const challenge = pkceChallengeS256(verifier)
    const authUrl =
      `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`
    return { authUrl }
  })

  const exchangeOpenRouterCode = Effect.fn("ProviderAuth.exchangeOpenRouterCode")(function* (code: string) {
    const verifier = openRouterVerifier
    if (!verifier) {
      return yield* openRouterError("No OpenRouter sign-in in progress. Start the flow again.")
    }
    const response = yield* request("openrouter", "openrouter", "https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    })
    if (!response.ok) {
      return yield* openRouterError(`OpenRouter key exchange failed (${response.status}).`)
    }
    const payload = Schema.decodeUnknownOption(OpenRouterKey)(yield* readJson("openrouter", "openrouter", response))
    const key = Option.getOrUndefined(payload)?.key
    if (typeof key !== "string" || !key.trim()) {
      return yield* openRouterError("OpenRouter did not return an API key.")
    }
    openRouterVerifier = null

    const current = yield* readLlmProvider
    const snapshot = yield* writeLlmProvider({
      provider: "openrouter",
      apiKey: key,
      model: current.provider === "openrouter" && current.model ? current.model : DEFAULT_OPENROUTER_SDK_MODEL,
      baseUrl: "",
      faveModels: current.faveModels,
    })
    yield* probeService("openrouter")
    yield* track("auth_login_succeeded", "openrouter")
    yield* onSignedIn("openrouter")
    return snapshot
  })

  return ProviderAuth.of({
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    refresh,
    probeService,
    install,
    startLogin,
    submitLoginCode,
    cancelLogin,
    startOpenRouterAuth,
    exchangeOpenRouterCode,
  })
})

function ghReleaseInstallScript(platform: NodeJS.Platform) {
  // Download to a file (not `curl | tar`): in a pipeline a mid-transfer
  // curl failure just truncates tar's stdin — `set -e` never sees curl's
  // exit code and the surfaced error is a baffling "gzip: unexpected end
  // of file". Retries paper over transient CDN 5xx/timeouts.
  const [os, archive, extract] = platform === "darwin"
    ? ["macOS", "zip", `unzip -q "$tmp/gh.zip" -d "$tmp"`]
    : ["linux", "tar.gz", `tar -xzf "$tmp/gh.tar.gz" -C "$tmp"`]
  return [
    "set -e",
    `ver=$(curl -fsSL --retry 3 --retry-all-errors https://api.github.com/repos/cli/cli/releases/latest | grep -o '"tag_name": *"v[^"]*"' | head -1 | grep -o 'v[0-9][0-9.]*')`,
    `test -n "$ver"`,
    `arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac`,
    `tmp=$(mktemp -d)`,
    `trap 'rm -rf "$tmp"' EXIT`,
    `curl -fsSL --retry 3 --retry-all-errors -o "$tmp/gh.${archive}" "https://github.com/cli/cli/releases/download/$ver/gh_$(echo $ver | tr -d v)_${os}_$arch.${archive}"`,
    extract,
    "mkdir -p \"$HOME/.local/bin\"",
    `cp "$tmp/gh_$(echo $ver | tr -d v)_${os}_$arch/bin/gh" "$HOME/.local/bin/gh"`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Real processes (server runtime)
// ---------------------------------------------------------------------------

/** The platform's spawn or read failure, re-messaged with the cause's own text as this module always showed it. */
const remessage = (command: string) => (error: CommandSpawnError) =>
  Effect.fail(new CommandSpawnError({ command, message: errorMessage(error.cause), cause: error.cause }))

/** Run `argv` to completion, killed if it outlives `timeoutMs` or the caller is interrupted. */
export const execCommand = Effect.fn("ProviderAuth.exec")(function* (argv: ReadonlyArray<string>, options: ExecOptions = {}) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const machine = yield* Machine
  const spawner = yield* ProcessSpawner
  const proc = yield* spawner.spawn(argv, {
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...machine.env.snapshot(), ...options.env },
  }).pipe(Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", remessage(command)))
  if (options.timeoutMs) {
    yield* proc.kill().pipe(Effect.delay(options.timeoutMs), Effect.forkScoped)
  }
  const [stdout, stderr, exit] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(proc.stdout)),
    Stream.mkString(Stream.decodeText(proc.stderr)),
    proc.exited,
  ], { concurrency: "unbounded" }).pipe(Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", remessage(command)))
  return { code: exit.code, stdout, stderr } satisfies ExecResult
}, Effect.scoped)

/** One pipe of a login CLI as text; a pipe that errors as the process dies just ends. */
const pipeText = (stream: Stream.Stream<Uint8Array, CommandSpawnError>) =>
  stream.pipe(
    Stream.decodeText,
    Stream.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Stream.empty),
  )

/** A login CLI with piped stdout/stderr, killed when the scope closes. */
export const spawnStreamingCommand = Effect.fn("ProviderAuth.spawnStreaming")(function* (
  argv: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string> } = {},
) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const machine = yield* Machine
  const spawner = yield* ProcessSpawner
  const proc = yield* spawner.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...machine.env.snapshot(), ...options.env },
  }).pipe(Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", remessage(command)))
  return {
    output: Stream.merge(pipeText(proc.stdout), pipeText(proc.stderr)),
    exited: proc.exited.pipe(Effect.map((exit) => exit.code)),
  } satisfies LoginChild
})

/** A login CLI on a PTY (claude's Ink app needs one), killed when the scope closes. */
export const spawnPtyCommand = Effect.fn("ProviderAuth.spawnPty")(function* (argv: ReadonlyArray<string>) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const ptys = yield* PtySpawner
  if (!ptys.available) {
    return yield* new CommandSpawnError({
      command,
      message: "This sign-in flow requires Bun 1.3.5+ (PTY support).",
      cause: null,
    })
  }
  const machine = yield* Machine
  const output = yield* Queue.unbounded<string, Cause.Done>()
  const decoder = new TextDecoder()
  const proc = yield* ptys.spawn(argv, {
    cols: 200,
    rows: 50,
    name: "xterm-256color",
    env: { ...machine.env.snapshot(), TERM: "xterm-256color" },
    onData: (data) => {
      Queue.offerUnsafe(output, decoder.decode(data))
    },
  }).pipe(Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", remessage(command)))
  const exited = proc.exited.pipe(
    Effect.map((exit) => exit.code),
    Effect.orDie,
  )
  // The terminal closes with the process, and its output ends with it.
  yield* exited.pipe(
    Effect.andThen(proc.close),
    Effect.ensuring(Queue.end(output)),
    Effect.forkScoped,
  )
  return {
    output: Stream.fromQueue(output),
    exited,
    write: (data: string) =>
      proc.write(data).pipe(
        Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () =>
          Effect.logWarning("provider-auth: failed to write to login pty")),
      ),
  } satisfies LoginChild
})
