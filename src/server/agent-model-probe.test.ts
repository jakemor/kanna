import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { claudeModelProbeOptions } from "./claude-model-probe"
import { SERVER_PROVIDERS, resetServerProvidersForTests, type ClaudeSdkModelInfo } from "./provider-catalog"
import { ProviderModelCache } from "./provider-model-cache"

const ACCOUNT_MODELS: ClaudeSdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportsFastMode: true },
  { value: "claude-mythos-5-2", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
]

const DATA_DIR = "/tmp/kanna-data"

function coordinatorWith(probeClaudeModels: (cwd: string) => Promise<ClaudeSdkModelInfo[]>, modelCache?: ProviderModelCache) {
  const changes: Array<string | undefined> = []
  let sessionsStarted = 0
  const coordinator = new AgentCoordinator({
    store: { dataDir: DATA_DIR } as never,
    onStateChange: (chatId) => changes.push(chatId),
    // A probe must never start a chat session.
    startClaudeSession: (async () => {
      sessionsStarted += 1
      throw new Error("no sessions in this test")
    }) as never,
    probeClaudeModels,
    ...(modelCache ? { modelCache } : {}),
  })
  return { coordinator, changes, sessionsStarted: () => sessionsStarted }
}

describe("probeClaudeModelCatalog", () => {
  let dir = ""
  afterEach(async () => {
    resetServerProvidersForTests()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("applies the probed list, broadcasts it and caches it, without a chat session", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-model-probe-"))
    const cacheFile = path.join(dir, "provider-models.json")
    const probedFrom: string[] = []
    const { coordinator, changes, sessionsStarted } = coordinatorWith(async (cwd) => {
      probedFrom.push(cwd)
      return ACCOUNT_MODELS
    }, new ProviderModelCache(cacheFile))

    // Two callers at once (boot and a sign-in) share one probe.
    await Promise.all([coordinator.probeClaudeModelCatalog(), coordinator.probeClaudeModelCatalog()])

    // Run from Kanna's data dir, as T3 Code runs its probe from its state dir.
    expect(probedFrom).toEqual([DATA_DIR])
    expect(sessionsStarted()).toBe(0)
    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    expect(claude?.models.map((model) => model.id)).toEqual(["opus", "claude-mythos-5-2"])
    expect(claude?.defaultModel).toBe("claude-mythos-5-2")
    // A catalog-wide change: no chat id, so every snapshot topic re-pushes.
    expect(changes).toEqual([undefined])
    expect(JSON.parse(await readFile(cacheFile, "utf8")).claude).toEqual(ACCOUNT_MODELS)
  })

  test("the periodic refresh skips the probe while the last list is fresh", async () => {
    let probes = 0
    const { coordinator } = coordinatorWith(async () => {
      probes += 1
      return ACCOUNT_MODELS
    })
    await coordinator.probeClaudeModelCatalog({ ifOlderThanMs: 60_000 })
    expect(probes).toBe(1)
    await coordinator.probeClaudeModelCatalog({ ifOlderThanMs: 60_000 })
    expect(probes).toBe(1)
    // Boot and sign-in ask unconditionally.
    await coordinator.probeClaudeModelCatalog()
    expect(probes).toBe(2)
  })

  test("a missing or signed-out Claude keeps the current list quietly", async () => {
    const { coordinator, changes } = coordinatorWith(async () => {
      throw new Error("Claude Code isn't installed.")
    })
    await coordinator.probeClaudeModelCatalog()
    expect(SERVER_PROVIDERS.find((provider) => provider.id === "claude")?.models.map((model) => model.id))
      .toEqual(["fable", "opus", "sonnet", "haiku"])
    expect(changes).toEqual([])
  })
})

describe("claudeModelProbeOptions", () => {
  test("loads the settings that shape the list, and nothing that runs", () => {
    const options = claudeModelProbeOptions({
      executablePath: "/usr/local/bin/claude",
      cwd: DATA_DIR,
      abortController: new AbortController(),
      env: { PATH: "/usr/bin", CLAUDECODE: "1" },
    })
    expect(options.settingSources).toEqual(["user", "project", "local"])
    expect(options.persistSession).toBe(false)
    expect(options.settings.disableAllHooks).toBe(true)
    expect(options.mcpServers).toEqual({})
    expect(options.strictMcpConfig).toBe(true)
    expect(options.tools).toEqual([])
    expect(options.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
    expect(options.env.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("0")
    // A Kanna started from inside Claude Code must not hand that marker on.
    expect("CLAUDECODE" in options.env).toBe(false)
    expect(options.env.PATH).toBe("/usr/bin")
  })
})
