/**
 * ~/.kanna/cloud.json — the machine's cloud pairing credentials, written by
 * `kanna pair <code>` and read on every launch for sticky auto-enable.
 * Contains secrets (machineToken, proxySecret) → written with mode 600.
 */

import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { getCloudFilePath } from "../../shared/branding"
import { DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import { PROD_SERVER_PORT } from "../../shared/ports"
import { HostProcess } from "../platform/host-process"
import { Machine } from "../platform/machine"

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
  warn: (message: string) => void,
  /** The machine's environment (`Machine.env`): a dev-box's host can come from it. */
  env: Record<string, string | undefined>,
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

/** cloud.json under `homeDir`, the machine's home (`Machine.homeDirectory`). */
export function getDefaultCloudIdentityPath(homeDir: string) {
  return getCloudFilePath(homeDir)
}

/** cloud.json could not be read, written or deleted (never its contents: they are secrets). */
export class CloudIdentityFileError extends Schema.TaggedError<CloudIdentityFileError>()(
  "@kanna/server/cloud/identity/CloudIdentityFileError",
  {
    operation: Schema.Literals(["read", "write", "delete"]),
    filePath: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const fileError = (operation: CloudIdentityFileError["operation"], filePath: string) => (cause: PlatformError) =>
  Effect.fail(new CloudIdentityFileError({ operation, filePath, message: cause.message, cause }))

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** null when there is no cloud.json, or when it is unusable (with a warning). */
export const readCloudIdentity = Effect.fn("CloudIdentity.read")(function* (
  filePathOverride?: string,
  warn: (message: string) => void = () => {},
) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const filePath = filePathOverride ?? getDefaultCloudIdentityPath(machine.homeDirectory)
  const raw = yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", fileError("read", filePath)),
  )
  if (Option.isNone(raw)) return null

  return yield* decodeJson(raw.value).pipe(
    Effect.map((parsed) => normalizeCloudIdentity(parsed, warn, machine.env.snapshot())),
    Effect.catchTag("SchemaError", () => Effect.sync(() => {
      warn(`cloud.json at ${filePath} is not valid JSON — ignoring it`)
      return null
    })),
  )
})

/** Atomic write (tmp + rename) with mode 600 — the file holds secrets. */
export const writeCloudIdentity = Effect.fn("CloudIdentity.write")(function* (
  identity: CloudIdentity,
  filePathOverride?: string,
) {
  const fs = yield* FileSystem.FileSystem
  const filePath = filePathOverride ?? getDefaultCloudIdentityPath((yield* Machine).homeDirectory)
  const tempPath = `${filePath}.tmp-${(yield* HostProcess).pid}-${Date.now()}`
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })),
    Effect.andThen(fs.chmod(tempPath, 0o600)),
    Effect.andThen(fs.rename(tempPath, filePath)),
    Effect.catchTag("PlatformError", fileError("write", filePath)),
  )
})

/** true when a cloud.json was there to delete. */
export const deleteCloudIdentity = Effect.fn("CloudIdentity.delete")(function* (
  filePathOverride?: string,
) {
  const fs = yield* FileSystem.FileSystem
  const filePath = filePathOverride ?? getDefaultCloudIdentityPath((yield* Machine).homeDirectory)
  return yield* fs.remove(filePath).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    Effect.catchTag("PlatformError", fileError("delete", filePath)),
  )
})
