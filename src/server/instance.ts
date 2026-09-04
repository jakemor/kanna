/**
 * Single-instance detection. Two kanna processes sharing one data dir means
 * two writers on the same JSONL logs — and, when paired with kanna.sh, two
 * tunnel connectors load-balancing requests between divergent processes.
 *
 * /health exposes a non-reversible fingerprint of the data dir; before
 * starting, the CLI probes its configured port and short-circuits ("already
 * running") when the same-data-dir instance answers. Different fingerprints
 * (e.g. a dev-profile instance) keep today's try-next-port behavior.
 */

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir } from "../shared/branding"

/** Non-reversible identifier for a data dir (safe on the public /health). */
export function instanceFingerprint(dataDir: string = getDataDir(homedir())) {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16)
}

export interface ExistingInstance {
  localUrl: string
  port: number
  /**
   * Whether that instance serves the REST API. Absent from an instance older
   * than this field, which is indistinguishable from "no API" here — either
   * way `--api` cannot take effect without restarting it.
   */
  api?: boolean
}

/**
 * Returns the running same-data-dir instance on the given port, or null.
 * Anything unexpected (nothing listening, foreign server, other data dir)
 * resolves null so startup proceeds normally.
 */
export async function probeExistingInstance(
  port: number,
  dataDir?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExistingInstance | null> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(700),
    })
    if (!response.ok) return null
    const payload = await response.json() as { ok?: unknown; instance?: unknown; api?: unknown }
    if (payload.ok !== true || typeof payload.instance !== "string") return null
    if (payload.instance !== instanceFingerprint(dataDir)) return null
    return { localUrl: `http://localhost:${port}`, port, api: payload.api === true }
  } catch {
    return null
  }
}
