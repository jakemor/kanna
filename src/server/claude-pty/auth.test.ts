import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { verifyPtyAuth } from "./auth"

describe("verifyPtyAuth", () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kanna-pty-auth-"))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  test("ok when credentials.json exists and ANTHROPIC_API_KEY unset", async () => {
    await mkdir(path.join(homeDir, ".claude"), { recursive: true })
    await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
    const result = await verifyPtyAuth({ homeDir, env: {} })
    expect(result.ok).toBe(true)
  })

  test("error when credentials.json missing AND no oauthToken supplied", async () => {
    const result = await verifyPtyAuth({ homeDir, env: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("claude /login")
    }
  })

  test("ok when oauthToken supplied even if credentials.json missing", async () => {
    // OAuth-pool-only deployments (CI runners, ephemeral VMs) never have
    // credentials.json on disk. CLAUDE_CODE_OAUTH_TOKEN overrides the
    // file/keychain lookup at CLI startup, so the file is not required.
    const result = await verifyPtyAuth({
      homeDir,
      env: {},
      oauthToken: "sk-ant-oat-abc",
    })
    expect(result.ok).toBe(true)
  })

  test("empty oauthToken does not satisfy auth — credentials.json still required", async () => {
    const result = await verifyPtyAuth({
      homeDir,
      env: {},
      oauthToken: "",
    })
    expect(result.ok).toBe(false)
  })

  test("oauthToken does NOT bypass the ANTHROPIC_API_KEY rejection", async () => {
    const result = await verifyPtyAuth({
      homeDir,
      env: { ANTHROPIC_API_KEY: "sk-x" },
      oauthToken: "sk-ant-oat-abc",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("ANTHROPIC_API_KEY")
    }
  })

  test("error when ANTHROPIC_API_KEY is set", async () => {
    await mkdir(path.join(homeDir, ".claude"), { recursive: true })
    await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
    const result = await verifyPtyAuth({ homeDir, env: { ANTHROPIC_API_KEY: "sk-x" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("ANTHROPIC_API_KEY")
    }
  })

  test("ok when CLAUDE_CODE_OAUTH_TOKEN is set (pool rotation env var)", async () => {
    await mkdir(path.join(homeDir, ".claude"), { recursive: true })
    await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "{}", "utf8")
    const result = await verifyPtyAuth({
      homeDir,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-..." },
    })
    expect(result.ok).toBe(true)
  })
})
