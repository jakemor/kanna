import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLOUDFLARE_TUNNEL_DEFAULTS } from "../shared/types"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
  tempDirs.push(dir)
  return path.join(dir, "settings.json")
}

async function writeSettingsFile(content: Record<string, unknown>) {
  const filePath = await createTempFilePath()
  await writeFile(filePath, JSON.stringify(content), "utf8")
  return filePath
}

describe("readAppSettingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)

    expect(snapshot).toEqual({
      analyticsEnabled: true,
      cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
      warning: null,
      filePathDisplay: filePath,
    })
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.analyticsEnabled).toBe(true)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("AppSettingsManager", () => {
  test("creates a settings file with analytics enabled and a stable anonymous id", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()

    const payload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }
    expect(payload.analyticsEnabled).toBe(true)
    expect(payload.analyticsUserId).toMatch(/^anon_/)
    expect(manager.getSnapshot()).toEqual({
      analyticsEnabled: true,
      cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
      warning: null,
      filePathDisplay: filePath,
    })

    manager.dispose()
  })

  test("writes analyticsEnabled without replacing the stored user id", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()
    const initialPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }

    const snapshot = await manager.write({ analyticsEnabled: false })
    const nextPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }

    expect(snapshot).toEqual({
      analyticsEnabled: false,
      cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
      warning: null,
      filePathDisplay: filePath,
    })
    expect(nextPayload.analyticsEnabled).toBe(false)
    expect(nextPayload.analyticsUserId).toBe(initialPayload.analyticsUserId)

    manager.dispose()
  })
})

describe("cloudflareTunnel normalization", () => {
  test("normalizes missing cloudflareTunnel block to defaults", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel).toEqual({
      enabled: false,
      cloudflaredPath: "cloudflared",
      mode: "always-ask",
    })
  })

  test("preserves valid cloudflareTunnel settings", async () => {
    const filePath = await writeSettingsFile({
      cloudflareTunnel: { enabled: true, cloudflaredPath: "/usr/local/bin/cloudflared", mode: "auto-expose" },
    })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "/usr/local/bin/cloudflared",
      mode: "auto-expose",
    })
  })

  test("rejects invalid mode and resets to default with warning", async () => {
    const filePath = await writeSettingsFile({
      cloudflareTunnel: { enabled: true, cloudflaredPath: "cloudflared", mode: "garbage" },
    })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel.mode).toBe("always-ask")
    expect(snapshot.warning).toContain("cloudflareTunnel.mode")
  })

  test("setCloudflareTunnel persists patch to disk and round-trips through readAppSettingsSnapshot", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()
    await manager.setCloudflareTunnel({ enabled: true, mode: "auto-expose" })
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "cloudflared",
      mode: "auto-expose",
    })
  })

  test("write() preserves cloudflareTunnel across analytics-only updates", async () => {
    const filePath = await writeSettingsFile({
      analyticsEnabled: true,
      cloudflareTunnel: { enabled: true, cloudflaredPath: "/opt/cloudflared", mode: "auto-expose" },
    })
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()
    // Simulate analytics toggle — must NOT erase tunnel block
    await manager.write({ analyticsEnabled: false })
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "/opt/cloudflared",
      mode: "auto-expose",
    })
  })
})
