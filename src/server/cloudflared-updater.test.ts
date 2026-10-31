import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  checkCloudflaredUpdate,
  clearCloudflaredVersionCache,
  compareCloudflaredVersions,
  ensureCloudflaredMinimum,
  installVerifiedCloudflared,
  isBelowCloudflaredMinimum,
  minimumCloudflaredVersion,
  onCloudflaredInstalled,
  parseAssetDigests,
  parseCloudflaredVersion,
  readCloudflaredVersion,
  startCloudflaredBackgroundUpdate,
  type CloudflaredUpdaterDeps,
} from "./cloudflared-updater"
import { UpdateManager } from "./update-manager"

// The fake "binaries" here are text files holding what `--version` would
// print, and runVersionCommand reads them back. Downloads write such a file.
// Nothing touches the network or runs a real cloudflared.
function versionOutput(version: string) {
  return `cloudflared version ${version} (built 2026-10-21-13:12 UTC)\n`
}

let dir: string
let bin: string

beforeEach(() => {
  clearCloudflaredVersionCache()
  dir = mkdtempSync(path.join(tmpdir(), "kanna-cloudflared-"))
  bin = path.join(dir, "cloudflared")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeDeps(overrides: Partial<CloudflaredUpdaterDeps> & { serves?: string } = {}) {
  const calls = { versionRuns: [] as string[], downloads: [] as string[], releaseLookups: 0, log: [] as string[], warn: [] as string[] }
  const serves = overrides.serves ?? "2026.10.4"
  const deps: CloudflaredUpdaterDeps = {
    platform: "linux",
    arch: "x64",
    env: {},
    runVersionCommand: async (file) => {
      calls.versionRuns.push(file)
      return await readFile(file, "utf8")
    },
    fetchLatestRelease: async () => {
      calls.releaseLookups += 1
      return { version: serves, checksums: {} }
    },
    download: async (url, destination) => {
      calls.downloads.push(url)
      await writeFile(destination, versionOutput(serves))
    },
    log: (message) => calls.log.push(message),
    warn: (message) => calls.warn.push(message),
    ...overrides,
  }
  return { deps, calls }
}

function leftovers() {
  return readdirSync(dir).filter((entry) => entry.startsWith(".cloudflared-update-") || entry.endsWith(".lock"))
}

describe("version parsing and the security minimum", () => {
  test("parses cloudflared --version output", () => {
    expect(parseCloudflaredVersion("cloudflared version 2026.10.3 (built 2026-10-21-13:12 UTC)")).toBe("2026.10.3")
    expect(parseCloudflaredVersion("cloudflared version 2026.03.0")).toBe("2026.3.0")
    expect(parseCloudflaredVersion("2026.10.4")).toBe("2026.10.4")
    expect(parseCloudflaredVersion("cloudflared version DEV")).toBeNull()
    expect(parseCloudflaredVersion("")).toBeNull()
  })

  test("compares numerically, not as strings", () => {
    expect(compareCloudflaredVersions("2026.10.2", "2026.9.30")).toBe(1)
    expect(compareCloudflaredVersions("2026.10.3", "2026.10.3")).toBe(0)
    expect(compareCloudflaredVersions("2026.3.0", "2026.10.2")).toBe(-1)
    expect(compareCloudflaredVersions("2027.1.0", "2026.12.9")).toBe(1)
  })

  test("macOS needs 2026.10.3, everything else 2026.10.2", () => {
    expect(minimumCloudflaredVersion("darwin")).toBe("2026.10.3")
    expect(minimumCloudflaredVersion("linux")).toBe("2026.10.2")
    expect(minimumCloudflaredVersion("win32")).toBe("2026.10.2")

    expect(isBelowCloudflaredMinimum("2026.10.2", "darwin")).toBe(true)
    expect(isBelowCloudflaredMinimum("2026.10.2", "linux")).toBe(false)
    expect(isBelowCloudflaredMinimum("2026.10.3", "darwin")).toBe(false)
    expect(isBelowCloudflaredMinimum("2026.3.0", "linux")).toBe(true)
    // A binary that won't report a version is not treated as vulnerable.
    expect(isBelowCloudflaredMinimum(null, "darwin")).toBe(false)
  })

  test("reads checksums from GitHub's asset digests", () => {
    expect(parseAssetDigests([
      { name: "cloudflared-darwin-arm64.tgz", digest: `sha256:${"a".repeat(64)}` },
      { name: "cloudflared-linux-amd64", digest: `sha256:${"B".repeat(64)}` },
      { name: "cloudflared-linux-arm", digest: null },
      { name: "cloudflared-windows-386.exe" },
    ])).toEqual({
      "cloudflared-darwin-arm64.tgz": "a".repeat(64),
      "cloudflared-linux-amd64": "b".repeat(64),
    })
    expect(parseAssetDigests(undefined)).toEqual({})
  })

  test("caches the version by file identity and re-reads after the file changes", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps, calls } = fakeDeps()
    expect(await readCloudflaredVersion(bin, deps)).toBe("2026.10.3")
    expect(await readCloudflaredVersion(bin, deps)).toBe("2026.10.3")
    expect(calls.versionRuns).toHaveLength(1)

    writeFileSync(bin, versionOutput("2026.10.40"))
    expect(await readCloudflaredVersion(bin, deps)).toBe("2026.10.40")
    expect(calls.versionRuns).toHaveLength(2)
  })
})

describe("ensureCloudflaredMinimum (before each tunnel start)", () => {
  test("a binary below the minimum is replaced before the tunnel starts", async () => {
    writeFileSync(bin, versionOutput("2026.3.0"))
    const { deps, calls } = fakeDeps()

    const version = await ensureCloudflaredMinimum(bin, { deps })

    expect(version).toBe("2026.10.4")
    expect(calls.downloads).toEqual(["https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64"])
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.4"))
    expect(readFileSync(`${bin}.prev`, "utf8")).toBe(versionOutput("2026.3.0"))
    expect(leftovers()).toEqual([])
  })

  test("falls back to the minimum release when GitHub's API is unreachable", async () => {
    writeFileSync(bin, versionOutput("2026.3.0"))
    const { deps, calls } = fakeDeps({
      serves: "2026.10.2",
      fetchLatestRelease: async () => {
        throw new Error("network down")
      },
    })

    expect(await ensureCloudflaredMinimum(bin, { deps })).toBe("2026.10.2")
    expect(calls.downloads).toEqual(["https://github.com/cloudflare/cloudflared/releases/download/2026.10.2/cloudflared-linux-amd64"])
  })

  test("a binary at or above the minimum is used as is", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps, calls } = fakeDeps({ platform: "darwin", arch: "arm64" })

    expect(await ensureCloudflaredMinimum(bin, { deps })).toBe("2026.10.3")
    expect(calls.releaseLookups).toBe(0)
    expect(calls.downloads).toEqual([])
  })

  test("a failed replacement still lets the tunnel start on the old binary, and is not retried on every start", async () => {
    writeFileSync(bin, versionOutput("2026.3.0"))
    const { deps, calls } = fakeDeps({
      download: async (url) => {
        calls.downloads.push(url)
        throw new Error("connection reset")
      },
    })

    expect(await ensureCloudflaredMinimum(bin, { deps })).toBe("2026.3.0")
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.3.0"))
    expect(calls.warn.some((line) => line.includes("connection reset"))).toBe(true)

    expect(await ensureCloudflaredMinimum(bin, { deps })).toBe("2026.3.0")
    expect(calls.downloads).toHaveLength(1)
  })

  test("CLOUDFLARED_BIN: a user-managed binary below the minimum is only warned about", async () => {
    writeFileSync(bin, versionOutput("2026.3.0"))
    const { deps, calls } = fakeDeps({ env: { CLOUDFLARED_BIN: bin } })

    expect(await ensureCloudflaredMinimum(bin, { deps })).toBe("2026.3.0")
    expect(calls.downloads).toEqual([])
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.3.0"))
    expect(calls.warn.some((line) => line.includes("CLOUDFLARED_BIN") && line.includes("2026.10.2"))).toBe(true)
  })
})

describe("installVerifiedCloudflared", () => {
  test("swaps atomically: a new inode at the path, the old one kept as .prev", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const originalInode = statSync(bin).ino
    const { deps } = fakeDeps()
    const events: string[] = []
    const unsubscribe = onCloudflaredInstalled((event) => events.push(`${event.previousVersion}->${event.version}`))

    const result = await installVerifiedCloudflared(bin, "2026.10.4", { deps })
    unsubscribe()

    expect(result).toEqual({ ok: true, version: "2026.10.4", previousVersion: "2026.10.3" })
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.4"))
    expect(statSync(bin).ino).not.toBe(originalInode)
    // .prev is the very file a running connector was started from.
    expect(statSync(`${bin}.prev`).ino).toBe(originalInode)
    expect(statSync(bin).mode & 0o111).not.toBe(0)
    expect(events).toEqual(["2026.10.3->2026.10.4"])
    expect(leftovers()).toEqual([])
  })

  test("macOS: the tarball is unpacked inside the temp dir, never next to the live binary", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const extractedInto: string[] = []
    const { deps } = fakeDeps({
      platform: "darwin",
      arch: "arm64",
      extractTgz: async (archive, intoDir) => {
        extractedInto.push(intoDir)
        await copyFile(archive, path.join(intoDir, "cloudflared"))
      },
    })

    const result = await installVerifiedCloudflared(bin, "2026.10.4", { deps })

    expect(result.ok).toBe(true)
    expect(extractedInto).toHaveLength(1)
    expect(path.dirname(extractedInto[0])).toBe(dir)
    expect(path.basename(extractedInto[0]).startsWith(".cloudflared-update-")).toBe(true)
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.4"))
  })

  test("a download reporting the wrong version leaves the old binary untouched", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps } = fakeDeps({ serves: "2026.10.1" })

    const result = await installVerifiedCloudflared(bin, "2026.10.4", { deps })

    expect(result).toMatchObject({ ok: false, reason: "failed" })
    expect(result.ok ? "" : result.error).toContain("reports 2026.10.1, expected 2026.10.4")
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))
    expect(existsSync(`${bin}.prev`)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  test("a download that won't run leaves the old binary untouched", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps } = fakeDeps({
      runVersionCommand: async (file) => {
        if (file !== bin) throw new Error("exec format error")
        return await readFile(file, "utf8")
      },
    })

    const result = await installVerifiedCloudflared(bin, "2026.10.4", { deps })

    expect(result.ok).toBe(false)
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))
  })

  test("a checksum mismatch leaves the old binary untouched", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps } = fakeDeps()

    const result = await installVerifiedCloudflared(bin, "2026.10.4", { deps, sha256: "0".repeat(64) })

    expect(result.ok ? "" : result.error).toContain("checksum mismatch")
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))
  })

  test("a matching checksum passes", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps } = fakeDeps()
    const sha256 = createHash("sha256").update(versionOutput("2026.10.4")).digest("hex")

    expect((await installVerifiedCloudflared(bin, "2026.10.4", { deps, sha256 })).ok).toBe(true)
  })

  test("a live lock from another process makes it step aside; a dead one is taken over", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps } = fakeDeps({ now: () => 1_000_000 })

    writeFileSync(`${bin}.update.lock`, JSON.stringify({ pid: process.pid, at: 1_000_000 }))
    expect(await installVerifiedCloudflared(bin, "2026.10.4", { deps })).toEqual({ ok: false, reason: "busy" })
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))

    writeFileSync(`${bin}.update.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: 1_000_000 }))
    expect((await installVerifiedCloudflared(bin, "2026.10.4", { deps })).ok).toBe(true)
    expect(existsSync(`${bin}.update.lock`)).toBe(false)
  })
})

describe("checkCloudflaredUpdate (background)", () => {
  test("installs a newer release, then waits about a day before checking again", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    let now = 1_000_000
    const { deps, calls } = fakeDeps({ now: () => now })

    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "installed", version: "2026.10.4", previousVersion: "2026.10.3" })
    now += 60 * 60 * 1000
    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "throttled" })
    now += 23 * 60 * 60 * 1000
    expect(await checkCloudflaredUpdate(bin, { deps })).toMatchObject({ kind: "up_to_date", version: "2026.10.4" })
    expect(calls.releaseLookups).toBe(2)
    expect(calls.downloads).toHaveLength(1)
  })

  test("a network error is logged and leaves the binary alone", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps, calls } = fakeDeps({
      fetchLatestRelease: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com")
      },
    })

    expect(await checkCloudflaredUpdate(bin, { deps })).toMatchObject({ kind: "failed" })
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))
    expect(calls.warn.some((line) => line.includes("ENOTFOUND"))).toBe(true)
  })

  test("a failed verification is logged and leaves the binary alone", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps, calls } = fakeDeps({
      download: async (_url, destination) => {
        await writeFile(destination, "not a binary")
      },
    })

    expect(await checkCloudflaredUpdate(bin, { deps })).toMatchObject({ kind: "failed" })
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.3"))
    expect(existsSync(`${bin}.prev`)).toBe(false)
    expect(calls.warn.some((line) => line.includes("keeping 2026.10.3"))).toBe(true)
  })

  test("CLOUDFLARED_BIN: never looks up or installs, warns once when below the minimum", async () => {
    writeFileSync(bin, versionOutput("2026.3.0"))
    const { deps, calls } = fakeDeps({ env: { CLOUDFLARED_BIN: bin } })

    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "user_managed" })
    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "user_managed" })
    expect(calls.releaseLookups).toBe(0)
    expect(calls.downloads).toEqual([])
    expect(calls.warn.filter((line) => line.includes("CLOUDFLARED_BIN"))).toHaveLength(1)
  })

  test("a binary never downloaded is left for the first tunnel start", async () => {
    const { deps, calls } = fakeDeps()
    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "missing" })
    expect(calls.releaseLookups).toBe(0)
  })

  test("KANNA_DISABLE_CLOUDFLARED_UPDATE=1 turns it off", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const { deps, calls } = fakeDeps({ env: { KANNA_DISABLE_CLOUDFLARED_UPDATE: "1" } })
    expect(await checkCloudflaredUpdate(bin, { deps })).toEqual({ kind: "disabled" })
    expect(calls.releaseLookups).toBe(0)
  })
})

describe("the updater never holds up an update check", () => {
  function slowDownload(ms: number) {
    let finished = false
    const download = async (_url: string, destination: string) => {
      await Bun.sleep(ms)
      await writeFile(destination, versionOutput("2026.10.4"))
      finished = true
    }
    return { download, finished: () => finished }
  }

  test("startCloudflaredBackgroundUpdate returns before a slow download finishes", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const slow = slowDownload(400)
    const { deps } = fakeDeps({ download: slow.download })

    const startedAt = performance.now()
    const pending = startCloudflaredBackgroundUpdate(bin, { deps })
    expect(performance.now() - startedAt).toBeLessThan(50)
    expect(slow.finished()).toBe(false)

    expect(await pending).toMatchObject({ kind: "installed" })
    expect(slow.finished()).toBe(true)
  })

  test("UpdateManager's check resolves while the cloudflared download is still running", async () => {
    writeFileSync(bin, versionOutput("2026.10.3"))
    const slow = slowDownload(400)
    const { deps } = fakeDeps({ download: slow.download })
    let background: Promise<unknown> | null = null
    const manager = new UpdateManager({
      currentVersion: "0.84.0",
      fetchLatestVersion: async () => "0.84.0",
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
      onCheck: () => {
        background = startCloudflaredBackgroundUpdate(bin, { deps })
      },
    })

    const startedAt = performance.now()
    const snapshot = await manager.checkForUpdates({ force: true })
    expect(performance.now() - startedAt).toBeLessThan(200)
    expect(snapshot.status).toBe("up_to_date")
    expect(background).not.toBeNull()
    expect(slow.finished()).toBe(false)

    await background
    expect(slow.finished()).toBe(true)
    expect(readFileSync(bin, "utf8")).toBe(versionOutput("2026.10.4"))
  })

  test("an updater that throws synchronously doesn't break the check", async () => {
    const manager = new UpdateManager({
      currentVersion: "0.84.0",
      fetchLatestVersion: async () => "0.85.0",
      installVersion: () => ({ ok: true, errorCode: null, userTitle: null, userMessage: null }),
      onCheck: () => {
        throw new Error("boom")
      },
    })
    expect((await manager.checkForUpdates({ force: true })).status).toBe("available")
  })
})
