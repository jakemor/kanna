import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import {
  deleteCloudIdentity,
  normalizeCloudIdentity,
  readCloudIdentity,
  writeCloudIdentity,
  type CloudIdentity,
} from "./identity"

const IDENTITY: CloudIdentity = {
  controlUrl: DEFAULT_CLOUD_CONTROL_URL,
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

async function tempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-cloud-identity-"))
  return path.join(dir, "nested", "cloud.json")
}

describe("cloud identity file", () => {
  test("round-trips and creates parent dirs", async () => {
    const filePath = await tempFilePath()
    await writeCloudIdentity(IDENTITY, filePath)
    expect(await readCloudIdentity(filePath)).toEqual(IDENTITY)
  })

  test("written with mode 600", async () => {
    const filePath = await tempFilePath()
    await writeCloudIdentity(IDENTITY, filePath)
    const info = await stat(filePath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test("missing file → null", async () => {
    expect(await readCloudIdentity(await tempFilePath())).toBeNull()
  })

  test("invalid JSON → null with warning", async () => {
    const filePath = await tempFilePath()
    await writeCloudIdentity(IDENTITY, filePath)
    await writeFile(filePath, "{nope", "utf8")
    const warnings: string[] = []
    expect(await readCloudIdentity(filePath, (message) => warnings.push(message))).toBeNull()
    expect(warnings.length).toBe(1)
  })

  test("delete removes the file, tolerates missing", async () => {
    const filePath = await tempFilePath()
    await writeCloudIdentity(IDENTITY, filePath)
    expect(await deleteCloudIdentity(filePath)).toBe(true)
    expect(await deleteCloudIdentity(filePath)).toBe(false)
  })

  test("write does not leave temp files behind", async () => {
    const filePath = await tempFilePath()
    await writeCloudIdentity(IDENTITY, filePath)
    const raw = await readFile(filePath, "utf8")
    expect(JSON.parse(raw)).toEqual(IDENTITY)
  })
})

describe("normalizeCloudIdentity", () => {
  test("defaults controlUrl and enabled; strips scheme from tunnelHost", () => {
    const normalized = normalizeCloudIdentity({
      machineToken: "t",
      proxySecret: "p",
      subdomain: "s-x",
      appOrigin: "https://s-x.kanna.sh/",
      tunnelToken: "tt",
      tunnelHost: "https://tun-m1.kanna.sh/",
    })
    expect(normalized).toEqual({
      controlUrl: DEFAULT_CLOUD_CONTROL_URL,
      machineToken: "t",
      proxySecret: "p",
      subdomain: "s-x",
      appOrigin: "https://s-x.kanna.sh",
      tunnelToken: "tt",
      tunnelHost: "tun-m1.kanna.sh",
      enabled: true,
    })
  })

  test("missing required field → null + names the field (v1 files invalidate cleanly)", () => {
    const warnings: string[] = []
    expect(
      normalizeCloudIdentity(
        {
          machineToken: "t",
          proxySecret: "p",
          subdomain: "s",
          appOrigin: "https://s.kanna.sh",
          // v1 file: no tunnel credentials
        },
        (message) => warnings.push(message),
      ),
    ).toBeNull()
    expect(warnings[0]).toContain("tunnelToken")
    expect(warnings[0]).toContain("kanna pair")
  })

  test("enabled: false is preserved", () => {
    const normalized = normalizeCloudIdentity({ ...IDENTITY, enabled: false })
    expect(normalized?.enabled).toBe(false)
  })
})
