/**
 * `kanna pair` subcommand: exchange a kanna.sh pairing code for machine
 * credentials, plus --status/--disable/--enable/--remove management.
 * Everything is DI'd so cli-runtime tests can drive it without network or
 * filesystem access.
 *
 * `log`/`warn` are the command's terminal output (a QR code, a bare URL), not
 * log lines, so they stay plain callbacks.
 */

import { Effect, type FileSystem, Match, Schedule, Schema } from "effect"
import { renderANSI } from "uqr"
import { getCloudFilePathDisplay, LOG_PREFIX } from "../../shared/branding"
import { getMachineDisplayName } from "../machine-name"
import type { HostProcess } from "../platform/host-process"
import { Machine } from "../platform/machine"
import type { ProcessSpawner } from "../platform/process-spawner"
import { createCloudApiClient, type CloudApiClient } from "./api-client"
import {
  deleteCloudIdentity,
  readCloudIdentity,
  writeCloudIdentity,
  type CloudIdentity,
  type CloudIdentityFileError,
} from "./identity"
import { createPairSessionManager, type PairSessionDeps, type PairSessionManager } from "./pair-session"

export type PairAction = "pair" | "status" | "disable" | "enable" | "remove"

export interface PairCommandArgs {
  action: PairAction
  pairingCode: string | null
}

/** The terminal's confirmation prompt could not be read. */
export class PairPromptError extends Schema.TaggedError<PairPromptError>()(
  "@kanna/server/cloud/pair-command/PairPromptError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type IdentityEffect<A> = Effect.Effect<A, CloudIdentityFileError, FileSystem.FileSystem | Machine | HostProcess>

export interface PairCommandDeps {
  log: (message: string) => void
  warn: (message: string) => void
  readIdentity?: (warn?: (message: string) => void) => IdentityEffect<CloudIdentity | null>
  writeIdentity?: (identity: CloudIdentity) => IdentityEffect<void>
  deleteIdentity?: () => IdentityEffect<boolean>
  createApiClient?: (controlUrl?: string) => CloudApiClient
  getMachineName?: () => Effect.Effect<string, never, MachineNameServices>
  /**
   * Asks the user a yes/no question. The CLI passes its terminal prompt
   * (cli-runtime.ts); without one, nobody is there to ask and the answer is yes.
   */
  confirm?: (question: string) => Effect.Effect<boolean, PairPromptError>
  /** Device-code flow seams (bare `kanna pair`). */
  createPairSession?: CreatePairSession
  renderQr?: (url: string) => string
}

type MachineNameServices = FileSystem.FileSystem | Machine | ProcessSpawner

type CreatePairSession = (
  deps: PairSessionDeps<MachineNameServices | HostProcess>,
) => Effect.Effect<PairSessionManager, never, MachineNameServices | HostProcess>

/** How often the terminal flow re-reads the (server-side) session state. */
const DEVICE_FLOW_TICK = "500 millis"

/**
 * Bare `kanna pair`: machine-initiated pairing. Prints the claim URL + QR and
 * blocks until the browser half finishes, then writes credentials — the same
 * session manager the sidebar's one-click flow uses.
 */
const runDeviceCodePairing = Effect.fn("PairCommand.deviceCode")(function* (args: {
  identity: CloudIdentity | null
  log: (message: string) => void
  warn: (message: string) => void
  createPairSession: CreatePairSession
  createApiClient: (controlUrl?: string) => CloudApiClient
  writeIdentity: (identity: CloudIdentity) => IdentityEffect<void>
  getMachineName: () => Effect.Effect<string, never, MachineNameServices>
  renderQr: (url: string) => string
}) {
  const { log, warn } = args
  if (args.identity) {
    warn(`${LOG_PREFIX} this machine is already paired as ${args.identity.appOrigin} — re-pairing replaces it`)
  }

  const manager = yield* args.createPairSession({
    machineName: yield* args.getMachineName(),
    createApiClient: () => args.createApiClient(),
    onPaired: (identity) => args.writeIdentity(identity),
  })

  const started = yield* manager.start
  if (started.status !== "waiting" || !started.claimUrl) {
    warn(`${LOG_PREFIX} could not start pairing${started.error ? `: ${started.error}` : ""}`)
    return 1
  }

  log("")
  log(args.renderQr(started.claimUrl))
  log(`${LOG_PREFIX} open this link (or scan the code) to claim this machine:`)
  log(started.claimUrl)
  log(`${LOG_PREFIX} waiting…`)

  const snapshot = yield* manager.status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(DEVICE_FLOW_TICK),
      until: (current) => current.status !== "waiting",
    }),
  )
  yield* manager.stop

  if (snapshot.status === "paired" && snapshot.appOrigin) {
    log(`${LOG_PREFIX} paired! this machine is now ${snapshot.appOrigin}`)
    log(`${LOG_PREFIX} credentials saved to ${getCloudFilePathDisplay()}`)
    return 0
  }
  if (snapshot.status === "expired") {
    warn(`${LOG_PREFIX} that link expired — run \`kanna pair\` again for a fresh one`)
    return 1
  }
  warn(`${LOG_PREFIX} pairing failed${snapshot.error ? `: ${snapshot.error}` : ""}`)
  return 1
})

/** Returns the process exit code. */
export const runPairCommand = Effect.fn("PairCommand.run")(function* (args: PairCommandArgs, deps: PairCommandDeps) {
  yield* Effect.annotateCurrentSpan("action", args.action)
  const readIdentity = deps.readIdentity ?? ((warn?: (message: string) => void) => readCloudIdentity(undefined, warn))
  const writeIdentity = deps.writeIdentity ?? ((identity: CloudIdentity) => writeCloudIdentity(identity))
  const deleteIdentity = deps.deleteIdentity ?? (() => deleteCloudIdentity())
  const machine = yield* Machine
  const createApiClient = deps.createApiClient ?? ((controlUrl?: string) => createCloudApiClient({ controlUrl, env: machine.env.snapshot() }))
  const getMachineName = deps.getMachineName ?? (() => getMachineDisplayName())
  const confirm = deps.confirm ?? (() => Effect.succeed(true))
  const { log, warn } = deps

  // While pairing, an unreadable/outdated cloud.json is irrelevant — it's
  // about to be replaced, so don't tell the user to "run kanna pair again"
  // mid-pair. For the management actions the warning matters.
  const identity = yield* readIdentity(
    args.action === "pair" ? () => {} : (message) => warn(`${LOG_PREFIX} ${message}`),
  )

  return yield* Match.value(args.action).pipe(
    Match.when("pair", () => Effect.gen(function* () {
      if (!args.pairingCode) {
        // No code: run the device flow right here — print a claim link (and a
        // QR for phones) and wait for someone to name the machine on kanna.sh.
        return yield* runDeviceCodePairing({
          identity,
          log,
          warn,
          createPairSession: deps.createPairSession ?? createPairSessionManager,
          createApiClient,
          writeIdentity,
          getMachineName,
          renderQr: deps.renderQr ?? ((url) => renderANSI(url, { ecc: "L", border: 2 })),
        })
      }
      if (identity) {
        warn(`${LOG_PREFIX} this machine is already paired as ${identity.appOrigin} — re-pairing replaces it`)
      }

      const client = createApiClient()
      const paired = yield* client.pair(args.pairingCode, yield* getMachineName()).pipe(Effect.result)
      if (paired._tag === "Failure") {
        const error = paired.failure
        if (error._tag === "@kanna/server/cloud/api-client/CloudApiError" && (error.status === 404 || error.status === 410)) {
          warn(`${LOG_PREFIX} that pairing code is ${error.status === 410 ? "expired" : "invalid"} — generate a new one at https://kanna.sh/fleet`)
          return 1
        }
        warn(`${LOG_PREFIX} pairing failed: ${error.message}`)
        return 1
      }
      const response = paired.success

      yield* writeIdentity({
        controlUrl: client.controlUrl,
        machineToken: response.machineToken,
        proxySecret: response.proxySecret,
        subdomain: response.subdomain,
        appOrigin: response.appOrigin,
        tunnelToken: response.tunnelToken,
        tunnelHost: response.tunnelHost,
        enabled: true,
      })

      log(`${LOG_PREFIX} paired! this machine is now ${response.appOrigin}`)
      log(`${LOG_PREFIX} credentials saved to ${getCloudFilePathDisplay()}`)
      return 0
    })),

    Match.when("status", () => Effect.sync(() => {
      if (!identity) {
        log(`${LOG_PREFIX} not paired — get a pairing code at https://kanna.sh/fleet`)
        return 0
      }
      log(`${LOG_PREFIX} paired as ${identity.appOrigin}${identity.enabled ? "" : " (disabled)"}`)
      log(`${LOG_PREFIX} control plane: ${identity.controlUrl}`)
      log(`${LOG_PREFIX} cloud ${identity.enabled ? "starts with every `kanna` run (disable with `kanna pair --disable`)" : "is disabled (enable with `kanna pair --enable`)"}`)
      return 0
    })),

    Match.whenOr("disable", "enable", (action) => Effect.gen(function* () {
      if (!identity) {
        warn(`${LOG_PREFIX} not paired — nothing to ${action}`)
        return 1
      }
      const enabled = action === "enable"
      yield* writeIdentity({ ...identity, enabled })
      log(`${LOG_PREFIX} cloud ${enabled ? "enabled — run `kanna` to bring this machine online" : "disabled — `kanna` stays local-only"}`)
      return 0
    })),

    Match.when("remove", () => Effect.gen(function* () {
      if (!identity) {
        warn(`${LOG_PREFIX} not paired — nothing to remove`)
        return 1
      }
      const confirmed = yield* confirm(`Remove this machine (${identity.appOrigin}) from kanna.sh?`)
      if (!confirmed) {
        log(`${LOG_PREFIX} cancelled`)
        return 0
      }

      yield* createApiClient(identity.controlUrl).removeMachine(identity.machineToken).pipe(
        // Best effort — the machine may already be revoked server-side.
        Effect.catchTags({
          "@kanna/server/cloud/api-client/CloudApiError": (error) => removeFailed(error),
          "@kanna/server/cloud/api-client/CloudNetworkError": (error) => removeFailed(error),
        }),
      )
      yield* deleteIdentity()
      log(`${LOG_PREFIX} unpaired — local credentials deleted`)
      return 0
    })),

    Match.exhaustive,
  )

  function removeFailed(error: Error) {
    return Effect.sync(() =>
      warn(`${LOG_PREFIX} could not remove the machine on kanna.sh (${error.message}); deleting local credentials anyway`))
  }
})
