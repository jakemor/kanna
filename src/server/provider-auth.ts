import { createHash, randomBytes } from "node:crypto"
import { LOG_PREFIX } from "../shared/branding"
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
import { compareVersions } from "./cli-runtime"
import { parseOpenCodeAuthList, parseOpenCodeVersion } from "./opencode-acp"
import { resolveCommandPath as defaultResolveCommandPath } from "./process-utils"

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

/**
 * The GitHub CLI's public OAuth client id — we run the standard OAuth device
 * flow against it directly (deterministic, no PTY scraping), then hand the
 * resulting token to `gh auth login --with-token` so gh owns storage exactly
 * as if the user had run `gh auth login` themselves.
 */
const GH_CLIENT_ID = "178c6fc778ccc68e1d6a"
const GH_SCOPES = "repo read:org gist workflow"

const CLI_BINARIES: Record<Exclude<AuthServiceId, "openrouter">, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
  gh: "gh",
}

const NPM_PACKAGES: Partial<Record<AuthServiceId, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
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

export function parseClaudeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

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
  let parsed: { login?: unknown; name?: unknown; id?: unknown }
  try {
    parsed = JSON.parse(output) as typeof parsed
  } catch {
    return null
  }
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

/** `claude auth status --json` → { loggedIn, authMethod, ... } (exit 0 either way). */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatusParsed | null {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    const account =
      typeof parsed.email === "string" ? parsed.email
      : typeof parsed.account === "string" ? parsed.account
      : typeof (parsed.oauthAccount as Record<string, unknown> | undefined)?.emailAddress === "string"
        ? (parsed.oauthAccount as Record<string, string>).emailAddress
        : null
    return { loggedIn: parsed.loggedIn === true, account }
  } catch {
    return null
  }
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

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** A spawned child whose interleaved stdout/stderr is streamed as text. */
export interface StreamingChild {
  onOutput: (listener: (chunk: string) => void) => void
  exited: Promise<number>
  kill: () => void
  /** Present on PTY children (claude login needs code paste-back). */
  write?: (data: string) => void
}

export interface ProviderAuthManagerDeps {
  exec: (
    argv: string[],
    opts?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number }
  ) => Promise<ExecResult>
  spawnStreaming: (argv: string[], opts?: { env?: Record<string, string> }) => StreamingChild
  spawnPty: (argv: string[]) => StreamingChild
  readLlmProvider: () => Promise<LlmProviderSnapshot>
  writeLlmProvider: (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> &
      Partial<Pick<LlmProviderSnapshot, "faveModels">>
  ) => Promise<LlmProviderSnapshot>
  fetchFn?: typeof fetch
  fetchLatestNpmVersion?: (packageName: string) => Promise<string>
  resolveCommandPath?: (command: string) => string | null
  onSignedIn?: (service: AuthServiceId) => void
  trackEvent?: (eventName: string, properties?: Record<string, unknown>) => void
  sleep?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
  now?: () => number
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface LoginFlowRuntime {
  service: AuthServiceId
  child: StreamingChild | null
  cancelled: boolean
  codeSubmitted: boolean
  /** Raw output tail kept for a debuggable failure detail (never in snapshots). */
  transcript: string
  timers: ReturnType<typeof setTimeout>[]
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

export class ProviderAuthManager {
  private readonly deps: ProviderAuthManagerDeps
  private readonly services = new Map<AuthServiceId, AuthServiceSnapshot>()
  private readonly listeners = new Set<(snapshot: ProviderAuthSnapshot) => void>()
  private readonly flows = new Map<AuthServiceId, LoginFlowRuntime>()
  private readonly commandPaths = new Map<string, string | null>()
  private refreshInFlight: Promise<void> | null = null
  private lastStatusRefreshAt: number | null = null
  private lastVersionCheckAt: number | null = null
  private openRouterVerifier: string | null = null
  private disposed = false

  constructor(deps: ProviderAuthManagerDeps) {
    this.deps = deps
    for (const service of AUTH_SERVICE_ORDER) {
      this.services.set(service, initialServiceSnapshot(service))
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private sleep(ms: number) {
    return this.deps.sleep?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private fetchFn(): typeof fetch {
    return this.deps.fetchFn ?? fetch
  }

  getSnapshot(): ProviderAuthSnapshot {
    return {
      services: AUTH_SERVICE_ORDER.map((service) => this.services.get(service)!),
    }
  }

  onChange(listener: (snapshot: ProviderAuthSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose() {
    this.disposed = true
    for (const service of [...this.flows.keys()]) {
      this.teardownFlow(service)
    }
    this.listeners.clear()
  }

  private emit() {
    if (this.disposed) return
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private patchService(service: AuthServiceId, patch: Partial<AuthServiceSnapshot>) {
    const previous = this.services.get(service) ?? initialServiceSnapshot(service)
    const next: AuthServiceSnapshot = { ...previous, ...patch }
    next.updateAvailable = Boolean(
      next.installed &&
      next.version &&
      next.latestVersion &&
      compareVersions(next.version, next.latestVersion) < 0
    )
    this.services.set(service, next)
    this.emit()
  }

  private setLogin(service: AuthServiceId, login: AuthLoginFlowState) {
    this.patchService(service, { login })
  }

  private resolvePath(command: string, options?: { fresh?: boolean }): string | null {
    if (!options?.fresh && this.commandPaths.has(command)) {
      return this.commandPaths.get(command) ?? null
    }
    const resolver = this.deps.resolveCommandPath ?? defaultResolveCommandPath
    const resolved = resolver(command)
    this.commandPaths.set(command, resolved)
    return resolved
  }

  // -------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------

  /** Refresh all services' installed/signed-in state (TTL-coalesced). */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    if (!options.force && this.lastStatusRefreshAt !== null) {
      if (this.now() - this.lastStatusRefreshAt < STATUS_TTL_MS) return
    }
    this.refreshInFlight = this.doRefresh(options).finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async doRefresh(options: { force?: boolean }) {
    if (options.force) this.commandPaths.clear()
    await Promise.all(AUTH_SERVICE_ORDER.map((service) => this.probeService(service)))
    this.lastStatusRefreshAt = this.now()
    void this.checkLatestVersions().catch(() => undefined)
  }

  /** Force-probe one service (post login/install). */
  async probeService(service: AuthServiceId): Promise<void> {
    try {
      if (service === "openrouter") {
        const provider = await this.deps.readLlmProvider()
        const signedIn = provider.provider === "openrouter" && provider.apiKey.length > 0
        this.patchService(service, {
          installed: true,
          authStatus: signedIn ? "signed_in" : "signed_out",
          account: null,
          statusDetail: null,
          checkedAt: this.now(),
        })
        return
      }
      await this.probeCliService(service)
    } catch (error) {
      this.patchService(service, {
        authStatus: "error",
        statusDetail: error instanceof Error ? error.message : String(error),
        checkedAt: this.now(),
      })
    }
  }

  private async probeCliService(service: Exclude<AuthServiceId, "openrouter">) {
    const binaryPath = this.resolvePath(CLI_BINARIES[service])
    if (!binaryPath) {
      this.patchService(service, {
        installed: false,
        version: null,
        authStatus: "not_installed",
        account: null,
        statusDetail: null,
        checkedAt: this.now(),
      })
      return
    }

    const versionResult = await this.deps.exec([binaryPath, "--version"], { timeoutMs: 15_000 })
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
    const version =
      service === "claude" ? parseClaudeVersion(versionOutput)
      : service === "codex" ? parseCodexVersion(versionOutput)
      : service === "cursor" ? parseCursorVersion(versionResult.stdout)
      : service === "opencode" ? parseOpenCodeVersion(versionOutput)
      : parseGhVersion(versionOutput)

    let authStatus: AuthServiceSnapshot["authStatus"] = "signed_out"
    let account: string | null = null
    let statusDetail: string | null = null

    if (service === "claude") {
      const result = await this.deps.exec([binaryPath, "auth", "status", "--json"], { timeoutMs: 20_000 })
      const parsed = parseClaudeAuthStatus(result.stdout)
      if (parsed) {
        authStatus = parsed.loggedIn ? "signed_in" : "signed_out"
        account = parsed.account
      } else if (result.code !== 0 && isUnknownCliSyntax(`${result.stderr}\n${result.stdout}`)) {
        // The CLI predates `auth status --json` (e.g. v1.0.x rejects the
        // flag): its auth state is unreadable, so mark it outdated instead
        // of echoing the raw CLI error — the card requires an update.
        authStatus = "outdated"
        statusDetail = `Claude Code ${version ?? "(unknown version)"} is too old for Kanna — update it to continue.`
      } else {
        authStatus = result.code === 0 ? "signed_out" : "error"
        statusDetail = result.code === 0 ? null : truncateOutput(result.stderr || result.stdout)
      }
    } else if (service === "codex") {
      const result = await this.deps.exec([binaryPath, "login", "status"], { timeoutMs: 20_000 })
      if (result.code === 0) {
        authStatus = "signed_in"
        const match = /logged in (?:using|with|as)\s+(.+)/i.exec(stripAnsi(`${result.stdout}\n${result.stderr}`))
        account = match?.[1]?.trim() ?? null
      } else if (isUnknownCliSyntax(`${result.stderr}\n${result.stdout}`)) {
        authStatus = "outdated"
        statusDetail = `Codex ${version ?? "(unknown version)"} is too old for Kanna — update it to continue.`
      } else {
        authStatus = "signed_out"
      }
    } else if (service === "opencode") {
      // opencode stores per-provider credentials rather than one account, so
      // "signed in" means at least one credential exists. The account line
      // lists which providers are connected (e.g. "Anthropic, OpenCode Zen").
      const result = await this.deps.exec([binaryPath, "auth", "list"], { timeoutMs: 20_000 })
      const parsed = parseOpenCodeAuthList(`${result.stdout}\n${result.stderr}`)
      if (result.code !== 0) {
        authStatus = "error"
        statusDetail = truncateOutput(result.stderr || result.stdout)
      } else if (parsed.providers.length > 0) {
        authStatus = "signed_in"
        account = parsed.providers.join(", ")
      } else {
        authStatus = "signed_out"
      }
    } else if (service === "cursor") {
      const result = await this.deps.exec([binaryPath, "status"], { timeoutMs: 20_000 })
      const parsed = parseCursorStatus(`${result.stdout}\n${result.stderr}`)
      authStatus = parsed.loggedIn && result.code === 0 ? "signed_in" : "signed_out"
      account = parsed.loggedIn ? parsed.account : null
    } else {
      const result = await this.deps.exec([binaryPath, "auth", "status"], { timeoutMs: 20_000 })
      if (result.code === 0) {
        authStatus = "signed_in"
        account = parseGhAccount(`${result.stdout}\n${result.stderr}`)
      } else {
        authStatus = "signed_out"
      }
    }

    this.patchService(service, {
      installed: true,
      version,
      authStatus,
      account,
      statusDetail,
      checkedAt: this.now(),
    })
  }

  // -------------------------------------------------------------------------
  // Latest versions
  // -------------------------------------------------------------------------

  private async checkLatestVersions() {
    if (this.lastVersionCheckAt !== null && this.now() - this.lastVersionCheckAt < VERSION_TTL_MS) {
      return
    }
    this.lastVersionCheckAt = this.now()

    const npmFetcher = this.deps.fetchLatestNpmVersion
    if (npmFetcher) {
      for (const service of ["claude", "codex"] as const) {
        const pkg = NPM_PACKAGES[service]!
        try {
          const latest = await npmFetcher(pkg)
          this.patchService(service, { latestVersion: latest })
        } catch {
          // Feed unavailable — keep whatever we had.
        }
      }
    }

    try {
      const response = await this.fetchFn()("https://api.github.com/repos/cli/cli/releases/latest", {
        headers: { Accept: "application/vnd.github+json" },
      })
      if (response.ok) {
        const payload = (await response.json()) as { tag_name?: unknown }
        if (typeof payload.tag_name === "string" && payload.tag_name.trim()) {
          this.patchService("gh", { latestVersion: payload.tag_name.replace(/^v/i, "") })
        }
      }
    } catch {
      // Rate-limited/offline — keep whatever we had.
    }
    // cursor uses calendar versioning with no public feed: never offer an update chip.
  }

  // -------------------------------------------------------------------------
  // Install / update
  // -------------------------------------------------------------------------

  async install(service: AuthServiceId): Promise<void> {
    if (service === "openrouter") throw new Error("OpenRouter has no CLI to install.")
    const current = this.services.get(service)!
    if (current.installState === "installing") return

    this.patchService(service, { installState: "installing", installError: null })
    this.deps.trackEvent?.("auth_cli_install_started", { service })

    try {
      const command = this.installCommand(service)
      // Prefer bash: on Debian/Ubuntu `sh` is dash, which chokes on bash-isms
      // in the user's profile files ("source: not found") and buries the real
      // installer error in noise.
      const shell = this.resolvePath("bash") ? "bash" : "sh"
      const result = await this.deps.exec([shell, "-lc", command], { timeoutMs: 10 * 60_000 })
      if (result.code !== 0) {
        throw new Error(truncateOutput(result.stderr || result.stdout) || `Installer exited with code ${result.code}`)
      }
      // Re-resolve the binary (fresh — the install may have added it to PATH).
      this.commandPaths.delete(CLI_BINARIES[service])
      this.lastVersionCheckAt = null
      this.patchService(service, { installState: "idle", installError: null })
      this.deps.trackEvent?.("auth_cli_install_succeeded", { service })
      await this.probeService(service)
      void this.checkLatestVersions().catch(() => undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patchService(service, { installState: "error", installError: message })
      this.deps.trackEvent?.("auth_cli_install_failed", { service })
    }
  }

  private installCommand(service: Exclude<AuthServiceId, "openrouter">): string {
    const platform = this.deps.platform ?? process.platform
    if (service === "claude") {
      // Native-first: the official installer is per-user (~/.local/bin),
      // needs no root, and self-updates — `npm install -g` fails wherever the
      // global prefix is root-owned (e.g. cloud dev-boxes). For existing
      // installs try the binary's own self-update, falling back to the
      // native installer (which also migrates npm-managed installs).
      const existing = this.resolvePath(CLI_BINARIES.claude)
      const nativeInstall = "curl -fsSL https://claude.ai/install.sh | bash"
      if (existing) return `${shellQuote(existing)} update || (${nativeInstall})`
      return nativeInstall
    }
    if (service === "codex") {
      const pkg = NPM_PACKAGES.codex!
      if (this.resolvePath("npm")) return `npm install -g ${pkg}`
      if (this.resolvePath("bun")) return `bun add -g ${pkg}`
      throw new Error("Neither npm nor bun is available to install the package.")
    }
    if (service === "opencode") {
      // Native installer (per-user, no root) matches how claude/cursor are
      // handled; an existing install self-updates via `opencode upgrade`.
      const existing = this.resolvePath(CLI_BINARIES.opencode)
      if (existing) return `${shellQuote(existing)} upgrade`
      return "curl -fsSL https://opencode.ai/install | bash"
    }
    if (service === "cursor") {
      const existing = this.resolvePath(CLI_BINARIES.cursor)
      if (existing) return `${shellQuote(existing)} update`
      return "curl https://cursor.com/install -fsS | bash"
    }
    // gh
    if (platform === "darwin") {
      if (this.resolvePath("brew")) return "brew install gh || brew upgrade gh"
      throw new Error("Homebrew not found. Install it from brew.sh, or download the GitHub CLI from cli.github.com.")
    }
    // Download to a file (not `curl | tar`): in a pipeline a mid-transfer
    // curl failure just truncates tar's stdin — `set -e` never sees curl's
    // exit code and the surfaced error is a baffling "gzip: unexpected end
    // of file". Retries paper over transient CDN 5xx/timeouts.
    return [
      "set -e",
      `ver=$(curl -fsSL --retry 3 --retry-all-errors https://api.github.com/repos/cli/cli/releases/latest | grep -o '"tag_name": *"v[^"]*"' | head -1 | grep -o 'v[0-9][0-9.]*')`,
      `test -n "$ver"`,
      `arch=$(uname -m); case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac`,
      `tmp=$(mktemp -d)`,
      `trap 'rm -rf "$tmp"' EXIT`,
      `curl -fsSL --retry 3 --retry-all-errors -o "$tmp/gh.tar.gz" "https://github.com/cli/cli/releases/download/$ver/gh_$(echo $ver | tr -d v)_linux_$arch.tar.gz"`,
      `tar -xzf "$tmp/gh.tar.gz" -C "$tmp"`,
      "mkdir -p \"$HOME/.local/bin\"",
      `cp "$tmp/gh_$(echo $ver | tr -d v)_linux_$arch/bin/gh" "$HOME/.local/bin/gh"`,
    ].join("\n")
  }

  // -------------------------------------------------------------------------
  // Login flows
  // -------------------------------------------------------------------------

  startLogin(service: AuthServiceId): void {
    if (service === "openrouter") {
      throw new Error("Use the OpenRouter OAuth flow (auth.openrouter.start).")
    }
    if (service === "opencode") {
      // `opencode auth login` is an interactive picker over ~100 providers,
      // several of which finish in a browser. The client runs the real CLI in
      // a terminal dialog and polls `auth.refresh` for the credential instead
      // (see OpenCodeSignInDialog), so there is no server-driven flow here.
      throw new Error("opencode signs in through its terminal dialog.")
    }
    this.teardownFlow(service)

    const current = this.services.get(service)!
    if (!current.installed || current.authStatus === "not_installed") {
      throw new Error(`${current.label} is not installed.`)
    }
    if (current.authStatus === "outdated") {
      throw new Error(`${current.label} is too old for Kanna — update it first.`)
    }

    const flow: LoginFlowRuntime = {
      service,
      child: null,
      cancelled: false,
      codeSubmitted: false,
      transcript: "",
      timers: [],
    }
    this.flows.set(service, flow)
    this.setLogin(service, { phase: "starting" })
    this.deps.trackEvent?.("auth_login_started", { service })

    // Overall watchdog: never leave a flow hanging forever.
    flow.timers.push(setTimeout(() => {
      if (this.flows.get(service) === flow && !flow.cancelled) {
        this.failFlow(flow, "Sign-in timed out.", null)
      }
    }, LOGIN_WATCHDOG_MS))

    const run =
      service === "gh" ? this.runGhLogin(flow)
      : service === "codex" ? this.runCodexLogin(flow)
      : service === "cursor" ? this.runCursorLogin(flow)
      : this.runClaudeLogin(flow)

    void run.catch((error) => {
      if (flow.cancelled || this.flows.get(service) !== flow) return
      this.failFlow(flow, error instanceof Error ? error.message : String(error), null)
    })
  }

  submitLoginCode(service: AuthServiceId, code: string): void {
    const flow = this.flows.get(service)
    const snapshot = this.services.get(service)!
    if (!flow || snapshot.login.phase !== "waiting_for_code_entry") {
      throw new Error("No sign-in flow is waiting for a code.")
    }
    const cleaned = code.trim()
    if (!cleaned) throw new Error("Enter the code from the sign-in page.")
    if (!flow.child?.write) throw new Error("Sign-in process is not accepting input.")
    flow.codeSubmitted = true
    this.setLogin(service, { phase: "finishing" })
    flow.child.write(`${cleaned}\r`)
    // Safety net: if the Ink app lingers after a successful login instead of
    // exiting, probe once — a verified signed-in state completes the flow.
    flow.timers.push(setTimeout(() => {
      void (async () => {
        if (flow.cancelled || this.flows.get(service) !== flow) return
        await this.probeService(service)
        if (flow.cancelled || this.flows.get(service) !== flow) return
        if (this.services.get(service)!.authStatus === "signed_in") {
          this.teardownFlow(service)
          this.setLogin(service, { phase: "idle" })
          this.deps.trackEvent?.("auth_login_succeeded", { service })
          this.deps.onSignedIn?.(service)
        }
      })()
    }, 15_000))
  }

  cancelLogin(service: AuthServiceId): void {
    const flow = this.flows.get(service)
    if (!flow) {
      // Also clears a stale error state.
      this.setLogin(service, { phase: "idle" })
      return
    }
    this.teardownFlow(service)
    this.setLogin(service, { phase: "idle" })
  }

  private teardownFlow(service: AuthServiceId) {
    const flow = this.flows.get(service)
    if (!flow) return
    flow.cancelled = true
    for (const timer of flow.timers) clearTimeout(timer)
    flow.timers = []
    try {
      flow.child?.kill()
    } catch {
      // already dead
    }
    this.flows.delete(service)
  }

  private failFlow(flow: LoginFlowRuntime, message: string, hint: string | null) {
    if (this.flows.get(flow.service) === flow) {
      this.teardownFlow(flow.service)
    }
    this.setLogin(flow.service, { phase: "error", message, hint })
    this.deps.trackEvent?.("auth_login_failed", { service: flow.service })
  }

  /** Re-probe after a flow reports success; only a verified signed-in state counts. */
  private async finishLogin(flow: LoginFlowRuntime) {
    const { service } = flow
    this.setLogin(service, { phase: "finishing" })
    if (this.flows.get(service) === flow) {
      for (const timer of flow.timers) clearTimeout(timer)
      flow.timers = []
      this.flows.delete(service)
    }
    await this.probeService(service)
    const snapshot = this.services.get(service)!
    if (snapshot.authStatus === "signed_in") {
      this.setLogin(service, { phase: "idle" })
      this.deps.trackEvent?.("auth_login_succeeded", { service })
      this.deps.onSignedIn?.(service)
    } else {
      this.setLogin(service, {
        phase: "error",
        message: "Sign-in finished but the CLI still reports signed out.",
        hint: null,
      })
      this.deps.trackEvent?.("auth_login_failed", { service })
    }
  }

  private async runGhLogin(flow: LoginFlowRuntime) {
    const ghPath = this.resolvePath(CLI_BINARIES.gh)
    if (!ghPath) throw new Error("GitHub CLI is not installed.")
    const fetchFn = this.fetchFn()

    const deviceResponse = await fetchFn("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `client_id=${GH_CLIENT_ID}&scope=${encodeURIComponent(GH_SCOPES)}`,
    })
    if (!deviceResponse.ok) {
      throw new Error(`GitHub device authorization failed (${deviceResponse.status}).`)
    }
    const device = (await deviceResponse.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }
    if (!device.device_code || !device.user_code) {
      throw new Error("GitHub did not return a device code.")
    }
    if (flow.cancelled) return

    const startedAt = this.now()
    const expiresAt = startedAt + (device.expires_in ?? 900) * 1000
    let intervalSeconds = Math.max(5, device.interval ?? 5)
    this.setLogin("gh", {
      phase: "waiting_for_approval",
      verificationUrl: device.verification_uri ?? "https://github.com/login/device",
      userCode: device.user_code,
      startedAt,
      expiresAt,
    })

    while (!flow.cancelled) {
      await this.sleep(intervalSeconds * 1000)
      if (flow.cancelled) return
      if (this.now() > expiresAt) {
        this.failFlow(flow, "The sign-in code expired. Try again.", null)
        return
      }

      let payload: { access_token?: string; error?: string; error_description?: string }
      try {
        const pollResponse = await fetchFn("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body:
            `client_id=${GH_CLIENT_ID}` +
            `&device_code=${encodeURIComponent(device.device_code)}` +
            `&grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:device_code")}`,
        })
        payload = (await pollResponse.json()) as typeof payload
      } catch {
        // Transient network failure — keep polling.
        continue
      }
      if (flow.cancelled) return

      if (payload.access_token) {
        this.setLogin("gh", { phase: "finishing" })
        const login = await this.deps.exec([ghPath, "auth", "login", "--with-token"], {
          stdin: payload.access_token,
          timeoutMs: 60_000,
        })
        if (login.code !== 0) {
          this.failFlow(flow, `gh auth login failed: ${truncateOutput(login.stderr || login.stdout)}`, null)
          return
        }
        await this.deps.exec([ghPath, "auth", "setup-git"], { timeoutMs: 30_000 }).catch(() => undefined)
        await this.ensureGitIdentity().catch(() => undefined)
        await this.finishLogin(flow)
        return
      }
      if (payload.error === "authorization_pending") continue
      if (payload.error === "slow_down") {
        intervalSeconds += 5
        continue
      }
      this.failFlow(
        flow,
        payload.error_description ?? payload.error ?? "GitHub rejected the sign-in.",
        null
      )
      return
    }
  }

  /**
   * Give git a global commit identity when the machine has none.
   *
   * `gh auth setup-git` (run just above) installs the credential helper, which
   * is enough to *push* but not to *commit*: with no `user.name`/`user.email`,
   * git refuses with "Author identity unknown" after guessing a bogus
   * `user@host.(none)` address. Fresh boxes, devboxes and containers routinely
   * ship without a `~/.gitconfig` identity, so onboarding would complete and
   * then the first commit, merge or rebase Kanna attempts would fail.
   *
   * Only missing values are filled in — an identity the user already set is
   * never overwritten — and every failure is swallowed, because sign-in itself
   * has already succeeded and must not be reported as broken.
   */
  private async ensureGitIdentity() {
    const gitPath = this.resolvePath("git")
    const ghPath = this.resolvePath(CLI_BINARIES.gh)
    if (!gitPath || !ghPath) return

    const readConfig = async (key: string): Promise<string> => {
      // `--get` exits 1 when the key is unset, which is the signal we want.
      const result = await this.deps.exec([gitPath, "config", "--global", "--get", key], {
        timeoutMs: 10_000,
      })
      return result.code === 0 ? result.stdout.trim() : ""
    }
    const [existingName, existingEmail] = await Promise.all([
      readConfig("user.name"),
      readConfig("user.email"),
    ])
    if (existingName && existingEmail) return

    const userResult = await this.deps.exec([ghPath, "api", "user"], { timeoutMs: 20_000 })
    if (userResult.code !== 0) return
    const identity = parseGhUserIdentity(userResult.stdout)
    if (!identity) return

    if (!existingName) {
      await this.deps.exec([gitPath, "config", "--global", "user.name", identity.name], {
        timeoutMs: 10_000,
      })
    }
    if (!existingEmail) {
      await this.deps.exec([gitPath, "config", "--global", "user.email", identity.email], {
        timeoutMs: 10_000,
      })
    }
  }

  private async runCodexLogin(flow: LoginFlowRuntime) {
    const codexPath = this.resolvePath(CLI_BINARIES.codex)
    if (!codexPath) throw new Error("Codex CLI is not installed.")

    const child = this.deps.spawnStreaming([codexPath, "login", "--device-auth"])
    flow.child = child
    let buffer = ""
    child.onOutput((chunk) => {
      buffer = (buffer + chunk).slice(-16_384)
      flow.transcript = buffer
      const current = this.services.get("codex")!
      if (current.login.phase !== "starting") return
      const parsed = parseCodexDeviceLogin(stripAnsi(buffer))
      if (parsed) {
        const startedAt = this.now()
        this.setLogin("codex", {
          phase: "waiting_for_approval",
          verificationUrl: parsed.verificationUrl,
          userCode: parsed.userCode,
          startedAt,
          expiresAt: startedAt + 15 * 60_000,
        })
      }
    })

    const exitCode = await child.exited
    if (flow.cancelled) return
    if (exitCode === 0) {
      await this.finishLogin(flow)
      return
    }
    // A config parse failure means Codex can't run at all — device-auth
    // settings are not the problem, the named config.toml line is.
    const transcriptText = stripAnsi(flow.transcript)
    const configLoadFailed = /(?:error loading|failed to load) configuration/i.test(transcriptText)
    this.failFlow(
      flow,
      `Codex sign-in failed: ${truncateOutput(transcriptText) || `exit code ${exitCode}`}`,
      configLoadFailed
        ? "Codex could not read ~/.codex/config.toml — fix or remove the line it names (or update Codex), then try again."
        : CODEX_DEVICE_AUTH_HINT
    )
  }

  private async runCursorLogin(flow: LoginFlowRuntime) {
    const cursorPath = this.resolvePath(CLI_BINARIES.cursor)
    if (!cursorPath) throw new Error("Cursor CLI is not installed.")

    const child = this.deps.spawnStreaming([cursorPath, "login"], { env: { NO_OPEN_BROWSER: "1" } })
    flow.child = child
    let buffer = ""
    child.onOutput((chunk) => {
      buffer = (buffer + chunk).slice(-16_384)
      flow.transcript = buffer
      const current = this.services.get("cursor")!
      if (current.login.phase !== "starting") return
      const parsed = parseCursorLogin(stripAnsi(buffer))
      if (parsed) {
        this.setLogin("cursor", {
          phase: "waiting_for_approval",
          verificationUrl: parsed.verificationUrl,
          userCode: null,
          startedAt: this.now(),
          expiresAt: null,
        })
      }
    })

    const exitCode = await child.exited
    if (flow.cancelled) return
    if (exitCode === 0) {
      await this.finishLogin(flow)
      return
    }
    this.failFlow(
      flow,
      `Cursor sign-in failed: ${truncateOutput(stripAnsi(flow.transcript)) || `exit code ${exitCode}`}`,
      null
    )
  }

  private async runClaudeLogin(flow: LoginFlowRuntime) {
    const claudePath = this.resolvePath(CLI_BINARIES.claude)
    if (!claudePath) throw new Error("Claude Code is not installed.")

    const child = this.deps.spawnPty([claudePath, "auth", "login"])
    flow.child = child
    child.onOutput((chunk) => {
      flow.transcript = (flow.transcript + chunk).slice(-16_384)
      const current = this.services.get("claude")!
      if (current.login.phase !== "starting") return
      const url = parseClaudeOauthUrl(flow.transcript)
      if (url) {
        this.setLogin("claude", {
          phase: "waiting_for_code_entry",
          verificationUrl: url,
          startedAt: this.now(),
        })
      }
    })

    // The Ink app may show a login-method menu before printing the URL —
    // press Enter once to accept the default if nothing appeared yet.
    flow.timers.push(setTimeout(() => {
      if (flow.cancelled || this.flows.get("claude") !== flow) return
      if (this.services.get("claude")!.login.phase === "starting") {
        child.write?.("\r")
      }
    }, CLAUDE_MENU_FALLBACK_MS))

    // If no URL surfaced at all, fail with the transcript tail for debugging.
    flow.timers.push(setTimeout(() => {
      if (flow.cancelled || this.flows.get("claude") !== flow) return
      if (this.services.get("claude")!.login.phase === "starting") {
        this.failFlow(
          flow,
          `Claude sign-in did not produce a login link: ${truncateOutput(stripAnsi(flow.transcript))}`,
          "On macOS the Keychain may need approval the first time — try running `claude auth login` in a terminal once."
        )
      }
    }, CLAUDE_URL_TIMEOUT_MS))

    const exitCode = await child.exited
    if (flow.cancelled) return
    const phase = this.services.get("claude")!.login.phase
    if (flow.codeSubmitted || (exitCode === 0 && phase !== "error")) {
      await this.finishLogin(flow)
      return
    }
    if (phase !== "error") {
      this.failFlow(
        flow,
        `Claude sign-in ended unexpectedly: ${truncateOutput(stripAnsi(flow.transcript)) || `exit code ${exitCode}`}`,
        null
      )
    }
  }

  // -------------------------------------------------------------------------
  // OpenRouter PKCE (server-mediated: works on plain-HTTP LAN hosts too)
  // -------------------------------------------------------------------------

  startOpenRouterAuth(callbackUrl: string): { authUrl: string } {
    const parsed = new URL(callbackUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Invalid callback URL.")
    }
    const verifier = randomBytes(32).toString("base64url")
    this.openRouterVerifier = verifier
    const challenge = pkceChallengeS256(verifier)
    const authUrl =
      `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`
    return { authUrl }
  }

  async exchangeOpenRouterCode(code: string): Promise<LlmProviderSnapshot> {
    const verifier = this.openRouterVerifier
    if (!verifier) {
      throw new Error("No OpenRouter sign-in in progress. Start the flow again.")
    }
    const response = await this.fetchFn()("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    })
    if (!response.ok) {
      throw new Error(`OpenRouter key exchange failed (${response.status}).`)
    }
    const payload = (await response.json()) as { key?: unknown }
    if (typeof payload.key !== "string" || !payload.key.trim()) {
      throw new Error("OpenRouter did not return an API key.")
    }
    this.openRouterVerifier = null

    const current = await this.deps.readLlmProvider()
    const snapshot = await this.deps.writeLlmProvider({
      provider: "openrouter",
      apiKey: payload.key,
      model: current.provider === "openrouter" && current.model ? current.model : DEFAULT_OPENROUTER_SDK_MODEL,
      baseUrl: "",
      faveModels: current.faveModels,
    })
    await this.probeService("openrouter")
    this.deps.trackEvent?.("auth_login_succeeded", { service: "openrouter" })
    this.deps.onSignedIn?.("openrouter")
    return snapshot
  }
}

// ---------------------------------------------------------------------------
// Real-process deps (server runtime)
// ---------------------------------------------------------------------------

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

export function createProcessAuthDeps(): Pick<ProviderAuthManagerDeps, "exec" | "spawnStreaming" | "spawnPty"> {
  return {
    async exec(argv, opts) {
      const proc = Bun.spawn(argv, {
        stdin: opts?.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...opts?.env },
      })
      const killTimer = opts?.timeoutMs
        ? setTimeout(() => {
            try {
              proc.kill()
            } catch {
              // already exited
            }
          }, opts.timeoutMs)
        : null
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { code, stdout, stderr }
      } finally {
        if (killTimer) clearTimeout(killTimer)
      }
    },

    spawnStreaming(argv, opts) {
      const listeners = new Set<(chunk: string) => void>()
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...opts?.env },
      })
      const pump = async (stream: ReadableStream<Uint8Array> | undefined) => {
        if (!stream) return
        const decoder = new TextDecoder()
        const reader = stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const text = decoder.decode(value, { stream: true })
            for (const listener of listeners) listener(text)
          }
        } catch {
          // stream closed with the process
        }
      }
      void pump(proc.stdout as ReadableStream<Uint8Array>)
      void pump(proc.stderr as ReadableStream<Uint8Array>)
      return {
        onOutput: (listener) => {
          listeners.add(listener)
        },
        exited: proc.exited,
        kill: () => {
          try {
            proc.kill()
          } catch {
            // already exited
          }
        },
      }
    },

    spawnPty(argv) {
      if (typeof Bun.Terminal !== "function") {
        throw new Error("This sign-in flow requires Bun 1.3.5+ (PTY support).")
      }
      const listeners = new Set<(chunk: string) => void>()
      const terminal = new Bun.Terminal({
        cols: 200,
        rows: 50,
        name: "xterm-256color",
        data: (_terminal, data) => {
          const text = Buffer.from(data).toString("utf8")
          for (const listener of listeners) listener(text)
        },
      })
      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn(argv, {
          terminal,
          env: { ...process.env, TERM: "xterm-256color" },
        })
      } catch (error) {
        terminal.close()
        throw error
      }
      void proc.exited.finally(() => {
        try {
          terminal.close()
        } catch {
          // already closed
        }
      }).catch(() => undefined)
      return {
        onOutput: (listener) => {
          listeners.add(listener)
        },
        exited: proc.exited,
        kill: () => {
          try {
            proc.kill()
          } catch {
            // already exited
          }
        },
        write: (data) => {
          try {
            terminal.write(data)
          } catch {
            console.warn(`${LOG_PREFIX} provider-auth: failed to write to login pty`)
          }
        },
      }
    },
  }
}
