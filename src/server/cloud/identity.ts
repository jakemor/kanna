/**
 * ~/.kanna/cloud.json — the machine's cloud pairing credentials, written by
 * `kanna pair <code>` and read on every launch for sticky auto-enable.
 * Contains secrets (machineToken, proxySecret) → written with mode 600.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getCloudFilePath } from "../../shared/branding"
import { DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import { PROD_SERVER_PORT } from "../../shared/ports"

/**
 * How this machine is reachable from the proxy:
 *  - "tunnel" (default): via its named Cloudflare tunnel (cloudflared connector).
 *  - "direct": the proxy forwards straight to `tunnelHost` (an E2B dev-box's
 *    public sandbox URL) — no connector; liveness is a plain heartbeat loop.
 */
export type CloudConnectMode = "tunnel" | "direct"

export interface CloudIdentity {
  /** Control-plane base URL, e.g. "https://kanna.sh/api/cloud". */
  controlUrl: string
  /** Durable bearer credential for the control plane. */
  machineToken: string
  /** Shared secret the proxy sends on every forwarded request. */
  proxySecret: string
  /** e.g. "jakemor-mbp" */
  subdomain: string
  /** e.g. "https://jakemor-mbp.kanna.sh" */
  appOrigin: string
  /** Connector credential for this machine's named Cloudflare tunnel. Empty in direct mode. */
  tunnelToken: string
  /**
   * Public hostname this machine serves on: the permanent tunnel hostname
   * ("tun-<machineId>.kanna.sh") in tunnel mode, or the sandbox host
   * ("3210-<sandboxId>.e2b.app") in direct mode.
   */
  tunnelHost: string
  /** Sticky flag: bring this machine online on every plain `kanna` run. */
  enabled: boolean
  /** Absent means "tunnel" (every pre-devbox cloud.json in the wild). */
  mode?: CloudConnectMode
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Parse a cloud.json payload. Returns null (with a warning) when required
 * fields are missing — a broken file should behave like no pairing at all.
 */
export function normalizeCloudIdentity(
  value: unknown,
  warn: (message: string) => void = () => {},
  env: Record<string, string | undefined> = process.env,
): CloudIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("cloud.json is not an object — ignoring it")
    return null
  }

  const source = value as Record<string, unknown>
  const mode: CloudConnectMode = source.mode === "direct" ? "direct" : "tunnel"
  const machineToken = normalizeString(source.machineToken)
  const proxySecret = normalizeString(source.proxySecret)
  const subdomain = normalizeString(source.subdomain)
  const appOrigin = normalizeString(source.appOrigin).replace(/\/$/, "")
  const tunnelToken = normalizeString(source.tunnelToken)
  let tunnelHost = normalizeString(source.tunnelHost).replace(/^https?:\/\//, "").replace(/\/$/, "")

  // A dev-box identity may omit its own host — E2B injects the sandbox id
  // into the environment, and the app port is fixed.
  if (!tunnelHost && mode === "direct" && env.E2B_SANDBOX_ID) {
    tunnelHost = `${PROD_SERVER_PORT}-${env.E2B_SANDBOX_ID}.e2b.app`
  }

  const missing = [
    !machineToken && "machineToken",
    !proxySecret && "proxySecret",
    !subdomain && "subdomain",
    !appOrigin && "appOrigin",
    // Direct mode has no connector, so no connector credential.
    mode !== "direct" && !tunnelToken && "tunnelToken",
    !tunnelHost && "tunnelHost",
  ].filter(Boolean)
  if (missing.length > 0) {
    warn(`cloud.json is missing ${missing.join(", ")} — run \`kanna pair\` again`)
    return null
  }

  return {
    controlUrl: normalizeString(source.controlUrl) || DEFAULT_CLOUD_CONTROL_URL,
    machineToken,
    proxySecret,
    subdomain,
    appOrigin,
    tunnelToken,
    tunnelHost,
    enabled: source.enabled !== false,
    // Keep tunnel-mode files byte-stable: only direct mode writes the field.
    ...(mode === "direct" ? { mode } : {}),
  }
}

export function getDefaultCloudIdentityPath() {
  return getCloudFilePath(homedir())
}

export async function readCloudIdentity(
  filePath = getDefaultCloudIdentityPath(),
  warn: (message: string) => void = () => {},
): Promise<CloudIdentity | null> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn(`cloud.json at ${filePath} is not valid JSON — ignoring it`)
    return null
  }

  return normalizeCloudIdentity(parsed, warn)
}

/** Atomic write (tmp + rename) with mode 600 — the file holds secrets. */
export async function writeCloudIdentity(
  identity: CloudIdentity,
  filePath = getDefaultCloudIdentityPath(),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  await chmod(tempPath, 0o600)
  await rename(tempPath, filePath)
}

export async function deleteCloudIdentity(
  filePath = getDefaultCloudIdentityPath(),
): Promise<boolean> {
  try {
    await unlink(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false
    }
    throw error
  }
}
