import type { AllowlistCacheKey, ProbeResult, SuiteResult } from "./types"
import { PROBE_CONTRACT_VERSION } from "./types"
import { aggregateProbes } from "./suite"
import { createPreflightCache, type PreflightCache } from "./cache"
import { computeBinarySha256 } from "./binary-fingerprint"

export interface PreflightGateArgs {
  toolsString: string
  now: () => number
  runSuite: () => Promise<ProbeResult[]>
  cache?: PreflightCache
}

export interface CanSpawnArgs {
  binaryPath: string
  model: string
}

/**
 * `binarySha256` returned on `{ok:true}` is the hash the suite ran
 * against. Driver passes it to `verifyBinaryUnchanged(...)` immediately
 * before spawn so any in-between modification of the `claude` binary
 * (TOCTOU window) is detected and the spawn is refused. Narrows the
 * gate→exec window from "seconds to minutes" to "one extra hash
 * delta".
 */
export interface PreflightGate {
  canSpawn(args: CanSpawnArgs): Promise<{ ok: true; binarySha256: string } | { ok: false; reason: string }>
  invalidateAll(): void
}

/**
 * Recompute the binary sha256 right before `spawnPtyProcess` and assert
 * it matches the value the preflight ran against. The kanna PTY driver
 * is the only call-site; if you call this for any other reason, document
 * here why the gate's pre-hash is not enough.
 */
export async function verifyBinaryUnchanged(
  binaryPath: string,
  expectedSha256: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = await computeBinarySha256(binaryPath)
  if (now === expectedSha256) return { ok: true }
  return {
    ok: false,
    reason: `claude binary changed between preflight and spawn (sha256 ${expectedSha256.slice(0, 8)}... → ${now.slice(0, 8)}...)`,
  }
}

export function createPreflightGate(opts: PreflightGateArgs): PreflightGate {
  const cache = opts.cache ?? createPreflightCache({ now: opts.now })
  const inflight = new Map<string, Promise<ProbeResult[]>>()

  function keyHash(k: AllowlistCacheKey): string {
    return `${k.binarySha256}|${k.toolsString}|${k.systemInitModel}|${k.probeContractVersion}`
  }

  return {
    async canSpawn(args) {
      const binarySha256 = await computeBinarySha256(args.binaryPath)
      const key: AllowlistCacheKey = {
        binarySha256,
        toolsString: opts.toolsString,
        systemInitModel: args.model,
        probeContractVersion: PROBE_CONTRACT_VERSION,
      }
      const cached = cache.get(key)
      if (cached && cached.verdict === "pass") {
        return { ok: true, binarySha256 }
      }
      if (cached && cached.verdict !== "pass") {
        return { ok: false, reason: summarizeFailure(cached.probes) }
      }
      const inflightKey = keyHash(key)
      let promise = inflight.get(inflightKey)
      if (!promise) {
        promise = opts.runSuite()
        inflight.set(inflightKey, promise)
        // Settle handler doubles as the only consumer of the promise's
        // rejection so a thrown suite does not surface as an unhandled
        // rejection; the caller's own `await promise` in the try/catch
        // below is what actually drives the fail-closed path.
        const settle = () => inflight.delete(inflightKey)
        promise.then(settle, settle)
      }
      let probes: ProbeResult[]
      try {
        probes = await promise
      } catch (err) {
        // FAIL-CLOSED: a thrown suite (spawn error, fs failure, probe
        // crash) must refuse the spawn, not propagate an unhandled
        // rejection that the caller might treat as "no error → allow".
        // Not cached: the next spawn re-probes (transient failures should
        // not pin a 24h refusal).
        const reason = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `preflight suite error (fail-closed): ${reason}` }
      }
      const verdict = aggregateProbes(probes).verdict
      const result: SuiteResult = { key, verdict, probes, probedAt: opts.now() }
      cache.put(result)
      if (verdict === "pass") return { ok: true, binarySha256 }
      return { ok: false, reason: summarizeFailure(probes) }
    },
    invalidateAll() {
      cache.clear()
    },
  }
}

function summarizeFailure(probes: ProbeResult[]): string {
  const fails = probes.filter((p) => p.kind === "fail")
  if (fails.length > 0) {
    return `built-in reachable: ${fails.map((f) => f.builtin).join(", ")}`
  }
  const ind = probes.filter((p) => p.kind === "indeterminate")
  if (ind.length > 0) {
    return `indeterminate probes (fail-closed): ${ind.map((i) => i.builtin).join(", ")}`
  }
  return "unknown failure"
}
