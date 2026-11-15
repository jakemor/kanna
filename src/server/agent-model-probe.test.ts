import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { SERVER_PROVIDERS, resetServerProvidersForTests, type ClaudeSdkModelInfo } from "./provider-catalog"
import { ProviderModelCache } from "./provider-model-cache"

const ACCOUNT_MODELS: ClaudeSdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportsFastMode: true },
  { value: "claude-mythos-5-2", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
]

function coordinatorWith(startClaudeSession: (args: { model: string }) => Promise<unknown>, modelCache?: ProviderModelCache) {
  const changes: Array<string | undefined> = []
  const coordinator = new AgentCoordinator({
    store: { dataDir: tmpdir() } as never,
    onStateChange: (chatId) => changes.push(chatId),
    startClaudeSession: startClaudeSession as never,
    ...(modelCache ? { modelCache } : {}),
  })
  return { coordinator, changes }
}

describe("probeClaudeModelCatalog", () => {
  let dir = ""
  afterEach(async () => {
    resetServerProvidersForTests()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("reads the list from a prompt-less session, closes it, and caches it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-model-probe-"))
    const cacheFile = path.join(dir, "provider-models.json")
    const started: string[] = []
    let closed = 0
    let prompted = 0
    const { coordinator, changes } = coordinatorWith(async (args) => {
      started.push(args.model)
      return {
        provider: "claude",
        stream: (async function* () {})(),
        supportedModels: async () => ACCOUNT_MODELS,
        sendPrompt: async () => { prompted += 1 },
        close: () => { closed += 1 },
      }
    }, new ProviderModelCache(cacheFile))

    // Two callers at once (boot and a sign-in) share one probe.
    await Promise.all([coordinator.probeClaudeModelCatalog(), coordinator.probeClaudeModelCatalog()])

    expect(started).toEqual(["sonnet"])
    expect(prompted).toBe(0)
    expect(closed).toBe(1)
    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    expect(claude?.models.map((model) => model.id)).toEqual(["opus", "claude-mythos-5-2"])
    expect(claude?.defaultModel).toBe("claude-mythos-5-2")
    // A catalog-wide change: no chat id, so every snapshot topic re-pushes.
    expect(changes).toEqual([undefined])
    expect(JSON.parse(await readFile(cacheFile, "utf8")).claude).toEqual(ACCOUNT_MODELS)
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
