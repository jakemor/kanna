/**
 * Keeps the cloudflared binary Kanna downloaded current.
 *
 * The `cloudflared` npm package downloads "latest" once, and nothing ever
 * replaced it: a copy fetched in March stayed in use through every Kanna
 * update. This module adds two things on top:
 *
 *  - a security minimum. A binary below it is replaced before the next tunnel
 *    starts (`ensureCloudflaredMinimum`, called from share.ts).
 *  - a background updater (`startCloudflaredBackgroundUpdate`) that runs next
 *    to Kanna's own update checks, at most about once a day, and never holds
 *    them up: callers fire it and do not await it.
 *
 * Every install goes to a temp directory beside the binary, is verified
 * (`--version` reports the release, and the SHA256 matches GitHub's digest
 * of the asset when it has one), and then renamed over the binary. A running
 * connector keeps the inode it was started from, so the swap never disturbs
 * it; the new binary is used from the next connector start. The previous
 * binary stays as `<bin>.prev` for a manual rollback. Any failure leaves the
 * current binary as it was.
 *
 * A binary named by CLOUDFLARED_BIN belongs to the user (Homebrew, a package
 * manager, a pinned build). It is never replaced, only warned about.
 */

import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { chmod, copyFile, link, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

/**
 * Cloudflare's advisory of Oct 20 2026: eight eMudhra intermediate
 * certificates were compromised, and older cloudflared builds trust them.
 * https://blog.cloudflare.com/emudhra-certificate-compromise/
 * The fix is 2026.10.2. On macOS a copy not installed through Homebrew needs
 * 2026.10.3, and Kanna's copy never comes from Homebrew.
 */
export const CLOUDFLARED_SECURITY_MINIMUM = {
  darwin: "2026.10.3",
  other: "2026.10.2",
} as const

/** The background check runs at most this often per binary. */
const UPDATE_CHECK_INTERVAL_MS = 23 * 60 * 60 * 1000
/** After a failed check, the next trigger waits this long before retrying. */
const UPDATE_FAILURE_BACKOFF_MS = 60 * 60 * 1000
/** A background download that takes longer than this is abandoned. */
const BACKGROUND_INSTALL_TIMEOUT_MS = 5 * 60 * 1000
/**
 * The below-minimum install runs on the way to a tunnel start, inside the
 * cloud supervisor's 60s readiness deadline. Past this the tunnel starts on
 * the old binary instead of not starting at all, and the background updater
 * tries again later.
 */
const MINIMUM_INSTALL_TIMEOUT_MS = 40_000
/** A failed below-minimum install is not retried on every tunnel start. */
const MINIMUM_INSTALL_RETRY_MS = 10 * 60 * 1000
const RELEASE_LOOKUP_TIMEOUT_MS = 15_000
const VERSION_COMMAND_TIMEOUT_MS = 10_000
/** A lock older than this belongs to an updater that died mid-install. */
const LOCK_STALE_MS = 10 * 60 * 1000
const TEMP_DIR_PREFIX = ".cloudflared-update-"
const LATEST_RELEASE_URL = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
const RELEASE_DOWNLOAD_BASE = "https://github.com/cloudflare/cloudflared/releases/download"

export function minimumCloudflaredVersion(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" ? CLOUDFLARED_SECURITY_MINIMUM.darwin : CLOUDFLARED_SECURITY_MINIMUM.other
}

/** `cloudflared version 2026.10.3 (built 2026-10-21-13:12 UTC)` → `2026.10.3`. */
export function parseCloudflaredVersion(output: string): string | null {
  const match = output.match(/\b(\d{4})\.(\d{1,2})\.(\d{1,4})\b/)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null
}

export function compareCloudflaredVersions(left: string, right: string) {
  const a = left.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const b = right.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/** An unknown version is not "below": a binary that won't say is left alone. */
export function isBelowCloudflaredMinimum(version: string | null, platform: NodeJS.Platform = process.platform) {
  return version !== null && compareCloudflaredVersions(version, minimumCloudflaredVersion(platform)) < 0
}

/** CLOUDFLARED_BIN is how the `cloudflared` package lets a user bring their own binary. */
export function isUserManagedCloudflared(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.CLOUDFLARED_BIN)
}

export interface CloudflaredRelease {
  version: string
  /** SHA256 per asset name, from GitHub's asset digests; empty when it lists none. */
  checksums: Record<string, string>
}

export interface CloudflaredUpdaterDeps {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Output of `<bin> --version`. */
  runVersionCommand?: (bin: string) => Promise<string>
  fetchLatestRelease?: () => Promise<CloudflaredRelease>
  download?: (url: string, destination: string, signal: AbortSignal) => Promise<void>
  extractTgz?: (archive: string, intoDir: string) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}

/** Fired after a verified binary has been swapped in. */
export interface CloudflaredInstalledEvent {
  bin: string
  version: string
  previousVersion: string | null
}

const installedListeners = new Set<(event: CloudflaredInstalledEvent) => void>()

/** The cloud supervisor listens here to decide whether its connector must move to a patched binary. */
export function onCloudflaredInstalled(listener: (event: CloudflaredInstalledEvent) => void) {
  installedListeners.add(listener)
  return () => {
    installedListeners.delete(listener)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function defaultRunVersionCommand(bin: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(bin, ["--version"], { timeout: VERSION_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve(`${stdout}${stderr}`)
    })
  })
}

const versionCache = new Map<string, { ino: number; mtimeMs: number; size: number; version: string | null }>()

/**
 * The installed binary's version, or null when it is missing or won't say.
 * Cached by path, inode, mtime and size, so each binary runs `--version` once
 * per process rather than on every tunnel start.
 */
export async function readCloudflaredVersion(bin: string, deps: CloudflaredUpdaterDeps = {}) {
  let info: { ino: number; mtimeMs: number; size: number }
  try {
    info = await stat(bin)
  } catch {
    return null
  }
  const cached = versionCache.get(bin)
  if (cached && cached.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.version
  let version: string | null
  try {
    version = parseCloudflaredVersion(await (deps.runVersionCommand ?? defaultRunVersionCommand)(bin))
  } catch {
    version = null
  }
  versionCache.set(bin, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, version })
  return version
}

export function clearCloudflaredVersionCache() {
  versionCache.clear()
}

/** The release asset for this machine; mirrors the `cloudflared` package's own table. */
export function cloudflaredAssetName(platform: NodeJS.Platform, arch: string) {
  if (platform === "darwin") {
    if (arch === "arm64") return "cloudflared-darwin-arm64.tgz"
    if (arch === "x64") return "cloudflared-darwin-amd64.tgz"
  } else if (platform === "linux") {
    const asset = ({ arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm", x64: "cloudflared-linux-amd64", ia32: "cloudflared-linux-386" } as Record<string, string>)[arch]
    if (asset) return asset
  } else if (platform === "win32") {
    if (arch === "x64") return "cloudflared-windows-amd64.exe"
    if (arch === "ia32") return "cloudflared-windows-386.exe"
  }
  throw new Error(`no cloudflared release for ${platform}/${arch}`)
}

/**
 * SHA256 per asset from GitHub's own `digest` field, which it computes from
 * the uploaded bytes. Not the "SHA256 Checksums" block in the release notes:
 * for 2026.10.4 the notes list a hash for cloudflared-darwin-arm64.tgz that
 * does not match the published file (the macOS builds appear to be
 * re-uploaded after the notes are written), so checking against the notes
 * would reject every macOS update.
 */
export function parseAssetDigests(assets: unknown) {
  const checksums: Record<string, string> = {}
  if (!Array.isArray(assets)) return checksums
  for (const asset of assets as Array<{ name?: unknown; digest?: unknown }>) {
    const digest = typeof asset.digest === "string" ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1] : undefined
    if (typeof asset.name === "string" && digest) checksums[asset.name] = digest.toLowerCase()
  }
  return checksums
}

async function defaultFetchLatestRelease(): Promise<CloudflaredRelease> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "kanna-cloudflared-updater" },
    signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`)
  const payload = await response.json() as { tag_name?: unknown; assets?: unknown }
  const version = typeof payload.tag_name === "string" ? parseCloudflaredVersion(payload.tag_name) : null
  if (!version) throw new Error("GitHub's latest cloudflared release has no version tag")
  return { version, checksums: parseAssetDigests(payload.assets) }
}

async function defaultDownload(url: string, destination: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { "user-agent": "kanna-cloudflared-updater" } })
  if (!response.ok || !response.body) throw new Error(`download returned ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), createWriteStream(destination), { signal })
}

/** Async, unlike the `cloudflared` package's execSync tar, so a long extract never stalls the server. */
function defaultExtractTgz(archive: string, intoDir: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", intoDir], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with code ${String(code)}`)))
  })
}

async function sha256File(file: string) {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

/**
 * One updater per binary across processes: an exiting `kanna` and the one
 * replacing it can overlap. Holding it is optional (null means someone else
 * is installing); a lock whose process is gone, or that is old, is taken over.
 */
async function acquireLock(bin: string, now: number) {
  const lockPath = `${bin}.update.lock`
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(lockPath, "wx")
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now }))
      await handle.close()
      return async () => {
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let holder: { pid?: number; at?: number } = {}
      try {
        holder = JSON.parse(await readFile(lockPath, "utf8"))
      } catch {}
      const alive = typeof holder.pid === "number" && isProcessAlive(holder.pid)
      if (alive && typeof holder.at === "number" && now - holder.at < LOCK_STALE_MS) return null
      await rm(lockPath, { force: true })
    }
  }
  return null
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Temp directories left by an updater that was killed mid-download. */
async function sweepStaleTempDirs(binDir: string, now: number) {
  let entries: string[]
  try {
    entries = await readdir(binDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_DIR_PREFIX)) continue
    const full = path.join(binDir, entry)
    try {
      if (now - (await stat(full)).mtimeMs > LOCK_STALE_MS) await rm(full, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Puts `fresh` at `bin`. On POSIX the rename is atomic: a reader sees the old
 * file or the new one, never a missing or half-written one. `.prev` is a hard
 * link to the old inode (a copy where links fail). Windows can't rename over
 * a running exe but can rename one aside, so there the old binary moves to
 * `.prev` first and comes back if the second rename fails.
 */
async function swapInBinary(fresh: string, bin: string, platform: NodeJS.Platform) {
  const prev = `${bin}.prev`
  await rm(prev, { force: true })
  if (platform === "win32") {
    if (existsSync(bin)) await rename(bin, prev)
    try {
      await rename(fresh, bin)
    } catch (error) {
      if (existsSync(prev)) await rename(prev, bin).catch(() => {})
      throw error
    }
    return
  }
  if (existsSync(bin)) {
    try {
      await link(bin, prev)
    } catch {
      await copyFile(bin, prev)
    }
  }
  await chmod(fresh, 0o755)
  await rename(fresh, bin)
}

export interface InstallCloudflaredOptions {
  /** Expected SHA256 of the downloaded asset; skipped when unknown. */
  sha256?: string
  timeoutMs?: number
  deps?: CloudflaredUpdaterDeps
}

export type InstallCloudflaredResult =
  | { ok: true; version: string; previousVersion: string | null }
  | { ok: false; reason: "busy" | "failed"; error?: string }

/**
 * Downloads release `version` beside `bin`, verifies it, and swaps it in.
 * On any failure the binary at `bin` is untouched.
 */
export async function installVerifiedCloudflared(
  bin: string,
  version: string,
  options: InstallCloudflaredOptions = {},
): Promise<InstallCloudflaredResult> {
  const deps = options.deps ?? {}
  const platform = deps.platform ?? process.platform
  const now = (deps.now ?? Date.now)()
  const binDir = path.dirname(bin)
  let releaseLock: (() => Promise<void>) | null
  try {
    releaseLock = await acquireLock(bin, now)
  } catch (error) {
    // Typically a binary directory this user can't write to.
    return { ok: false, reason: "failed", error: errorMessage(error) }
  }
  if (!releaseLock) return { ok: false, reason: "busy" }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`download timed out after ${Math.round((options.timeoutMs ?? BACKGROUND_INSTALL_TIMEOUT_MS) / 1000)}s`)),
    options.timeoutMs ?? BACKGROUND_INSTALL_TIMEOUT_MS,
  )
  timer.unref?.()
  let tempDir: string | null = null
  try {
    await sweepStaleTempDirs(binDir, now)
    tempDir = await mkdtemp(path.join(binDir, TEMP_DIR_PREFIX))
    const asset = cloudflaredAssetName(platform, deps.arch ?? process.arch)
    const downloaded = path.join(tempDir, asset)
    await (deps.download ?? defaultDownload)(`${RELEASE_DOWNLOAD_BASE}/${version}/${asset}`, downloaded, controller.signal)
    controller.signal.throwIfAborted()

    if (options.sha256) {
      const actual = await sha256File(downloaded)
      if (actual !== options.sha256.toLowerCase()) {
        throw new Error(`checksum mismatch for ${asset} (expected ${options.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
      }
    }

    // The macOS release is a tarball holding one `cloudflared`. It is
    // extracted inside the temp dir: the `cloudflared` package extracts next
    // to the target, which here would overwrite the live binary in place.
    let fresh = downloaded
    if (asset.endsWith(".tgz")) {
      await (deps.extractTgz ?? defaultExtractTgz)(downloaded, tempDir)
      fresh = path.join(tempDir, "cloudflared")
      if (!existsSync(fresh)) throw new Error(`${asset} did not contain a cloudflared binary`)
    }
    await chmod(fresh, 0o755)

    const reported = parseCloudflaredVersion(await (deps.runVersionCommand ?? defaultRunVersionCommand)(fresh))
    if (reported !== version) {
      throw new Error(`downloaded binary reports ${reported ?? "no version"}, expected ${version}`)
    }

    const previousVersion = await readCloudflaredVersion(bin, deps)
    await swapInBinary(fresh, bin, platform)
    const event = { bin, version, previousVersion }
    for (const listener of installedListeners) {
      try {
        listener(event)
      } catch {}
    }
    return { ok: true, version, previousVersion }
  } catch (error) {
    return { ok: false, reason: "failed", error: errorMessage(controller.signal.aborted ? controller.signal.reason : error) }
  } finally {
    clearTimeout(timer)
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    await releaseLock().catch(() => {})
  }
}

/** One in-flight install per binary in this process, shared by both callers. */
const inFlight = new Map<string, Promise<InstallCloudflaredResult>>()

function installOnce(bin: string, version: string, options: InstallCloudflaredOptions) {
  const existing = inFlight.get(bin)
  if (existing) return existing
  const pending = installVerifiedCloudflared(bin, version, options).finally(() => {
    inFlight.delete(bin)
  })
  inFlight.set(bin, pending)
  return pending
}

const minimumFailedAt = new Map<string, number>()
const minimumWarned = new Set<string>()

/**
 * Called before every tunnel start. Below the security minimum, a Kanna-owned
 * binary is replaced first (the latest release, or the minimum itself when
 * GitHub's API can't be reached). If that fails, or takes longer than
 * MINIMUM_INSTALL_TIMEOUT_MS, the tunnel still starts on the old binary with
 * a warning: refusing to start would cut off a machine reached only through
 * its tunnel, and the background updater keeps trying.
 *
 * Returns the version the tunnel will start with (null when unknown).
 */
export async function ensureCloudflaredMinimum(
  bin: string,
  options: { userManaged?: boolean; deps?: CloudflaredUpdaterDeps } = {},
): Promise<string | null> {
  const deps = options.deps ?? {}
  const platform = deps.platform ?? process.platform
  const warn = deps.warn ?? deps.log ?? (() => {})
  const version = await readCloudflaredVersion(bin, deps)
  if (!isBelowCloudflaredMinimum(version, platform)) return version
  const minimum = minimumCloudflaredVersion(platform)

  const userManaged = options.userManaged ?? isUserManagedCloudflared(deps.env)
  if (userManaged) {
    if (!minimumWarned.has(bin)) {
      minimumWarned.add(bin)
      warn(`cloudflared ${version} at ${bin} (CLOUDFLARED_BIN) is below the security minimum ${minimum}; update it yourself: https://blog.cloudflare.com/emudhra-certificate-compromise/`)
    }
    return version
  }

  const now = (deps.now ?? Date.now)()
  const failedAt = minimumFailedAt.get(bin)
  if (failedAt !== undefined && now - failedAt < MINIMUM_INSTALL_RETRY_MS) return version

  warn(`cloudflared ${version} is below the security minimum ${minimum}; downloading a patched copy before starting the tunnel`)
  const attempt = (async () => {
    let target: { version: string; sha256?: string }
    try {
      const release = await (deps.fetchLatestRelease ?? defaultFetchLatestRelease)()
      target = compareCloudflaredVersions(release.version, minimum) >= 0
        ? { version: release.version, sha256: release.checksums[cloudflaredAssetName(platform, deps.arch ?? process.arch)] }
        : { version: minimum }
    } catch {
      target = { version: minimum }
    }
    return await installOnce(bin, target.version, { sha256: target.sha256, timeoutMs: MINIMUM_INSTALL_TIMEOUT_MS, deps })
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    attempt,
    new Promise<InstallCloudflaredResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: "failed", error: "timed out" }), MINIMUM_INSTALL_TIMEOUT_MS + 2_000)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))

  if (result.ok) {
    minimumFailedAt.delete(bin)
    deps.log?.(`cloudflared updated ${result.previousVersion ?? "?"} → ${result.version} (previous kept at ${bin}.prev)`)
    return result.version
  }
  minimumFailedAt.set(bin, now)
  warn(`cloudflared: could not install a patched copy (${result.error ?? result.reason}); starting on ${version} for now`)
  return version
}

interface UpdateCheckState {
  checkedAt?: number
  failedAt?: number
  latestVersion?: string
}

function stateFile(bin: string) {
  return `${bin}.update-check.json`
}

async function readState(bin: string): Promise<UpdateCheckState> {
  try {
    return JSON.parse(await readFile(stateFile(bin), "utf8")) as UpdateCheckState
  } catch {
    return {}
  }
}

async function writeState(bin: string, state: UpdateCheckState) {
  await writeFile(stateFile(bin), JSON.stringify(state)).catch(() => {})
}

export type CloudflaredUpdateOutcome =
  | { kind: "disabled" | "user_managed" | "missing" | "throttled" | "busy" }
  | { kind: "up_to_date"; version: string | null; latestVersion: string }
  | { kind: "installed"; version: string; previousVersion: string | null }
  | { kind: "failed"; error: string }

/**
 * One background pass: look up the latest release and install it when it is
 * newer. Throttled through a small state file beside the binary, written only
 * once a pass finishes, so a process killed mid-download (a startup
 * self-update restarts Kanna) leaves the next one free to retry.
 */
export async function checkCloudflaredUpdate(
  bin: string,
  options: { force?: boolean; deps?: CloudflaredUpdaterDeps } = {},
): Promise<CloudflaredUpdateOutcome> {
  const deps = options.deps ?? {}
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const log = deps.log ?? (() => {})
  const warn = deps.warn ?? log
  const now = (deps.now ?? Date.now)()

  if (env.KANNA_DISABLE_CLOUDFLARED_UPDATE === "1") return { kind: "disabled" }
  if (isUserManagedCloudflared(env)) {
    const version = await readCloudflaredVersion(bin, deps)
    if (isBelowCloudflaredMinimum(version, platform) && !minimumWarned.has(bin)) {
      minimumWarned.add(bin)
      warn(`cloudflared ${version} at ${bin} (CLOUDFLARED_BIN) is below the security minimum ${minimumCloudflaredVersion(platform)}; Kanna does not update a binary you manage`)
    }
    return { kind: "user_managed" }
  }
  // Never downloaded means never used: the first tunnel start installs it.
  if (!existsSync(bin)) return { kind: "missing" }
  if (inFlight.has(bin)) return { kind: "busy" }

  if (!options.force) {
    const state = await readState(bin)
    if (state.checkedAt !== undefined && now - state.checkedAt < UPDATE_CHECK_INTERVAL_MS) return { kind: "throttled" }
    if (state.failedAt !== undefined && now - state.failedAt < UPDATE_FAILURE_BACKOFF_MS) return { kind: "throttled" }
  }

  let release: CloudflaredRelease
  try {
    release = await (deps.fetchLatestRelease ?? defaultFetchLatestRelease)()
  } catch (error) {
    warn(`cloudflared: update check failed: ${errorMessage(error)}`)
    await writeState(bin, { failedAt: now })
    return { kind: "failed", error: errorMessage(error) }
  }

  const version = await readCloudflaredVersion(bin, deps)
  if (version !== null && compareCloudflaredVersions(version, release.version) >= 0) {
    await writeState(bin, { checkedAt: now, latestVersion: release.version })
    return { kind: "up_to_date", version, latestVersion: release.version }
  }

  log(`cloudflared ${version ?? "(unknown version)"} → ${release.version} available; downloading in the background`)
  const sha256 = release.checksums[cloudflaredAssetName(platform, deps.arch ?? process.arch)]
  const result = await installOnce(bin, release.version, { sha256, deps })
  if (!result.ok) {
    if (result.reason === "busy") return { kind: "busy" }
    warn(`cloudflared: update to ${release.version} failed, keeping ${version ?? "the current binary"}: ${result.error}`)
    await writeState(bin, { failedAt: now, latestVersion: release.version })
    return { kind: "failed", error: result.error ?? "install failed" }
  }
  await writeState(bin, { checkedAt: now, latestVersion: release.version })
  log(`cloudflared updated ${result.previousVersion ?? "?"} → ${result.version}; running connectors keep the old binary until their next start (previous kept at ${bin}.prev)`)
  return { kind: "installed", version: result.version, previousVersion: result.previousVersion }
}

/**
 * Fire-and-forget entry point for the update checks: returns at once and
 * never throws, so it adds no time to whatever triggered it.
 */
export function startCloudflaredBackgroundUpdate(
  bin: string,
  options: { force?: boolean; deps?: CloudflaredUpdaterDeps } = {},
): Promise<CloudflaredUpdateOutcome> {
  const pending = checkCloudflaredUpdate(bin, options).catch((error): CloudflaredUpdateOutcome => {
    ;(options.deps?.warn ?? options.deps?.log)?.(`cloudflared: update check failed: ${errorMessage(error)}`)
    return { kind: "failed", error: errorMessage(error) }
  })
  return pending
}
