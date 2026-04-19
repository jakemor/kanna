import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_OPENAI_SDK_MODEL, DEFAULT_OPENROUTER_SDK_MODEL } from "../shared/types"
import {
  normalizeLlmProviderSnapshot,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  readLlmProviderSnapshot,
  resolveLlmProviderBaseUrl,
  writeLlmProviderSnapshot,
} from "./llm-provider"

let tempDirs: string[] = []
const TEST_FILE_PATH = "/tmp/kanna-test-llm-provider.json"

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-llm-provider-"))
  tempDirs.push(dir)
  return path.join(dir, "llm-provider.json")
}

describe("resolveLlmProviderBaseUrl", () => {
  test("derives known provider URLs and preserves custom URLs", () => {
    expect(resolveLlmProviderBaseUrl("openai", "")).toBe(OPENAI_BASE_URL)
    expect(resolveLlmProviderBaseUrl("openrouter", "")).toBe(OPENROUTER_BASE_URL)
    expect(resolveLlmProviderBaseUrl("custom", " https://example.com/v1 ")).toBe("https://example.com/v1")
  })
})

describe("normalizeLlmProviderSnapshot", () => {
  test("normalizes a valid custom provider config", () => {
    expect(normalizeLlmProviderSnapshot({
      provider: "custom",
      apiKey: "  test-key  ",
      model: "  gpt-test  ",
      baseUrl: " https://example.com/v1 ",
    }, TEST_FILE_PATH)).toEqual({
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://example.com/v1",
      resolvedBaseUrl: "https://example.com/v1",
      enabled: true,
      warning: null,
      filePathDisplay: TEST_FILE_PATH,
    })
  })

  test("disables invalid configs with a warning", () => {
    const snapshot = normalizeLlmProviderSnapshot({
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "",
    }, TEST_FILE_PATH)

    expect(snapshot.enabled).toBe(false)
    expect(snapshot.warning).toContain("custom provider requires a baseUrl")
  })
})

describe("readLlmProviderSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    expect(await readLlmProviderSnapshot(filePath)).toEqual({
      provider: "openai",
      apiKey: "",
      model: DEFAULT_OPENAI_SDK_MODEL,
      baseUrl: "",
      resolvedBaseUrl: OPENAI_BASE_URL,
      enabled: false,
      warning: null,
      filePathDisplay: filePath,
    })
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readLlmProviderSnapshot(filePath)
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.warning).toContain("invalid JSON")
  })

  test("fills named-provider default models when the file omits them", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, JSON.stringify({
      provider: "openrouter",
      apiKey: "test-key",
      baseUrl: null,
    }), "utf8")

    const snapshot = await readLlmProviderSnapshot(filePath)
    expect(snapshot.model).toBe(DEFAULT_OPENROUTER_SDK_MODEL)
    expect(snapshot.enabled).toBe(true)
  })
})

describe("writeLlmProviderSnapshot", () => {
  test("writes normalized config to disk", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await writeLlmProviderSnapshot({
      provider: "openrouter",
      apiKey: " test-key ",
      model: " openrouter/model ",
      baseUrl: "ignored",
    }, filePath)

    expect(snapshot).toEqual({
      provider: "openrouter",
      apiKey: "test-key",
      model: "openrouter/model",
      baseUrl: "ignored",
      resolvedBaseUrl: OPENROUTER_BASE_URL,
      enabled: true,
      warning: null,
      filePathDisplay: filePath,
    })
    expect(await Bun.file(filePath).json()).toEqual({
      provider: "openrouter",
      apiKey: "test-key",
      model: "openrouter/model",
      baseUrl: null,
    })
  })
})
