import { describe, expect, test } from "bun:test"
import type { LlmProviderSnapshot } from "../shared/types"
import {
  ProviderAuthManager,
  parseClaudeAuthStatus,
  parseClaudeOauthUrl,
  parseClaudeVersion,
  parseCodexDeviceLogin,
  parseCodexVersion,
  parseCursorLogin,
  parseCursorStatus,
  parseCursorVersion,
  parseGhAccount,
  parseGhUserIdentity,
  parseGhVersion,
  pkceChallengeS256,
  stripAnsi,
  type ExecResult,
  type ProviderAuthManagerDeps,
  type StreamingChild,
} from "./provider-auth"

// ---------------------------------------------------------------------------
// Fixtures (captured from the real CLIs, ANSI codes intact)
// ---------------------------------------------------------------------------

const CODEX_DEVICE_FIXTURE =
  "\nWelcome to Codex [v\x1b[90m0.145.0\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
  "1. Open this link in your browser and sign in to your account\n" +
  "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n" +
  "   \x1b[94mO0A7-WTAU3\x1b[0m\n"

const CURSOR_LOGIN_FIXTURE =
  "Starting login process...\nAuthenticating with Cursor...\nWaiting for browser authentication...\n" +
  "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=VE_v2YCDCaBj9Yrq&uuid=3356ca7b-fe67-412b-b7d9-cb1e0307c1b3&mode=login&redirectTarget=cli\n"

const CLAUDE_OAUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=KWby35-wZgH48GZPeQnWZFuFa_qbCGdfj5SkJ9w6944&code_challenge_method=S256&state=JF9rjEtJTPNr1OBKbEehlQjU3bG"

/** OSC-8 hyperlink wrapping, as the Ink app renders it — visible text is wrapped/truncated. */
const CLAUDE_LOGIN_FIXTURE =
  "\x1b7\x1b[r\x1b8Welcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24Gv2.1.218\r\n" +
  "Browser didn't open? Use the url\x1b[35Gbelow\x1b[41Gto\x1b[44Gsign\x1b[49Gin\r\n" +
  `\x1b]8;id=1gjx50p;${CLAUDE_OAUTH_URL}\x07https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44\x1b]8;;\x07\r\n`

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parsers", () => {
  test("stripAnsi removes CSI and OSC sequences", () => {
    const stripped = stripAnsi(CODEX_DEVICE_FIXTURE)
    expect(stripped).toContain("https://auth.openai.com/codex/device")
    expect(stripped).toContain("O0A7-WTAU3")
    expect(stripped).not.toContain("\x1b")
  })

  test("parseCodexDeviceLogin extracts url and one-time code", () => {
    const parsed = parseCodexDeviceLogin(stripAnsi(CODEX_DEVICE_FIXTURE))
    expect(parsed).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "O0A7-WTAU3",
    })
  })

  test("parseCodexDeviceLogin returns null until both url and code are present", () => {
    expect(parseCodexDeviceLogin("Open this link: https://auth.openai.com/codex/device")).toBeNull()
  })

  test("parseCursorLogin extracts the login url", () => {
    const parsed = parseCursorLogin(CURSOR_LOGIN_FIXTURE)
    expect(parsed?.verificationUrl).toBe(
      "https://cursor.com/loginDeepControl?challenge=VE_v2YCDCaBj9Yrq&uuid=3356ca7b-fe67-412b-b7d9-cb1e0307c1b3&mode=login&redirectTarget=cli"
    )
    expect(parsed?.userCode).toBeNull()
  })

  test("parseClaudeOauthUrl finds the full url inside OSC-8 hyperlinks", () => {
    expect(parseClaudeOauthUrl(CLAUDE_LOGIN_FIXTURE)).toBe(CLAUDE_OAUTH_URL)
  })

  test("parseClaudeOauthUrl ignores non-oauth urls", () => {
    expect(parseClaudeOauthUrl("see https://docs.claude.com/setup for help")).toBeNull()
  })

  test("version parsers", () => {
    expect(parseClaudeVersion("2.1.218 (Claude Code)")).toBe("2.1.218")
    expect(parseCodexVersion("codex-cli 0.145.0")).toBe("0.145.0")
    expect(parseCursorVersion("2026.07.23-e383d2b\n")).toBe("2026.07.23-e383d2b")
    expect(parseGhVersion("gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0")).toBe("2.96.0")
  })

  test("parseClaudeAuthStatus parses the JSON payload", () => {
    expect(parseClaudeAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}'))
      .toEqual({ loggedIn: false, account: null })
    expect(parseClaudeAuthStatus('{"loggedIn": true, "email": "jake@example.com"}'))
      .toEqual({ loggedIn: true, account: "jake@example.com" })
    expect(parseClaudeAuthStatus("garbage")).toBeNull()
  })

  test("parseCursorStatus", () => {
    expect(parseCursorStatus("Not logged in\n")).toEqual({ loggedIn: false, account: null })
    expect(parseCursorStatus("Logged in as jake@example.com\nEndpoint: api2.cursor.sh"))
      .toEqual({ loggedIn: true, account: "jake@example.com" })
  })

  test("parseGhUserIdentity builds the noreply commit address", () => {
    expect(
      parseGhUserIdentity(JSON.stringify({ login: "jakemor", name: "Jake Mor", id: 5595046 }))
    ).toEqual({ name: "Jake Mor", email: "5595046+jakemor@users.noreply.github.com" })
  })

  test("parseGhUserIdentity falls back to the login when the profile name is blank", () => {
    expect(parseGhUserIdentity(JSON.stringify({ login: "jakemor", name: "  ", id: 42 }))).toEqual({
      name: "jakemor",
      email: "42+jakemor@users.noreply.github.com",
    })
    expect(parseGhUserIdentity(JSON.stringify({ login: "jakemor", id: 42 }))?.name).toBe("jakemor")
  })

  test("parseGhUserIdentity uses the legacy address when there is no usable id", () => {
    expect(parseGhUserIdentity(JSON.stringify({ login: "jakemor", name: "Jake" }))?.email).toBe(
      "jakemor@users.noreply.github.com"
    )
  })

  test("parseGhUserIdentity rejects unusable payloads", () => {
    expect(parseGhUserIdentity("not json")).toBeNull()
    expect(parseGhUserIdentity(JSON.stringify({ name: "Jake", id: 1 }))).toBeNull()
    expect(parseGhUserIdentity(JSON.stringify({ login: "   ", id: 1 }))).toBeNull()
  })

  test("parseGhAccount", () => {
    expect(parseGhAccount("github.com\n  ✓ Logged in to github.com account jakemny (keyring)")).toBe("jakemny")
  })

  test("pkceChallengeS256 is the base64url sha256 of the verifier", () => {
    // RFC 7636 appendix B test vector.
    expect(pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})

// ---------------------------------------------------------------------------
// Manager harness
// ---------------------------------------------------------------------------

class FakeChild implements StreamingChild {
  private listeners = new Set<(chunk: string) => void>()
  private resolveExit!: (code: number) => void
  readonly exited: Promise<number>
  killed = false
  written: string[] = []

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  onOutput(listener: (chunk: string) => void) {
    this.listeners.add(listener)
  }

  emit(chunk: string) {
    for (const listener of this.listeners) listener(chunk)
  }

  exit(code: number) {
    this.resolveExit(code)
  }

  kill() {
    this.killed = true
    this.resolveExit(143)
  }

  write = (data: string) => {
    this.written.push(data)
  }
}

function llmSnapshot(overrides: Partial<LlmProviderSnapshot> = {}): LlmProviderSnapshot {
  return {
    provider: "openai",
    apiKey: "",
    model: "gpt-5.4-mini",
    baseUrl: "",
    resolvedBaseUrl: "https://api.openai.com/v1",
    faveModels: [],
    enabled: false,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
    ...overrides,
  }
}

interface HarnessOptions {
  paths?: Record<string, string | null>
  exec?: (argv: string[], opts?: { stdin?: string }) => ExecResult | Promise<ExecResult>
  spawnStreaming?: (argv: string[], opts?: { env?: Record<string, string> }) => StreamingChild
  spawnPty?: (argv: string[]) => StreamingChild
  fetchFn?: typeof fetch
  llmProvider?: LlmProviderSnapshot
  fetchLatestNpmVersion?: (pkg: string) => Promise<string>
  platform?: NodeJS.Platform
}

function createHarness(options: HarnessOptions = {}) {
  const paths: Record<string, string | null> = {
    claude: "/usr/local/bin/claude",
    codex: "/usr/local/bin/codex",
    "cursor-agent": "/home/user/.local/bin/cursor-agent",
    grok: "/home/user/.local/bin/grok",
    gh: "/usr/local/bin/gh",
    git: "/usr/bin/git",
    npm: "/usr/local/bin/npm",
    brew: null,
    bun: "/usr/local/bin/bun",
    ...options.paths,
  }
  const execCalls: Array<{ argv: string[]; stdin?: string }> = []
  const signedIn: string[] = []
  const events: string[] = []
  let llmProvider = options.llmProvider ?? llmSnapshot()
  let now = 1_000_000

  const deps: ProviderAuthManagerDeps = {
    exec: async (argv, opts) => {
      execCalls.push({ argv, stdin: opts?.stdin })
      if (options.exec) return options.exec(argv, opts)
      return { code: 0, stdout: "", stderr: "" }
    },
    spawnStreaming: options.spawnStreaming ?? (() => new FakeChild()),
    spawnPty: options.spawnPty ?? (() => new FakeChild()),
    readLlmProvider: async () => llmProvider,
    writeLlmProvider: async (value) => {
      llmProvider = llmSnapshot({
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
        faveModels: value.faveModels ?? [],
        enabled: value.apiKey.length > 0,
      })
      return llmProvider
    },
    fetchFn: options.fetchFn ?? ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    fetchLatestNpmVersion: options.fetchLatestNpmVersion,
    resolveCommandPath: (command) => paths[command] ?? null,
    onSignedIn: (service) => signedIn.push(service),
    trackEvent: (name) => events.push(name),
    sleep: async () => {},
    platform: options.platform ?? "darwin",
    now: () => now,
  }
  const manager = new ProviderAuthManager(deps)
  return {
    manager,
    execCalls,
    signedIn,
    events,
    getLlmProvider: () => llmProvider,
    advance: (ms: number) => {
      now += ms
    },
    setPath: (command: string, value: string | null) => {
      paths[command] = value
    },
  }
}

/** Default exec behavior: everything installed, everything signed out. */
function signedOutExec(argv: string[]): ExecResult {
  const joined = argv.join(" ")
  if (joined.endsWith("--version")) {
    if (argv[0].includes("claude")) return { code: 0, stdout: "2.1.218 (Claude Code)", stderr: "" }
    if (argv[0].includes("codex")) return { code: 0, stdout: "codex-cli 0.145.0", stderr: "" }
    if (argv[0].includes("cursor-agent")) return { code: 0, stdout: "2026.07.23-e383d2b\n", stderr: "" }
    if (argv[0].includes("grok")) return { code: 0, stdout: "grok 1.0.13 (abc)\n", stderr: "" }
    if (argv[0].includes("gh")) return { code: 0, stdout: "gh version 2.96.0 (2026-07-02)", stderr: "" }
  }
  if (joined.includes("auth status --json")) {
    return { code: 0, stdout: '{"loggedIn": false, "authMethod": "none"}', stderr: "" }
  }
  if (joined.includes("login status")) return { code: 1, stdout: "", stderr: "Not logged in" }
  if (joined.includes("cursor-agent status")) return { code: 0, stdout: "Not logged in", stderr: "" }
  if (joined.includes("grok") && joined.includes("models")) return { code: 1, stdout: "Not logged in. Run `grok login`.", stderr: "" }
  if (joined.includes("auth status")) return { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." }
  return { code: 0, stdout: "", stderr: "" }
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

describe("ProviderAuthManager probing", () => {
  test("reports not_installed when the binary is missing", async () => {
    const harness = createHarness({
      paths: { claude: null, codex: null, "cursor-agent": null, grok: null, gh: null },
    })
    await harness.manager.refresh({ force: true })
    const snapshot = harness.manager.getSnapshot()
    for (const service of ["claude", "codex", "cursor", "grok", "gh"]) {
      const entry = snapshot.services.find((s) => s.service === service)!
      expect(entry.authStatus).toBe("not_installed")
      expect(entry.installed).toBe(false)
    }
  })

  test("parses versions and signed-out statuses", async () => {
    const harness = createHarness({ exec: signedOutExec })
    await harness.manager.refresh({ force: true })
    const byService = new Map(harness.manager.getSnapshot().services.map((s) => [s.service, s]))
    expect(byService.get("claude")).toMatchObject({ installed: true, version: "2.1.218", authStatus: "signed_out" })
    expect(byService.get("codex")).toMatchObject({ version: "0.145.0", authStatus: "signed_out" })
    expect(byService.get("cursor")).toMatchObject({ version: "2026.07.23-e383d2b", authStatus: "signed_out" })
    expect(byService.get("grok")).toMatchObject({ version: "1.0.13", authStatus: "signed_out" })
    expect(byService.get("gh")).toMatchObject({ version: "2.96.0", authStatus: "signed_out" })
    expect(byService.get("openrouter")).toMatchObject({ installed: true, authStatus: "signed_out" })
  })

  test("reports signed-in statuses with accounts", async () => {
    const harness = createHarness({
      exec: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("auth status --json")) {
          return { code: 0, stdout: '{"loggedIn": true, "email": "jake@example.com"}', stderr: "" }
        }
        if (joined.includes("login status")) return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" }
        if (joined.includes("cursor-agent status")) return { code: 0, stdout: "Logged in as jake@x.com", stderr: "" }
        if (argv[0].includes("grok") && argv.includes("models")) {
          return { code: 0, stdout: "You are logged in with grok.com.\nDefault model: grok-4.6\n", stderr: "" }
        }
        if (joined.includes("auth status")) {
          return { code: 0, stdout: "✓ Logged in to github.com account jakemny (keyring)", stderr: "" }
        }
        return signedOutExec(argv)
      },
      llmProvider: llmSnapshot({ provider: "openrouter", apiKey: "sk-or-xxx" }),
    })
    await harness.manager.refresh({ force: true })
    const byService = new Map(harness.manager.getSnapshot().services.map((s) => [s.service, s]))
    expect(byService.get("claude")).toMatchObject({ authStatus: "signed_in", account: "jake@example.com" })
    expect(byService.get("codex")).toMatchObject({ authStatus: "signed_in", account: "ChatGPT" })
    expect(byService.get("cursor")).toMatchObject({ authStatus: "signed_in", account: "jake@x.com" })
    expect(byService.get("grok")).toMatchObject({ authStatus: "signed_in", account: "grok.com" })
    expect(byService.get("gh")).toMatchObject({ authStatus: "signed_in", account: "jakemny" })
    expect(byService.get("openrouter")).toMatchObject({ authStatus: "signed_in" })
  })

  test("an old Claude CLI that rejects `auth status --json` reads as outdated, not a raw error", async () => {
    // Claude Code v1.0.x predates the JSON auth status; it exits non-zero
    // with "error: unknown option '--json'".
    const harness = createHarness({
      exec: (argv) => {
        const joined = argv.join(" ")
        if (argv[0].includes("claude") && joined.endsWith("--version")) {
          return { code: 0, stdout: "1.0.77 (Claude Code)", stderr: "" }
        }
        if (argv[0].includes("claude") && joined.includes("auth status --json")) {
          return { code: 1, stdout: "", stderr: "error: unknown option '--json'" }
        }
        return signedOutExec(argv)
      },
    })
    await harness.manager.refresh({ force: true })
    const claude = harness.manager.getSnapshot().services.find((s) => s.service === "claude")!
    expect(claude.authStatus).toBe("outdated")
    expect(claude.statusDetail).toContain("too old")
    expect(claude.statusDetail).toContain("1.0.77")
    expect(claude.statusDetail).not.toContain("unknown option")

    // Updating is the only way forward — login refuses until then.
    expect(() => harness.manager.startLogin("claude")).toThrow("too old")
  })

  test("non-forced refresh is TTL-coalesced", async () => {
    const harness = createHarness({ exec: signedOutExec })
    await harness.manager.refresh()
    const callsAfterFirst = harness.execCalls.length
    await harness.manager.refresh()
    expect(harness.execCalls.length).toBe(callsAfterFirst)
    harness.advance(61_000)
    await harness.manager.refresh()
    expect(harness.execCalls.length).toBeGreaterThan(callsAfterFirst)
  })

  test("update availability from npm and gh release feeds", async () => {
    const harness = createHarness({
      exec: signedOutExec,
      fetchLatestNpmVersion: async (pkg) =>
        pkg === "@anthropic-ai/claude-code" ? "2.2.0" : "0.145.0",
      fetchFn: (async (url: string | URL | Request) => {
        if (String(url).includes("api.github.com")) {
          return Response.json({ tag_name: "v2.97.0" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })
    await harness.manager.refresh({ force: true })
    // checkLatestVersions runs fire-and-forget from refresh; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const byService = new Map(harness.manager.getSnapshot().services.map((s) => [s.service, s]))
    expect(byService.get("claude")).toMatchObject({ latestVersion: "2.2.0", updateAvailable: true })
    expect(byService.get("codex")).toMatchObject({ latestVersion: "0.145.0", updateAvailable: false })
    expect(byService.get("gh")).toMatchObject({ latestVersion: "2.97.0", updateAvailable: true })
    expect(byService.get("cursor")).toMatchObject({ latestVersion: null, updateAvailable: false })
  })
})

// ---------------------------------------------------------------------------
// Login flows
// ---------------------------------------------------------------------------

async function tick(ms = 5) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("gh device login flow", () => {
  test("polls until approval, then hands the token to gh", async () => {
    let signedIn = false
    const pollResults = [
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_secret_token" },
    ]
    const harness = createHarness({
      exec: (argv, opts) => {
        const joined = argv.join(" ")
        if (joined.includes("auth login --with-token")) {
          expect(opts?.stdin).toBe("gho_secret_token")
          signedIn = true
          return { code: 0, stdout: "", stderr: "" }
        }
        if (joined.includes("auth status") && signedIn) {
          return { code: 0, stdout: "Logged in to github.com account jakemny (keyring)", stderr: "" }
        }
        return signedOutExec(argv)
      },
      fetchFn: (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes("/login/device/code")) {
          return Response.json({
            device_code: "devcode",
            user_code: "D6A5-E931",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          })
        }
        if (href.includes("/login/oauth/access_token")) {
          return Response.json(pollResults.shift() ?? { error: "expired_token" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })

    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("gh")
    await tick(20)

    const gh = harness.manager.getSnapshot().services.find((s) => s.service === "gh")!
    expect(gh.authStatus).toBe("signed_in")
    expect(gh.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("gh")
    // gh auth setup-git ran after the token login.
    expect(harness.execCalls.some((call) => call.argv.join(" ").includes("auth setup-git"))).toBe(true)
    // The token never appears in any snapshot.
    expect(JSON.stringify(harness.manager.getSnapshot())).not.toContain("gho_secret_token")
  })

  test("shows the code while waiting and fails on denial", async () => {
    const waitingStates: Array<{ userCode: string | null; verificationUrl: string }> = []
    const harness = createHarness({
      exec: signedOutExec,
      fetchFn: (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes("/login/device/code")) {
          return Response.json({
            device_code: "devcode",
            user_code: "D6A5-E931",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          })
        }
        return Response.json({ error: "access_denied", error_description: "The user denied the request." })
      }) as typeof fetch,
    })
    harness.manager.onChange((snapshot) => {
      const login = snapshot.services.find((s) => s.service === "gh")!.login
      if (login.phase === "waiting_for_approval") {
        waitingStates.push({ userCode: login.userCode, verificationUrl: login.verificationUrl })
      }
    })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("gh")
    await tick(20)

    expect(waitingStates[0]).toEqual({ userCode: "D6A5-E931", verificationUrl: "https://github.com/login/device" })
    const login = harness.manager.getSnapshot().services.find((s) => s.service === "gh")!.login
    expect(login.phase).toBe("error")
    expect(login.phase === "error" ? login.message : "").toContain("denied")
  })
})

describe("git identity seeding after gh sign-in", () => {
  const GH_USER_JSON = JSON.stringify({ login: "jakemor", name: "Jake Mor", id: 5595046 })

  /** Drives the gh device flow to completion with a caller-supplied exec tail. */
  function ghHarness(options: {
    tail?: (argv: string[]) => ExecResult | undefined
    paths?: Record<string, string | null>
  }) {
    let tokenAccepted = false
    return createHarness({
      paths: options.paths,
      exec: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("auth login --with-token")) {
          tokenAccepted = true
          return { code: 0, stdout: "", stderr: "" }
        }
        if (joined.includes("auth status") && tokenAccepted) {
          return { code: 0, stdout: "Logged in to github.com account jakemor (keyring)", stderr: "" }
        }
        const tailed = options.tail?.(argv)
        return tailed ?? signedOutExec(argv)
      },
      fetchFn: (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes("/login/device/code")) {
          return Response.json({
            device_code: "devcode",
            user_code: "D6A5-E931",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          })
        }
        if (href.includes("/login/oauth/access_token")) {
          return Response.json({ access_token: "gho_secret_token" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })
  }

  /** `git config --global --get <key>` exits 1 when the key is unset. */
  function unsetIdentityTail(argv: string[]): ExecResult | undefined {
    const joined = argv.join(" ")
    if (joined.includes("config --global --get")) return { code: 1, stdout: "", stderr: "" }
    if (joined.includes("api user")) return { code: 0, stdout: GH_USER_JSON, stderr: "" }
    return undefined
  }

  const writes = (harness: ReturnType<typeof createHarness>) =>
    harness.execCalls
      .map((call) => call.argv)
      .filter((argv) => argv[0].includes("git") && !argv.includes("--get"))
      .map((argv) => argv.slice(1).join(" "))

  async function runLogin(harness: ReturnType<typeof createHarness>) {
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("gh")
    await tick(20)
  }

  test("seeds a global name and noreply email when git has no identity", async () => {
    const harness = ghHarness({ tail: unsetIdentityTail })
    await runLogin(harness)

    expect(harness.manager.getSnapshot().services.find((s) => s.service === "gh")!.authStatus).toBe(
      "signed_in"
    )
    expect(writes(harness)).toEqual([
      "config --global user.name Jake Mor",
      "config --global user.email 5595046+jakemor@users.noreply.github.com",
    ])
  })

  test("never overwrites an identity the user already configured", async () => {
    const harness = ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("--get user.name")) return { code: 0, stdout: "Existing Name\n", stderr: "" }
        if (joined.includes("--get user.email")) return { code: 0, stdout: "me@example.com\n", stderr: "" }
        if (joined.includes("api user")) return { code: 0, stdout: GH_USER_JSON, stderr: "" }
        return undefined
      },
    })
    await runLogin(harness)

    expect(writes(harness)).toEqual([])
    // Fully configured means we never even ask GitHub who the user is.
    expect(harness.execCalls.some((call) => call.argv.join(" ").includes("api user"))).toBe(false)
  })

  test("fills only the missing half of a partial identity", async () => {
    const harness = ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("--get user.name")) return { code: 0, stdout: "Existing Name\n", stderr: "" }
        if (joined.includes("--get user.email")) return { code: 1, stdout: "", stderr: "" }
        if (joined.includes("api user")) return { code: 0, stdout: GH_USER_JSON, stderr: "" }
        return undefined
      },
    })
    await runLogin(harness)

    expect(writes(harness)).toEqual([
      "config --global user.email 5595046+jakemor@users.noreply.github.com",
    ])
  })

  test("sign-in still succeeds when git is missing or the identity probe fails", async () => {
    const noGit = ghHarness({ tail: unsetIdentityTail, paths: { git: null } })
    await runLogin(noGit)
    expect(noGit.manager.getSnapshot().services.find((s) => s.service === "gh")!.authStatus).toBe(
      "signed_in"
    )
    expect(writes(noGit)).toEqual([])

    const apiDown = ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("config --global --get")) return { code: 1, stdout: "", stderr: "" }
        if (joined.includes("api user")) return { code: 1, stdout: "", stderr: "gh: offline" }
        return undefined
      },
    })
    await runLogin(apiDown)
    expect(apiDown.manager.getSnapshot().services.find((s) => s.service === "gh")!.authStatus).toBe(
      "signed_in"
    )
    expect(writes(apiDown)).toEqual([])
  })
})

describe("codex device login flow", () => {
  test("surfaces the code, then completes when the process exits 0", async () => {
    const child = new FakeChild()
    let codexSignedIn = false
    const harness = createHarness({
      exec: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("login status")) {
          return codexSignedIn
            ? { code: 0, stdout: "Logged in using ChatGPT", stderr: "" }
            : { code: 1, stdout: "", stderr: "Not logged in" }
        }
        return signedOutExec(argv)
      },
      spawnStreaming: (argv) => {
        expect(argv.slice(1)).toEqual(["login", "--device-auth"])
        return child
      },
    })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("codex")
    child.emit(CODEX_DEVICE_FIXTURE)
    await tick()

    const waiting = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!.login
    expect(waiting).toMatchObject({
      phase: "waiting_for_approval",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "O0A7-WTAU3",
    })

    codexSignedIn = true
    child.exit(0)
    await tick(20)
    const codex = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!
    expect(codex.authStatus).toBe("signed_in")
    expect(codex.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("codex")
  })

  test("failure includes the workspace-settings hint", async () => {
    const child = new FakeChild()
    const harness = createHarness({ exec: signedOutExec, spawnStreaming: () => child })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("codex")
    child.emit("Error: device code authorization is not enabled for your workspace\n")
    child.exit(1)
    await tick(20)
    const login = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!.login
    expect(login.phase).toBe("error")
    expect(login.phase === "error" ? login.hint : null).toContain("ChatGPT security settings")
  })

  test("a config-load failure points at config.toml instead of device-auth settings", async () => {
    const child = new FakeChild()
    const harness = createHarness({ exec: signedOutExec, spawnStreaming: () => child })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("codex")
    child.emit("Error loading configuration: /Users/friend/.codex/config.toml:4:16: unknown variant `priority`, expected `fast` or `flex`\n")
    child.exit(1)
    await tick(20)
    const login = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!.login
    expect(login.phase).toBe("error")
    const hint = login.phase === "error" ? login.hint : null
    expect(hint).toContain("config.toml")
    expect(hint).not.toContain("ChatGPT security settings")
  })
})

describe("cursor login flow", () => {
  test("passes NO_OPEN_BROWSER and completes on exit 0", async () => {
    const child = new FakeChild()
    let cursorSignedIn = false
    let sawEnv: Record<string, string> | undefined
    const harness = createHarness({
      exec: (argv) => {
        if (argv.join(" ").includes("cursor-agent status") || (argv[0].includes("cursor-agent") && argv[1] === "status")) {
          return cursorSignedIn
            ? { code: 0, stdout: "Logged in as jake@x.com", stderr: "" }
            : { code: 0, stdout: "Not logged in", stderr: "" }
        }
        return signedOutExec(argv)
      },
      spawnStreaming: (_argv, opts) => {
        sawEnv = opts?.env
        return child
      },
    })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("cursor")
    expect(sawEnv?.NO_OPEN_BROWSER).toBe("1")
    child.emit(CURSOR_LOGIN_FIXTURE)
    await tick()

    const waiting = harness.manager.getSnapshot().services.find((s) => s.service === "cursor")!.login
    expect(waiting.phase).toBe("waiting_for_approval")
    expect(waiting.phase === "waiting_for_approval" ? waiting.verificationUrl : "").toContain("cursor.com/loginDeepControl")

    cursorSignedIn = true
    child.exit(0)
    await tick(20)
    expect(harness.manager.getSnapshot().services.find((s) => s.service === "cursor")!.authStatus).toBe("signed_in")
    expect(harness.signedIn).toContain("cursor")
  })
})

describe("claude login flow", () => {
  test("extracts the oauth url, accepts the pasted code, completes after exit", async () => {
    const child = new FakeChild()
    let claudeSignedIn = false
    const harness = createHarness({
      exec: (argv) => {
        if (argv.join(" ").includes("auth status --json")) {
          return claudeSignedIn
            ? { code: 0, stdout: '{"loggedIn": true, "email": "jake@example.com"}', stderr: "" }
            : { code: 0, stdout: '{"loggedIn": false}', stderr: "" }
        }
        return signedOutExec(argv)
      },
      spawnPty: (argv) => {
        expect(argv.slice(1)).toEqual(["auth", "login"])
        return child
      },
    })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("claude")
    child.emit(CLAUDE_LOGIN_FIXTURE)
    await tick()

    const waiting = harness.manager.getSnapshot().services.find((s) => s.service === "claude")!.login
    expect(waiting).toMatchObject({ phase: "waiting_for_code_entry", verificationUrl: CLAUDE_OAUTH_URL })

    harness.manager.submitLoginCode("claude", "  abc123#xyz  ")
    expect(child.written).toEqual(["abc123#xyz\r"])
    expect(harness.manager.getSnapshot().services.find((s) => s.service === "claude")!.login.phase).toBe("finishing")

    claudeSignedIn = true
    child.exit(0)
    await tick(20)
    const claude = harness.manager.getSnapshot().services.find((s) => s.service === "claude")!
    expect(claude.authStatus).toBe("signed_in")
    expect(claude.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("claude")
  })

  test("submitLoginCode requires an active waiting flow", async () => {
    const harness = createHarness({ exec: signedOutExec })
    await harness.manager.refresh({ force: true })
    expect(() => harness.manager.submitLoginCode("claude", "code")).toThrow()
  })
})

describe("flow lifecycle", () => {
  test("cancel kills the child and resets to idle", async () => {
    const child = new FakeChild()
    const harness = createHarness({ exec: signedOutExec, spawnStreaming: () => child })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("codex")
    harness.manager.cancelLogin("codex")
    await tick()
    expect(child.killed).toBe(true)
    expect(harness.manager.getSnapshot().services.find((s) => s.service === "codex")!.login.phase).toBe("idle")
  })

  test("starting a new flow supersedes the previous one", async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    const children = [first, second]
    const harness = createHarness({ exec: signedOutExec, spawnStreaming: () => children.shift()! })
    await harness.manager.refresh({ force: true })
    harness.manager.startLogin("codex")
    harness.manager.startLogin("codex")
    await tick()
    expect(first.killed).toBe(true)
    expect(second.killed).toBe(false)
  })

  test("startLogin throws when the CLI is missing", async () => {
    const harness = createHarness({ paths: { codex: null }, exec: signedOutExec })
    await harness.manager.refresh({ force: true })
    expect(() => harness.manager.startLogin("codex")).toThrow(/not installed/i)
  })
})

// ---------------------------------------------------------------------------
// OpenRouter PKCE
// ---------------------------------------------------------------------------

describe("openrouter oauth", () => {
  test("start returns an auth url whose challenge matches the verifier sent at exchange", async () => {
    let exchangeBody: Record<string, string> | null = null
    const harness = createHarness({
      exec: signedOutExec,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("openrouter.ai/api/v1/auth/keys")) {
          exchangeBody = JSON.parse(String(init?.body)) as Record<string, string>
          return Response.json({ key: "sk-or-v1-new-key" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })

    const { authUrl } = harness.manager.startOpenRouterAuth("http://localhost:3210/oauth/openrouter/callback")
    const parsed = new URL(authUrl)
    expect(parsed.origin).toBe("https://openrouter.ai")
    expect(parsed.searchParams.get("callback_url")).toBe("http://localhost:3210/oauth/openrouter/callback")
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")

    const snapshot = await harness.manager.exchangeOpenRouterCode("auth-code-123")
    expect(exchangeBody!.code).toBe("auth-code-123")
    expect(parsed.searchParams.get("code_challenge")).toBe(pkceChallengeS256(exchangeBody!.code_verifier))
    expect(snapshot.provider).toBe("openrouter")
    expect(snapshot.apiKey).toBe("sk-or-v1-new-key")
    expect(harness.getLlmProvider().apiKey).toBe("sk-or-v1-new-key")
    expect(harness.signedIn).toContain("openrouter")

    const openrouter = harness.manager.getSnapshot().services.find((s) => s.service === "openrouter")!
    expect(openrouter.authStatus).toBe("signed_in")
    // The key never leaks into the auth snapshot.
    expect(JSON.stringify(harness.manager.getSnapshot())).not.toContain("sk-or-v1-new-key")
  })

  test("exchange without a pending flow fails", async () => {
    const harness = createHarness({ exec: signedOutExec })
    await expect(harness.manager.exchangeOpenRouterCode("code")).rejects.toThrow(/no openrouter sign-in/i)
  })
})

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe("install", () => {
  test("installs claude via the native installer and re-probes", async () => {
    let installed = false
    const harness = createHarness({
      paths: { claude: null },
      exec: (argv) => {
        const joined = argv.join(" ")
        if (argv[0] === "sh" && joined.includes("curl -fsSL https://claude.ai/install.sh | bash")) {
          installed = true
          return { code: 0, stdout: "installed", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    await harness.manager.refresh({ force: true })
    expect(harness.manager.getSnapshot().services.find((s) => s.service === "claude")!.authStatus).toBe("not_installed")

    harness.setPath("claude", null) // still missing until installer runs
    const installPromise = harness.manager.install("claude")
    harness.setPath("claude", "/usr/local/bin/claude")
    await installPromise

    expect(installed).toBe(true)
    const claude = harness.manager.getSnapshot().services.find((s) => s.service === "claude")!
    expect(claude.installState).toBe("idle")
    expect(claude.installed).toBe(true)
    expect(claude.authStatus).toBe("signed_out")
  })

  test("updates an existing claude via self-update with a native-installer fallback", async () => {
    let command = ""
    const harness = createHarness({
      exec: (argv) => {
        if (argv[0] === "sh") {
          command = argv[2] ?? ""
          return { code: 0, stdout: "updated", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    await harness.manager.refresh({ force: true })
    await harness.manager.install("claude")
    // Self-update first (native installs handle themselves), then the
    // installer as fallback — npm-managed installs on root-owned prefixes
    // fail the first leg and migrate to ~/.local/bin via the second.
    expect(command).toBe("'/usr/local/bin/claude' update || (curl -fsSL https://claude.ai/install.sh | bash)")
  })

  test("installs codex via npm and re-probes", async () => {
    let installed = false
    const harness = createHarness({
      paths: { codex: null },
      exec: (argv) => {
        const joined = argv.join(" ")
        if (argv[0] === "sh" && joined.includes("npm install -g @openai/codex")) {
          installed = true
          return { code: 0, stdout: "added 3 packages", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    await harness.manager.refresh({ force: true })
    expect(harness.manager.getSnapshot().services.find((s) => s.service === "codex")!.authStatus).toBe("not_installed")

    harness.setPath("codex", null) // still missing until installer runs
    const installPromise = harness.manager.install("codex")
    harness.setPath("codex", "/usr/local/bin/codex")
    await installPromise

    expect(installed).toBe(true)
    const codex = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!
    expect(codex.installState).toBe("idle")
    expect(codex.installed).toBe(true)
    expect(codex.authStatus).toBe("signed_out")
  })

  test("install failure surfaces the error output", async () => {
    const harness = createHarness({
      exec: (argv) => {
        if (argv[0] === "sh") return { code: 1, stdout: "", stderr: "EACCES: permission denied" }
        return signedOutExec(argv)
      },
    })
    await harness.manager.refresh({ force: true })
    await harness.manager.install("codex")
    const codex = harness.manager.getSnapshot().services.find((s) => s.service === "codex")!
    expect(codex.installState).toBe("error")
    expect(codex.installError).toContain("EACCES")
  })

  test("gh install on macOS without brew fails with a hint", async () => {
    const harness = createHarness({
      paths: { gh: null, brew: null },
      exec: signedOutExec,
      platform: "darwin",
    })
    await harness.manager.refresh({ force: true })
    await harness.manager.install("gh")
    const gh = harness.manager.getSnapshot().services.find((s) => s.service === "gh")!
    expect(gh.installState).toBe("error")
    expect(gh.installError).toContain("Homebrew")
  })

  test("cursor update runs the CLI's own updater when installed", async () => {
    const harness = createHarness({ exec: signedOutExec })
    await harness.manager.refresh({ force: true })
    await harness.manager.install("cursor")
    const installCall = harness.execCalls.find((call) => call.argv[0] === "sh")
    expect(installCall?.argv[2]).toContain("cursor-agent")
    expect(installCall?.argv[2]).toContain("update")
  })
})
