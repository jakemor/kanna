import { describe, expect, test } from "bun:test"
import { type Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Result, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AuthServiceId, LlmProviderSnapshot, ProviderAuthSnapshot } from "../shared/types"
import { Analytics } from "./analytics"
import { makeFakeAnalytics } from "./analytics.fake"
import { runTest, TestPlatform } from "./effect/testing"
import { CommandSpawnError } from "./process-utils"
import {
  execCommand,
  LatestVersionError,
  type LoginChild,
  ProviderAuth,
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
  spawnPtyCommand,
  spawnStreamingCommand,
  stripAnsi,
  type ExecResult,
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
    expect(parseClaudeAuthStatus('{"loggedIn": true, "oauthAccount": {"emailAddress": "jake@example.com"}}'))
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
// Service harness
// ---------------------------------------------------------------------------

/** A login CLI the test drives: what it prints, when it exits, whether it was killed. */
class FakeChild {
  private readonly queue = Effect.runSync(Queue.unbounded<string, Cause.Done>())
  private readonly exitCode = Effect.runSync(Deferred.make<number>())
  private exitedAlready = false
  killed = false
  written: string[] = []

  readonly handle: LoginChild = {
    output: Stream.fromQueue(this.queue),
    exited: Deferred.await(this.exitCode),
    write: (data) => Effect.sync(() => {
      this.written.push(data)
    }),
  }

  emit(chunk: string) {
    Queue.offerUnsafe(this.queue, chunk)
  }

  exit(code: number) {
    if (this.exitedAlready) return
    this.exitedAlready = true
    Queue.endUnsafe(this.queue)
    Deferred.doneUnsafe(this.exitCode, Exit.succeed(code))
  }

  kill() {
    this.killed = true
    this.exit(143)
  }

  /** What the real spawn's release does: kill it unless it already exited. */
  release() {
    if (!this.exitedAlready) this.kill()
  }
}

/** Spawn `child` in the caller's scope, killed on release like a real process. */
const spawned = (child: FakeChild): Effect.Effect<LoginChild, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.succeed(child), (spawnedChild) => Effect.sync(() => spawnedChild.release())).pipe(
    Effect.map((spawnedChild) => spawnedChild.handle),
  )

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
  /** A command that can't start: the spawn error's message, or null to run it. */
  spawnFails?: (argv: ReadonlyArray<string>) => string | null
  spawnStreaming?: (argv: ReadonlyArray<string>, opts?: { env?: Record<string, string> }) => FakeChild
  spawnPty?: (argv: ReadonlyArray<string>) => FakeChild
  fetchFn?: typeof fetch
  llmProvider?: LlmProviderSnapshot
  fetchLatestNpmVersion?: (pkg: string) => Promise<string>
  platform?: NodeJS.Platform
  claudeMinimumVersion?: string
  /** Files that exist and are executable (npm or bun beside a CLI). */
  executables?: string[]
}

/**
 * The real `ProviderAuth` layer over fake processes, network and files,
 * built in the test's scope.
 */
const makeHarness = Effect.fn("ProviderAuthTest.harness")(function* (options: HarnessOptions = {}) {
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
  const { analytics, events } = makeFakeAnalytics()
  let llmProvider = options.llmProvider ?? llmSnapshot()

  const layer = ProviderAuth.layer({
    exec: (argv, opts) => Effect.suspend(() => {
      execCalls.push({ argv: [...argv], stdin: opts?.stdin })
      const spawnFailure = options.spawnFails?.(argv)
      if (spawnFailure) {
        return Effect.fail(new CommandSpawnError({ command: argv[0] ?? "", message: spawnFailure, cause: null }))
      }
      const result = options.exec ? options.exec([...argv], opts) : { code: 0, stdout: "", stderr: "" }
      return result instanceof Promise ? Effect.promise(() => result) : Effect.succeed(result)
    }),
    spawnStreaming: (argv, opts) => Effect.suspend(() => spawned((options.spawnStreaming ?? (() => new FakeChild()))(argv, opts))),
    spawnPty: (argv) => Effect.suspend(() => spawned((options.spawnPty ?? (() => new FakeChild()))(argv))),
    readLlmProvider: Effect.sync(() => llmProvider),
    writeLlmProvider: (value) => Effect.sync(() => {
      llmProvider = llmSnapshot({
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
        faveModels: value.faveModels ?? [],
        enabled: value.apiKey.length > 0,
      })
      return llmProvider
    }),
    fetch: options.fetchFn ?? ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    fetchLatestNpmVersion: options.fetchLatestNpmVersion
      ? (packageName) => Effect.tryPromise({
        try: () => options.fetchLatestNpmVersion!(packageName),
        catch: (cause) => new LatestVersionError({ packageName, cause }),
      })
      : undefined,
    resolveCommandPath: (command) => Effect.sync(() => paths[command] ?? null),
    isExecutable: (filePath) => Effect.succeed((options.executables ?? []).includes(filePath)),
    // Below the fake CLI's 2.1.218; the floor has its own test.
    claudeMinimumVersion: options.claudeMinimumVersion ?? "2.1.0",
    onSignedIn: (service) => Effect.sync(() => {
      signedIn.push(service)
    }),
    platform: options.platform ?? "darwin",
  }).pipe(Layer.provide(Layer.succeed(Analytics, analytics)))

  const auth = Context.get(yield* Layer.build(layer), ProviderAuth)
  return {
    auth,
    execCalls,
    signedIn,
    events,
    getLlmProvider: () => llmProvider,
    service: (service: AuthServiceId) =>
      auth.snapshot.pipe(Effect.map((snapshot) => snapshot.services.find((entry) => entry.service === service)!)),
    byService: auth.snapshot.pipe(
      Effect.map((snapshot) => new Map(snapshot.services.map((entry) => [entry.service, entry] as const))),
    ),
    setPath: (command: string, value: string | null) => {
      paths[command] = value
    },
    /** Collects every snapshot pushed on `changes` from now on. */
    recordChanges: Effect.gen(function* () {
      const snapshots: ProviderAuthSnapshot[] = []
      yield* auth.changes.pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => {
          snapshots.push(snapshot)
        })),
        Effect.forkScoped({ startImmediately: true }),
      )
      return snapshots
    }),
  }
})

type Harness = Effect.Success<ReturnType<typeof makeHarness>>

/** A provider-auth test body: scoped, with the platform, on a test clock. */
function authTest<A, E>(body: Effect.Effect<A, E, Layer.Success<typeof TestPlatform> | Scope.Scope | TestClock.TestClock>) {
  return runTest(body.pipe(Effect.provide(TestClock.layer())))
}

/** Real time, for the fake processes and network to answer. */
const tick = (ms = 5) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/**
 * Let the gh device flow poll: each round moves the test clock past the poll
 * interval, then lets the fake network answer.
 */
const pollRounds = (rounds = 6) => Effect.gen(function* () {
  for (let round = 0; round < rounds; round++) {
    yield* TestClock.adjust("10 seconds")
    yield* tick(10)
  }
  yield* tick(20)
})

function expectFailure(result: Result.Result<unknown, { readonly message: string }>, pattern: string | RegExp) {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.message).toMatch(pattern)
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

describe("ProviderAuth probing", () => {
  test("reports not_installed when the binary is missing", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      paths: { claude: null, codex: null, "cursor-agent": null, grok: null, gh: null },
    })
    yield* harness.auth.refresh({ force: true })
    const byService = yield* harness.byService
    for (const service of ["claude", "codex", "cursor", "grok", "gh"] as const) {
      const entry = byService.get(service)!
      expect(entry.authStatus).toBe("not_installed")
      expect(entry.installed).toBe(false)
    }
  })))

  test("parses versions and signed-out statuses", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    yield* harness.auth.refresh({ force: true })
    const byService = yield* harness.byService
    expect(byService.get("claude")).toMatchObject({ installed: true, version: "2.1.218", authStatus: "signed_out" })
    expect(byService.get("codex")).toMatchObject({ version: "0.145.0", authStatus: "signed_out" })
    expect(byService.get("cursor")).toMatchObject({ version: "2026.07.23-e383d2b", authStatus: "signed_out" })
    expect(byService.get("grok")).toMatchObject({ version: "1.0.13", authStatus: "signed_out" })
    expect(byService.get("gh")).toMatchObject({ version: "2.96.0", authStatus: "signed_out" })
    expect(byService.get("openrouter")).toMatchObject({ installed: true, authStatus: "signed_out" })
  })))

  test("reports signed-in statuses with accounts", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    const byService = yield* harness.byService
    expect(byService.get("claude")).toMatchObject({ authStatus: "signed_in", account: "jake@example.com" })
    expect(byService.get("codex")).toMatchObject({ authStatus: "signed_in", account: "ChatGPT" })
    expect(byService.get("cursor")).toMatchObject({ authStatus: "signed_in", account: "jake@x.com" })
    expect(byService.get("grok")).toMatchObject({ authStatus: "signed_in", account: "grok.com" })
    expect(byService.get("gh")).toMatchObject({ authStatus: "signed_in", account: "jakemny" })
    expect(byService.get("openrouter")).toMatchObject({ authStatus: "signed_in" })
  })))

  test("a CLI that can't be started reads as an error with the reason", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      exec: signedOutExec,
      spawnFails: (argv) => argv[0]!.includes("codex") ? "EACCES: permission denied" : null,
    })
    yield* harness.auth.refresh({ force: true })
    const codex = yield* harness.service("codex")
    expect(codex.authStatus).toBe("error")
    expect(codex.statusDetail).toBe("EACCES: permission denied")
    expect((yield* harness.service("gh")).authStatus).toBe("signed_out")
  })))

  test("an old Claude CLI that rejects `auth status --json` reads as outdated, not a raw error", () => authTest(Effect.gen(function* () {
    // Claude Code v1.0.x predates the JSON auth status; it exits non-zero
    // with "error: unknown option '--json'".
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    const claude = yield* harness.service("claude")
    expect(claude.authStatus).toBe("outdated")
    expect(claude.statusDetail).toContain("too old")
    expect(claude.statusDetail).toContain("1.0.77")
    expect(claude.statusDetail).not.toContain("unknown option")

    // Updating is the only way forward — login refuses until then.
    expectFailure(yield* Effect.result(harness.auth.startLogin("claude")), "too old")
  })))

  test("a Claude CLI older than the Agent SDK's pairing reads as outdated", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      claudeMinimumVersion: "2.1.277",
      exec: (argv) => {
        if (argv[0].includes("claude") && argv.join(" ").includes("auth status --json")) {
          return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "jake@example.com" }), stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    yield* harness.auth.refresh({ force: true })
    const claude = yield* harness.service("claude")
    expect(claude.authStatus).toBe("outdated")
    expect(claude.statusDetail).toContain("2.1.218")
    expect(claude.statusDetail).toContain("2.1.277")
  })))

  test("a Claude CLI at the pairing version is fine", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ claudeMinimumVersion: "2.1.218", exec: signedOutExec })
    yield* harness.auth.refresh({ force: true })
    expect((yield* harness.service("claude")).authStatus).toBe("signed_out")
  })))

  test("non-forced refresh is TTL-coalesced", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    yield* harness.auth.refresh()
    const callsAfterFirst = harness.execCalls.length
    yield* harness.auth.refresh()
    expect(harness.execCalls.length).toBe(callsAfterFirst)
    yield* TestClock.adjust("61 seconds")
    yield* harness.auth.refresh()
    expect(harness.execCalls.length).toBeGreaterThan(callsAfterFirst)
  })))

  test("concurrent refreshes share one round of probes", () => authTest(Effect.gen(function* () {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = yield* makeHarness({
      exec: async (argv) => {
        await gate
        return signedOutExec(argv)
      },
    })
    const first = yield* Effect.forkChild(harness.auth.refresh({ force: true }), { startImmediately: true })
    const second = yield* Effect.forkChild(harness.auth.refresh({ force: true }), { startImmediately: true })
    yield* tick()
    release()
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    const versionProbes = harness.execCalls.filter((call) => call.argv.join(" ").endsWith("--version"))
    expect(versionProbes).toHaveLength(5)
  })))

  test("update availability from npm and gh release feeds", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    // The latest-version check runs in the background after a refresh.
    yield* tick(10)
    const byService = yield* harness.byService
    expect(byService.get("claude")).toMatchObject({ latestVersion: "2.2.0", updateAvailable: true })
    expect(byService.get("codex")).toMatchObject({ latestVersion: "0.145.0", updateAvailable: false })
    expect(byService.get("gh")).toMatchObject({ latestVersion: "2.97.0", updateAvailable: true })
    expect(byService.get("cursor")).toMatchObject({ latestVersion: null, updateAvailable: false })
  })))

  test("changes pushes each snapshot after the current one", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    const snapshots = yield* harness.recordChanges
    yield* harness.auth.probeService("gh")
    yield* tick()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.services.find((entry) => entry.service === "gh")!.version).toBe("2.96.0")
  })))
})

// ---------------------------------------------------------------------------
// Login flows
// ---------------------------------------------------------------------------

const ghDeviceCodeResponse = () => Response.json({
  device_code: "devcode",
  user_code: "D6A5-E931",
  verification_uri: "https://github.com/login/device",
  interval: 5,
  expires_in: 900,
})

describe("gh device login flow", () => {
  test("polls until approval, then hands the token to gh", () => authTest(Effect.gen(function* () {
    let signedIn = false
    const pollResults = [
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_secret_token" },
    ]
    const harness = yield* makeHarness({
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
        if (href.includes("/login/device/code")) return ghDeviceCodeResponse()
        if (href.includes("/login/oauth/access_token")) {
          return Response.json(pollResults.shift() ?? { error: "expired_token" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })

    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("gh")
    yield* tick()
    yield* pollRounds()

    const gh = yield* harness.service("gh")
    expect(gh.authStatus).toBe("signed_in")
    expect(gh.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("gh")
    expect(harness.events).toContain("auth_login_succeeded")
    // gh auth setup-git ran after the token login.
    expect(harness.execCalls.some((call) => call.argv.join(" ").includes("auth setup-git"))).toBe(true)
    // The token never appears in any snapshot.
    expect(JSON.stringify(yield* harness.auth.snapshot)).not.toContain("gho_secret_token")
  })))

  test("shows the code while waiting and fails on denial", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      exec: signedOutExec,
      fetchFn: (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes("/login/device/code")) return ghDeviceCodeResponse()
        return Response.json({ error: "access_denied", error_description: "The user denied the request." })
      }) as typeof fetch,
    })
    const snapshots = yield* harness.recordChanges
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("gh")
    yield* tick()
    yield* pollRounds(1)

    const waitingStates = snapshots
      .map((snapshot) => snapshot.services.find((entry) => entry.service === "gh")!.login)
      .flatMap((login) => login.phase === "waiting_for_approval" ? [{ userCode: login.userCode, verificationUrl: login.verificationUrl }] : [])
    expect(waitingStates[0]).toEqual({ userCode: "D6A5-E931", verificationUrl: "https://github.com/login/device" })
    const login = (yield* harness.service("gh")).login
    expect(login.phase).toBe("error")
    expect(login.phase === "error" ? login.message : "").toContain("denied")
    expect(harness.events).toContain("auth_login_failed")
  })))

  test("a failed device-code request fails the flow with the status", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      exec: signedOutExec,
      fetchFn: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("gh")
    yield* tick(20)
    const login = (yield* harness.service("gh")).login
    expect(login).toEqual({ phase: "error", message: "GitHub device authorization failed (503).", hint: null })
  })))
})

describe("git identity seeding after gh sign-in", () => {
  const GH_USER_JSON = JSON.stringify({ login: "jakemor", name: "Jake Mor", id: 5595046 })

  /** Drives the gh device flow to completion with a caller-supplied exec tail. */
  function ghHarness(options: {
    tail?: (argv: string[]) => ExecResult | undefined
    paths?: Record<string, string | null>
  }) {
    let tokenAccepted = false
    return makeHarness({
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
        if (href.includes("/login/device/code")) return ghDeviceCodeResponse()
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

  const writes = (harness: Harness) =>
    harness.execCalls
      .map((call) => call.argv)
      .filter((argv) => argv[0].includes("git") && !argv.includes("--get"))
      .map((argv) => argv.slice(1).join(" "))

  const runLogin = (harness: Harness) => Effect.gen(function* () {
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("gh")
    yield* tick()
    yield* pollRounds(2)
  })

  test("seeds a global name and noreply email when git has no identity", () => authTest(Effect.gen(function* () {
    const harness = yield* ghHarness({ tail: unsetIdentityTail })
    yield* runLogin(harness)

    expect((yield* harness.service("gh")).authStatus).toBe("signed_in")
    expect(writes(harness)).toEqual([
      "config --global user.name Jake Mor",
      "config --global user.email 5595046+jakemor@users.noreply.github.com",
    ])
  })))

  test("never overwrites an identity the user already configured", () => authTest(Effect.gen(function* () {
    const harness = yield* ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("--get user.name")) return { code: 0, stdout: "Existing Name\n", stderr: "" }
        if (joined.includes("--get user.email")) return { code: 0, stdout: "me@example.com\n", stderr: "" }
        if (joined.includes("api user")) return { code: 0, stdout: GH_USER_JSON, stderr: "" }
        return undefined
      },
    })
    yield* runLogin(harness)

    expect(writes(harness)).toEqual([])
    // Fully configured means we never even ask GitHub who the user is.
    expect(harness.execCalls.some((call) => call.argv.join(" ").includes("api user"))).toBe(false)
  })))

  test("fills only the missing half of a partial identity", () => authTest(Effect.gen(function* () {
    const harness = yield* ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("--get user.name")) return { code: 0, stdout: "Existing Name\n", stderr: "" }
        if (joined.includes("--get user.email")) return { code: 1, stdout: "", stderr: "" }
        if (joined.includes("api user")) return { code: 0, stdout: GH_USER_JSON, stderr: "" }
        return undefined
      },
    })
    yield* runLogin(harness)

    expect(writes(harness)).toEqual([
      "config --global user.email 5595046+jakemor@users.noreply.github.com",
    ])
  })))

  test("sign-in still succeeds when git is missing or the identity probe fails", () => authTest(Effect.gen(function* () {
    const noGit = yield* ghHarness({ tail: unsetIdentityTail, paths: { git: null } })
    yield* runLogin(noGit)
    expect((yield* noGit.service("gh")).authStatus).toBe("signed_in")
    expect(writes(noGit)).toEqual([])

    const apiDown = yield* ghHarness({
      tail: (argv) => {
        const joined = argv.join(" ")
        if (joined.includes("config --global --get")) return { code: 1, stdout: "", stderr: "" }
        if (joined.includes("api user")) return { code: 1, stdout: "", stderr: "gh: offline" }
        return undefined
      },
    })
    yield* runLogin(apiDown)
    expect((yield* apiDown.service("gh")).authStatus).toBe("signed_in")
    expect(writes(apiDown)).toEqual([])
  })))
})

describe("codex device login flow", () => {
  test("surfaces the code, then completes when the process exits 0", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    let codexSignedIn = false
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    child.emit(CODEX_DEVICE_FIXTURE)
    yield* tick()

    expect((yield* harness.service("codex")).login).toMatchObject({
      phase: "waiting_for_approval",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "O0A7-WTAU3",
    })

    codexSignedIn = true
    child.exit(0)
    yield* tick(20)
    const codex = yield* harness.service("codex")
    expect(codex.authStatus).toBe("signed_in")
    expect(codex.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("codex")
  })))

  test("failure includes the workspace-settings hint", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    child.emit("Error: device code authorization is not enabled for your workspace\n")
    child.exit(1)
    yield* tick(20)
    const login = (yield* harness.service("codex")).login
    expect(login.phase).toBe("error")
    expect(login.phase === "error" ? login.hint : null).toContain("ChatGPT security settings")
    expect(login.phase === "error" ? login.message : null).toContain("device code authorization is not enabled")
  })))

  test("a config-load failure points at config.toml instead of device-auth settings", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    child.emit("Error loading configuration: /Users/friend/.codex/config.toml:4:16: unknown variant `priority`, expected `fast` or `flex`\n")
    child.exit(1)
    yield* tick(20)
    const login = (yield* harness.service("codex")).login
    expect(login.phase).toBe("error")
    const hint = login.phase === "error" ? login.hint : null
    expect(hint).toContain("config.toml")
    expect(hint).not.toContain("ChatGPT security settings")
  })))

  test("a CLI that exits 0 but still reads signed out is an error", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    child.exit(0)
    yield* tick(20)
    expect((yield* harness.service("codex")).login).toEqual({
      phase: "error",
      message: "Sign-in finished but the CLI still reports signed out.",
      hint: null,
    })
  })))
})

describe("cursor login flow", () => {
  test("passes NO_OPEN_BROWSER and completes on exit 0", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    let cursorSignedIn = false
    let sawEnv: Record<string, string> | undefined
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("cursor")
    expect(sawEnv?.NO_OPEN_BROWSER).toBe("1")
    child.emit(CURSOR_LOGIN_FIXTURE)
    yield* tick()

    const waiting = (yield* harness.service("cursor")).login
    expect(waiting.phase).toBe("waiting_for_approval")
    expect(waiting.phase === "waiting_for_approval" ? waiting.verificationUrl : "").toContain("cursor.com/loginDeepControl")

    cursorSignedIn = true
    child.exit(0)
    yield* tick(20)
    expect((yield* harness.service("cursor")).authStatus).toBe("signed_in")
    expect(harness.signedIn).toContain("cursor")
  })))
})

describe("claude login flow", () => {
  test("extracts the oauth url, accepts the pasted code, completes after exit", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    let claudeSignedIn = false
    const harness = yield* makeHarness({
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
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("claude")
    child.emit(CLAUDE_LOGIN_FIXTURE)
    yield* tick()

    expect((yield* harness.service("claude")).login).toMatchObject({
      phase: "waiting_for_code_entry",
      verificationUrl: CLAUDE_OAUTH_URL,
    })

    yield* harness.auth.submitLoginCode("claude", "  abc123#xyz  ")
    expect(child.written).toEqual(["abc123#xyz\r"])
    expect((yield* harness.service("claude")).login.phase).toBe("finishing")

    claudeSignedIn = true
    child.exit(0)
    yield* tick(20)
    const claude = yield* harness.service("claude")
    expect(claude.authStatus).toBe("signed_in")
    expect(claude.login.phase).toBe("idle")
    expect(harness.signedIn).toContain("claude")
  })))

  test("submitLoginCode requires an active waiting flow", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    yield* harness.auth.refresh({ force: true })
    expectFailure(yield* Effect.result(harness.auth.submitLoginCode("claude", "code")), "No sign-in flow is waiting for a code.")
  })))

  test("presses Enter for a menu, then gives up when no link appears", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnPty: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("claude")
    child.emit("Select login method:\n")
    yield* tick()

    yield* TestClock.adjust("5 seconds")
    expect(child.written).toEqual(["\r"])

    yield* TestClock.adjust("25 seconds")
    yield* tick()
    const login = (yield* harness.service("claude")).login
    expect(login.phase).toBe("error")
    expect(login.phase === "error" ? login.message : "").toContain("did not produce a login link: Select login method:")
    expect(login.phase === "error" ? login.hint : "").toContain("Keychain")
    expect(child.killed).toBe(true)
  })))

  test("a CLI that lingers after a good code is finished by the safety-net probe", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    let claudeSignedIn = false
    const harness = yield* makeHarness({
      exec: (argv) => {
        if (argv.join(" ").includes("auth status --json")) {
          return { code: 0, stdout: JSON.stringify({ loggedIn: claudeSignedIn }), stderr: "" }
        }
        return signedOutExec(argv)
      },
      spawnPty: () => child,
    })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("claude")
    child.emit(CLAUDE_LOGIN_FIXTURE)
    yield* tick()
    yield* harness.auth.submitLoginCode("claude", "abc")
    claudeSignedIn = true

    yield* TestClock.adjust("15 seconds")
    yield* tick(20)
    expect((yield* harness.service("claude")).login.phase).toBe("idle")
    expect(harness.signedIn).toContain("claude")
    expect(child.killed).toBe(true)
  })))
})

describe("flow lifecycle", () => {
  test("cancel kills the child and resets to idle", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    yield* harness.auth.cancelLogin("codex")
    yield* tick()
    expect(child.killed).toBe(true)
    expect((yield* harness.service("codex")).login.phase).toBe("idle")
  })))

  test("starting a new flow supersedes the previous one", () => authTest(Effect.gen(function* () {
    const first = new FakeChild()
    const second = new FakeChild()
    const children = [first, second]
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => children.shift()! })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    yield* harness.auth.startLogin("codex")
    yield* tick()
    expect(first.killed).toBe(true)
    expect(second.killed).toBe(false)
  })))

  test("startLogin fails when the CLI is missing", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ paths: { codex: null }, exec: signedOutExec })
    yield* harness.auth.refresh({ force: true })
    expectFailure(yield* Effect.result(harness.auth.startLogin("codex")), /not installed/i)
  })))

  test("a flow that never resolves times out and its CLI is killed", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.startLogin("codex")
    yield* TestClock.adjust("16 minutes")
    yield* tick()
    expect((yield* harness.service("codex")).login).toEqual({ phase: "error", message: "Sign-in timed out.", hint: null })
    expect(child.killed).toBe(true)
  })))

  test("releasing the layer kills a running sign-in CLI", () => authTest(Effect.gen(function* () {
    const child = new FakeChild()
    yield* Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeHarness({ exec: signedOutExec, spawnStreaming: () => child })
      yield* harness.auth.refresh({ force: true })
      yield* harness.auth.startLogin("codex")
      expect(child.killed).toBe(false)
    }))
    expect(child.killed).toBe(true)
  })))
})

// ---------------------------------------------------------------------------
// OpenRouter PKCE
// ---------------------------------------------------------------------------

describe("openrouter oauth", () => {
  test("start returns an auth url whose challenge matches the verifier sent at exchange", () => authTest(Effect.gen(function* () {
    let exchangeBody: Record<string, string> | null = null
    const harness = yield* makeHarness({
      exec: signedOutExec,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("openrouter.ai/api/v1/auth/keys")) {
          exchangeBody = JSON.parse(String(init?.body)) as Record<string, string>
          return Response.json({ key: "sk-or-v1-new-key" })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })

    const { authUrl } = yield* harness.auth.startOpenRouterAuth("http://localhost:3210/oauth/openrouter/callback")
    const parsed = new URL(authUrl)
    expect(parsed.origin).toBe("https://openrouter.ai")
    expect(parsed.searchParams.get("callback_url")).toBe("http://localhost:3210/oauth/openrouter/callback")
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")

    const snapshot = yield* harness.auth.exchangeOpenRouterCode("auth-code-123")
    const body = exchangeBody as Record<string, string> | null
    expect(body!.code).toBe("auth-code-123")
    expect(parsed.searchParams.get("code_challenge")).toBe(pkceChallengeS256(body!.code_verifier!))
    expect(snapshot.provider).toBe("openrouter")
    expect(snapshot.apiKey).toBe("sk-or-v1-new-key")
    expect(harness.getLlmProvider().apiKey).toBe("sk-or-v1-new-key")
    expect(harness.signedIn).toContain("openrouter")

    expect((yield* harness.service("openrouter")).authStatus).toBe("signed_in")
    // The key never leaks into the auth snapshot.
    expect(JSON.stringify(yield* harness.auth.snapshot)).not.toContain("sk-or-v1-new-key")
  })))

  test("exchange without a pending flow fails", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    expectFailure(yield* Effect.result(harness.auth.exchangeOpenRouterCode("code")), /no openrouter sign-in/i)
  })))

  test("start refuses a callback that isn't http(s)", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    expectFailure(yield* Effect.result(harness.auth.startOpenRouterAuth("javascript:alert(1)")), "Invalid callback URL.")
  })))

  test("a rejected exchange keeps the flow open and says why", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      exec: signedOutExec,
      fetchFn: (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch,
    })
    yield* harness.auth.startOpenRouterAuth("http://localhost:3210/oauth/openrouter/callback")
    expectFailure(yield* Effect.result(harness.auth.exchangeOpenRouterCode("code")), "OpenRouter key exchange failed (401).")
    expect(harness.getLlmProvider().apiKey).toBe("")
  })))
})

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe("install", () => {
  test("installs claude via the native installer and re-probes", () => authTest(Effect.gen(function* () {
    let installed = false
    let harnessRef: Harness | null = null
    const harness = yield* makeHarness({
      paths: { claude: null },
      exec: (argv) => {
        const joined = argv.join(" ")
        if (argv[0] === "sh" && joined.includes("curl -fsSL https://claude.ai/install.sh | bash")) {
          installed = true
          // The installer puts claude on PATH.
          harnessRef?.setPath("claude", "/usr/local/bin/claude")
          return { code: 0, stdout: "installed", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    harnessRef = harness
    yield* harness.auth.refresh({ force: true })
    expect((yield* harness.service("claude")).authStatus).toBe("not_installed")

    yield* harness.auth.install("claude")

    expect(installed).toBe(true)
    const claude = yield* harness.service("claude")
    expect(claude.installState).toBe("idle")
    expect(claude.installed).toBe(true)
    expect(claude.authStatus).toBe("signed_out")
    expect(harness.events).toEqual(expect.arrayContaining(["auth_cli_install_started", "auth_cli_install_succeeded"]))
  })))

  test("updates an existing claude via self-update with a native-installer fallback", () => authTest(Effect.gen(function* () {
    let command = ""
    const harness = yield* makeHarness({
      exec: (argv) => {
        if (argv[0] === "sh") {
          command = argv[2] ?? ""
          return { code: 0, stdout: "updated", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.install("claude")
    // Self-update first (native installs handle themselves), then the
    // installer as fallback — npm-managed installs on root-owned prefixes
    // fail the first leg and migrate to ~/.local/bin via the second.
    expect(command).toBe("'/usr/local/bin/claude' update || (curl -fsSL https://claude.ai/install.sh | bash)")
  })))

  test("update stays installing until the re-probe reads the new version", () => authTest(Effect.gen(function* () {
    let updated = false
    const harness = yield* makeHarness({
      exec: (argv) => {
        if (argv[0] === "sh") {
          updated = true
          return { code: 0, stdout: "updated", stderr: "" }
        }
        if (updated && argv[0].includes("claude") && argv.join(" ").endsWith("--version")) {
          return { code: 0, stdout: "2.1.300 (Claude Code)", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    yield* harness.auth.refresh({ force: true })

    const snapshots = yield* harness.recordChanges
    yield* harness.auth.install("claude")
    yield* tick()

    const states = snapshots.map((snapshot) => {
      const claude = snapshot.services.find((entry) => entry.service === "claude")!
      return { installState: claude.installState, version: claude.version }
    })
    const firstIdle = states.find((state) => state.installState === "idle")
    expect(firstIdle?.version).toBe("2.1.300")
  })))

  test("a probe that started before the update can't write the old version back", () => authTest(Effect.gen(function* () {
    let updated = false
    let releaseSlowProbe: () => void = () => {}
    const slowProbe = new Promise<void>((resolve) => {
      releaseSlowProbe = resolve
    })
    let holdNextAuthStatus = false
    const harness = yield* makeHarness({
      exec: async (argv) => {
        const joined = argv.join(" ")
        if (argv[0] === "sh") {
          updated = true
          return { code: 0, stdout: "updated", stderr: "" }
        }
        if (argv[0].includes("claude") && joined.endsWith("--version")) {
          return { code: 0, stdout: `${updated ? "2.1.300" : "2.1.218"} (Claude Code)`, stderr: "" }
        }
        if (holdNextAuthStatus && argv[0].includes("claude") && joined.includes("auth status")) {
          holdNextAuthStatus = false
          await slowProbe
        }
        return signedOutExec(argv)
      },
    })
    yield* harness.auth.refresh({ force: true })

    // A page-open refresh reads the old version, then stalls past the update.
    holdNextAuthStatus = true
    const refresh = yield* Effect.forkChild(harness.auth.refresh({ force: true }), { startImmediately: true })
    yield* tick()
    yield* harness.auth.install("claude")
    releaseSlowProbe()
    yield* Fiber.join(refresh)

    expect((yield* harness.service("claude")).version).toBe("2.1.300")
  })))

  test("an update that leaves the old version on PATH says so", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      paths: { brew: "/opt/homebrew/bin/brew" },
      exec: signedOutExec,
      fetchFn: (async (url: string | URL | Request) => {
        if (String(url).includes("api.github.com")) return Response.json({ tag_name: "v2.97.0" })
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    })
    yield* harness.auth.refresh({ force: true })
    yield* tick(10)

    yield* harness.auth.install("gh")
    const gh = yield* harness.service("gh")
    expect(gh.installState).toBe("error")
    expect(gh.installError).toBe("The update finished, but GitHub still reports 2.96.0 (latest is 2.97.0).")
    const installCall = harness.execCalls.find((call) => call.argv[0] === "sh")
    expect(installCall?.argv[2]).toBe("brew update --quiet; brew install gh || brew upgrade gh")
  })))

  test("claude update targets the CLAUDE_EXECUTABLE the card probes", () => authTest(Effect.gen(function* () {
    const previous = process.env.CLAUDE_EXECUTABLE
    process.env.CLAUDE_EXECUTABLE = "/opt/claude/bin/claude"
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (previous === undefined) delete process.env.CLAUDE_EXECUTABLE
      else process.env.CLAUDE_EXECUTABLE = previous
    }))
    const harness = yield* makeHarness({ exec: signedOutExec })
    yield* harness.auth.install("claude")
    const installCall = harness.execCalls.find((call) => call.argv[0] === "sh")
    expect(installCall?.argv[2]).toStartWith("'/opt/claude/bin/claude' update ||")
  })))

  test("installs codex via npm and re-probes", () => authTest(Effect.gen(function* () {
    let installed = false
    let harnessRef: Harness | null = null
    const harness = yield* makeHarness({
      paths: { codex: null },
      exec: (argv) => {
        const joined = argv.join(" ")
        if (argv[0] === "sh" && joined.includes("npm' install -g @openai/codex")) {
          installed = true
          harnessRef?.setPath("codex", "/usr/local/bin/codex")
          return { code: 0, stdout: "added 3 packages", stderr: "" }
        }
        return signedOutExec(argv)
      },
    })
    harnessRef = harness
    yield* harness.auth.refresh({ force: true })
    expect((yield* harness.service("codex")).authStatus).toBe("not_installed")

    yield* harness.auth.install("codex")

    expect(installed).toBe(true)
    const codex = yield* harness.service("codex")
    expect(codex.installState).toBe("idle")
    expect(codex.installed).toBe(true)
    expect(codex.authStatus).toBe("signed_out")
  })))

  test("codex updates with the npm beside the codex the card runs, on that npm's node", () => authTest(Effect.gen(function* () {
    // nvm's codex comes first on Kanna's PATH; the login shell's npm is Homebrew's.
    const harness = yield* makeHarness({
      paths: { codex: "/Users/j/.nvm/versions/node/v22/bin/codex", npm: "/opt/homebrew/bin/npm" },
      executables: ["/Users/j/.nvm/versions/node/v22/bin/npm"],
      exec: signedOutExec,
    })
    yield* harness.auth.install("codex")
    const script = harness.execCalls.find((call) => call.argv[0] === "sh")?.argv[2]
    expect(script).toBe(`PATH='/Users/j/.nvm/versions/node/v22/bin':"$PATH" '/Users/j/.nvm/versions/node/v22/bin/npm' install -g @openai/codex`)
  })))

  test("a codex from bun's global install updates with that bun", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      paths: { codex: "/Users/j/.bun/bin/codex" },
      executables: ["/Users/j/.bun/bin/bun"],
      exec: signedOutExec,
    })
    yield* harness.auth.install("codex")
    const script = harness.execCalls.find((call) => call.argv[0] === "sh")?.argv[2]
    expect(script).toBe(`PATH='/Users/j/.bun/bin':"$PATH" '/Users/j/.bun/bin/bun' add -g @openai/codex`)
  })))

  test("codex with neither npm nor bun says so", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ paths: { codex: null, npm: null, bun: null }, exec: signedOutExec })
    yield* harness.auth.install("codex")
    const codex = yield* harness.service("codex")
    expect(codex.installState).toBe("error")
    expect(codex.installError).toBe("Neither npm nor bun is available to install the package.")
    expect(harness.events).toContain("auth_cli_install_failed")
  })))

  test("install failure surfaces the error output", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      exec: (argv) => {
        if (argv[0] === "sh") return { code: 1, stdout: "", stderr: "EACCES: permission denied" }
        return signedOutExec(argv)
      },
    })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.install("codex")
    const codex = yield* harness.service("codex")
    expect(codex.installState).toBe("error")
    expect(codex.installError).toContain("EACCES")
  })))

  test("openrouter has nothing to install", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    expectFailure(yield* Effect.result(harness.auth.install("openrouter")), "OpenRouter has no CLI to install.")
  })))

  test("gh install on macOS without brew downloads the release zip", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({
      paths: { gh: null, brew: null },
      exec: signedOutExec,
      platform: "darwin",
    })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.install("gh")
    const script = harness.execCalls.find((call) => call.argv[0] === "sh")?.argv[2] ?? ""
    expect(script).toContain(`_macOS_$arch.zip"`)
    expect(script).toContain(`unzip -q "$tmp/gh.zip" -d "$tmp"`)
    expect(script).toContain(`cp "$tmp/gh_$(echo $ver | tr -d v)_macOS_$arch/bin/gh" "$HOME/.local/bin/gh"`)
    expect((yield* harness.service("gh")).installState).toBe("idle")
  })))

  test("cursor update runs the CLI's own updater when installed", () => authTest(Effect.gen(function* () {
    const harness = yield* makeHarness({ exec: signedOutExec })
    yield* harness.auth.refresh({ force: true })
    yield* harness.auth.install("cursor")
    const installCall = harness.execCalls.find((call) => call.argv[0] === "sh")
    expect(installCall?.argv[2]).toContain("cursor-agent")
    expect(installCall?.argv[2]).toContain("update")
  })))
})

// ---------------------------------------------------------------------------
// Real processes
// ---------------------------------------------------------------------------

describe("real processes", () => {
  test("exec returns what the command printed and its exit code", async () => {
    const result = await runTest(execCommand(["sh", "-c", "read line; echo \"out:$line\"; echo err >&2; exit 3"], { stdin: "hi\n" }))
    expect(result).toEqual({ code: 3, stdout: "out:hi\n", stderr: "err\n" })
  })

  test("exec kills a command that outlives its timeout", async () => {
    const startedAt = Date.now()
    const result = await runTest(execCommand(["sh", "-c", "echo started; exec sleep 10"], { timeoutMs: 200 }))
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("started\n")
  })

  test("exec of a missing binary is a spawn error", async () => {
    const result = await runTest(Effect.result(execCommand(["/nonexistent/kanna-test/cli", "--version"])))
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
  })

  test("a PTY login CLI takes input, ends its output on exit, and reports the exit code", async () => {
    const result = await runTest(Effect.gen(function* () {
      const child = yield* spawnPtyCommand(["sh", "-c", "read code; echo \"got:$code\"; exit 4"])
      const output = yield* child.output.pipe(Stream.mkString, Effect.forkScoped)
      yield* child.write!("abc\r")
      const exitCode = yield* child.exited
      return { exitCode, output: yield* Fiber.join(output) }
    }))
    expect(result.exitCode).toBe(4)
    expect(result.output).toContain("got:abc")
  })

  test("closing a PTY login CLI's scope kills it", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/kanna-provider-auth-pty-${process.pid}-${Date.now()}.pid`
    await runTest(Effect.scoped(Effect.gen(function* () {
      yield* spawnPtyCommand(["sh", "-c", `echo $$ > '${pidFile}'; exec sleep 30`])
      yield* tick(300)
    })))
    const pid = Number((await Bun.file(pidFile).text()).trim())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("a streaming login CLI's output arrives as text, and closing its scope kills it", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/kanna-provider-auth-${process.pid}-${Date.now()}.pid`
    const output = await runTest(Effect.gen(function* () {
      const chunks: string[] = []
      yield* Effect.scoped(Effect.gen(function* () {
        const child = yield* spawnStreamingCommand(["sh", "-c", `echo $$ > '${pidFile}'; echo hello; echo oops >&2; exec sleep 30`])
        yield* child.output.pipe(
          Stream.runForEach((chunk) => Effect.sync(() => {
            chunks.push(chunk)
          })),
          Effect.forkScoped,
        )
        yield* tick(300)
      }))
      return chunks.join("")
    }))
    expect(output).toContain("hello")
    expect(output).toContain("oops")
    const pid = Number((await Bun.file(pidFile).text()).trim())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
