import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SERVER_PROVIDERS, resetServerProvidersForTests, type ClaudeSdkModelInfo } from "./provider-catalog"
import { ProviderModelCache } from "./provider-model-cache"

const MYTHOS_ACCOUNT: ClaudeSdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportsFastMode: true },
  { value: "claude-mythos-5-2", resolvedModel: "claude-mythos-5-2", supportsEffort: true, supportsFastMode: true },
]

const claudeModelIds = () => SERVER_PROVIDERS.find((provider) => provider.id === "claude")?.models.map((model) => model.id)

describe("ProviderModelCache", () => {
  let dir = ""
  afterEach(async () => {
    resetServerProvidersForTests()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("a fresh boot applies the last recorded lists before any probe answers", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-model-cache-"))
    const file = path.join(dir, "provider-models.json")

    const previousBoot = new ProviderModelCache(file)
    await previousBoot.load()
    await previousBoot.record("claude", MYTHOS_ACCOUNT)
    await previousBoot.record("grok", [{ id: "grok-5", label: "Grok 5" }])
    resetServerProvidersForTests()
    expect(claudeModelIds()).not.toContain("claude-mythos-5-2")

    // A second cache over the same file (the next boot) restores both lists,
    // run through the current mapping: Mythos by its full id.
    expect(await new ProviderModelCache(file).load()).toBe(true)
    expect(claudeModelIds()).toEqual(["opus", "claude-mythos-5-2"])
    expect(SERVER_PROVIDERS.find((provider) => provider.id === "claude")?.defaultModel).toBe("claude-mythos-5-2")
    expect(SERVER_PROVIDERS.find((provider) => provider.id === "grok")?.models.map((model) => model.id)).toEqual(["grok-5"])
  })

  test("records keep every provider and skip writes when the list is unchanged", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-model-cache-"))
    const file = path.join(dir, "provider-models.json")
    const cache = new ProviderModelCache(file)

    await cache.record("claude", MYTHOS_ACCOUNT)
    await cache.record("cursor", [{ id: "composer-3", label: "Composer 3" }])
    const written = JSON.parse(await readFile(file, "utf8"))
    expect(Object.keys(written).sort()).toEqual(["claude", "cursor"])

    const before = (await stat(file)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    await cache.record("claude", structuredClone(MYTHOS_ACCOUNT))
    expect((await stat(file)).mtimeMs).toBe(before)

    // An empty list (a probe that got nothing) never replaces a real one.
    await cache.record("claude", [])
    expect(JSON.parse(await readFile(file, "utf8")).claude).toEqual(MYTHOS_ACCOUNT)
  })

  test("a missing or corrupt file is an empty cache", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-model-cache-"))
    const file = path.join(dir, "provider-models.json")
    expect(await new ProviderModelCache(file).load()).toBe(false)

    await writeFile(file, "{not json", "utf8")
    expect(await new ProviderModelCache(file).load()).toBe(false)
    expect(claudeModelIds()).toEqual(["fable", "opus", "sonnet", "haiku"])
  })
})
