import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
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
    await runTest(writeCloudIdentity(IDENTITY, filePath))
    expect(await runTest(readCloudIdentity(filePath))).toEqual(IDENTITY)
  })

  test("written with mode 600", async () => {
    const filePath = await tempFilePath()
    await runTest(writeCloudIdentity(IDENTITY, filePath))
    const info = await stat(filePath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test("missing file → null", async () => {
    expect(await runTest(readCloudIdentity(await tempFilePath()))).toBeNull()
  })

  test("invalid JSON → null with warning", async () => {
    const filePath = await tempFilePath()
    await runTest(writeCloudIdentity(IDENTITY, filePath))
    await writeFile(filePath, "{nope", "utf8")
    const warnings: string[] = []
    expect(await runTest(readCloudIdentity(filePath, (message) => warnings.push(message)))).toBeNull()
    expect(warnings.length).toBe(1)
  })

  test("delete removes the file, tolerates missing", async () => {
    const filePath = await tempFilePath()
    await runTest(writeCloudIdentity(IDENTITY, filePath))
    expect(await runTest(deleteCloudIdentity(filePath))).toBe(true)
    expect(await runTest(deleteCloudIdentity(filePath))).toBe(false)
  })

  test("an unreadable cloud.json fails with the path, not a null identity", async () => {
    const filePath = await tempFilePath()
    // A directory where the file should be: present, but not readable as one.
    await runTest(writeCloudIdentity(IDENTITY, path.join(filePath, "inner.json")))
    const result = await runTest(Effect.result(readCloudIdentity(filePath)))
    if (!Result.isFailure(result)) throw new Error("expected the read to fail")
    expect(result.failure._tag).toBe("@kanna/server/cloud/identity/CloudIdentityFileError")
    expect(result.failure.operation).toBe("read")
    expect(result.failure.filePath).toBe(filePath)
  })

  test("write does not leave temp files behind", async () => {
    const filePath = await tempFilePath()
    await runTest(writeCloudIdentity(IDENTITY, filePath))
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
    }, () => {}, {})
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
        {},
      ),
    ).toBeNull()
    expect(warnings[0]).toContain("tunnelToken")
    expect(warnings[0]).toContain("kanna pair")
  })

  test("enabled: false is preserved", () => {
    const normalized = normalizeCloudIdentity({ ...IDENTITY, enabled: false }, () => {}, {})
    expect(normalized?.enabled).toBe(false)
  })
})

describe("direct mode (dev-boxes)", () => {
  const DIRECT_SOURCE = {
    machineToken: "t",
    proxySecret: "p",
    subdomain: "s-box",
    appOrigin: "https://s-box.kanna.sh",
    tunnelToken: "",
    tunnelHost: "3210-sbx123.e2b.app",
    mode: "direct",
  }

  test("accepts an empty tunnelToken and keeps mode", () => {
    const normalized = normalizeCloudIdentity(DIRECT_SOURCE, () => {}, {})
    expect(normalized).toEqual({
      controlUrl: DEFAULT_CLOUD_CONTROL_URL,
      machineToken: "t",
      proxySecret: "p",
      subdomain: "s-box",
      appOrigin: "https://s-box.kanna.sh",
      tunnelToken: "",
      tunnelHost: "3210-sbx123.e2b.app",
      enabled: true,
      mode: "direct",
    })
  })

  test("derives tunnelHost from E2B_SANDBOX_ID when the file omits it", () => {
    const normalized = normalizeCloudIdentity(
      { ...DIRECT_SOURCE, tunnelHost: "" },
      () => {},
      { E2B_SANDBOX_ID: "sbx456" },
    )
    expect(normalized?.tunnelHost).toBe("3210-sbx456.e2b.app")
  })

  test("no tunnelHost and no sandbox env → null", () => {
    const warnings: string[] = []
    expect(
      normalizeCloudIdentity({ ...DIRECT_SOURCE, tunnelHost: "" }, (m) => warnings.push(m), {}),
    ).toBeNull()
    expect(warnings[0]).toContain("tunnelHost")
  })

  test("tunnel mode ignores E2B_SANDBOX_ID and still requires tunnelToken", () => {
    const warnings: string[] = []
    expect(
      normalizeCloudIdentity(
        { ...DIRECT_SOURCE, mode: undefined, tunnelHost: "" },
        (m) => warnings.push(m),
        { E2B_SANDBOX_ID: "sbx456" },
      ),
    ).toBeNull()
    expect(warnings[0]).toContain("tunnelToken")
    expect(warnings[0]).toContain("tunnelHost")
  })

  test("direct identity round-trips through the file", async () => {
    const filePath = await tempFilePath()
    const identity = normalizeCloudIdentity(DIRECT_SOURCE, () => {}, {})
    if (!identity) throw new Error("expected identity")
    await runTest(writeCloudIdentity(identity, filePath))
    expect(await runTest(readCloudIdentity(filePath))).toEqual(identity)
  })
})
