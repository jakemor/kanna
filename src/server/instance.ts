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
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { getDataDir } from "../shared/branding"
import { Machine } from "./platform/machine"

/** Non-reversible identifier for a data dir (safe on the public /health). */
export function instanceFingerprint(dataDir: string) {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16)
}

export interface ExistingInstance {
  localUrl: string
  port: number
}

/** Nothing usable answered /health on the port. Never escapes the probe. */
class InstanceProbeError extends Schema.TaggedError<InstanceProbeError>()(
  "@kanna/server/instance/InstanceProbeError",
  {
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {}

/** The part of a Kanna /health answer the probe checks. */
const InstanceHealth = Schema.Struct({
  ok: Schema.Literal(true),
  instance: Schema.String,
})

const PROBE_TIMEOUT = "700 millis"

/**
 * Returns the running same-data-dir instance on the given port, or null.
 * Anything unexpected (nothing listening, foreign server, other data dir)
 * gives null so startup proceeds normally.
 */
export const probeExistingInstance = Effect.fn("Instance.probeExisting")(function* (
  port: number,
  dataDir?: string,
  fetchImpl: typeof fetch = fetch,
) {
  yield* Effect.annotateCurrentSpan("port", port)
  const expected = instanceFingerprint(dataDir ?? getDataDir((yield* Machine).homeDirectory))
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(`http://127.0.0.1:${port}/health`, { signal }),
    catch: (cause) => new InstanceProbeError({ port, cause }),
  })
  if (!response.ok) return null
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new InstanceProbeError({ port, cause }),
  })
  const health = Schema.decodeUnknownOption(InstanceHealth)(body)
  if (Option.isNone(health) || health.value.instance !== expected) return null
  return { localUrl: `http://localhost:${port}`, port } satisfies ExistingInstance
}, (effect) => effect.pipe(
  Effect.timeoutOption(PROBE_TIMEOUT),
  Effect.map(Option.getOrNull),
  Effect.catchTag("@kanna/server/instance/InstanceProbeError", () => Effect.succeed(null)),
))
