/**
 * `kanna pair` subcommand: exchange a kanna.sh pairing code for machine
 * credentials, plus --status/--disable/--enable/--remove management.
 * Everything is DI'd so cli-runtime tests can drive it without network or
 * filesystem access.
 */

import process from "node:process"
import { createInterface } from "node:readline/promises"
import { renderANSI } from "uqr"
import { getCloudFilePathDisplay, LOG_PREFIX } from "../../shared/branding"
import { getMachineDisplayName } from "../machine-name"
import { CloudApiError, createCloudApiClient, type CloudApiClient } from "./api-client"
import {
  deleteCloudIdentity,
  readCloudIdentity,
  writeCloudIdentity,
  type CloudIdentity,
} from "./identity"
import { createPairSessionManager, type PairSessionManager } from "./pair-session"

export type PairAction = "pair" | "status" | "disable" | "enable" | "remove"

export interface PairCommandArgs {
  action: PairAction
  pairingCode: string | null
}

export interface PairCommandDeps {
  log: (message: string) => void
  warn: (message: string) => void
  readIdentity?: (warn?: (message: string) => void) => Promise<CloudIdentity | null>
  writeIdentity?: (identity: CloudIdentity) => Promise<void>
  deleteIdentity?: () => Promise<boolean>
  createApiClient?: (controlUrl?: string) => CloudApiClient
  getMachineName?: () => string
  confirm?: (question: string) => Promise<boolean>
  /** Device-code flow seams (bare `kanna pair`). */
  createPairSession?: typeof createPairSessionManager
  renderQr?: (url: string) => string
  sleep?: (ms: number) => Promise<void>
}

async function promptConfirm(question: string) {
  if (!process.stdin.isTTY) {
    return true
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** How often the terminal flow re-reads the (server-side) session state. */
const DEVICE_FLOW_TICK_MS = 500

/**
 * Bare `kanna pair`: machine-initiated pairing. Prints the claim URL + QR and
 * blocks until the browser half finishes, then writes credentials — the same
 * session manager the sidebar's one-click flow uses.
 */
async function runDeviceCodePairing(args: {
  identity: CloudIdentity | null
  log: (message: string) => void
  warn: (message: string) => void
  createPairSession: typeof createPairSessionManager
  createApiClient: (controlUrl?: string) => CloudApiClient
  writeIdentity: (identity: CloudIdentity) => Promise<void>
  getMachineName: () => string
  renderQr: (url: string) => string
  sleep: (ms: number) => Promise<void>
}): Promise<number> {
  const { log, warn } = args
  if (args.identity) {
    warn(`${LOG_PREFIX} this machine is already paired as ${args.identity.appOrigin} — re-pairing replaces it`)
  }

  let manager: PairSessionManager
  try {
    manager = args.createPairSession({
      machineName: args.getMachineName(),
      createApiClient: () => args.createApiClient(),
      onPaired: (identity) => args.writeIdentity(identity),
    })
  } catch (error) {
    warn(`${LOG_PREFIX} pairing failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const started = await manager.start()
  if (started.status !== "waiting" || !started.claimUrl) {
    warn(`${LOG_PREFIX} could not start pairing${started.error ? `: ${started.error}` : ""}`)
    return 1
  }

  log("")
  log(args.renderQr(started.claimUrl))
  log(`${LOG_PREFIX} open this link (or scan the code) to claim this machine:`)
  log(started.claimUrl)
  log(`${LOG_PREFIX} waiting…`)

  let snapshot = manager.status()
  while (snapshot.status === "waiting") {
    await args.sleep(DEVICE_FLOW_TICK_MS)
    snapshot = manager.status()
  }
  manager.stop()

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
}

/** Returns the process exit code. */
export async function runPairCommand(args: PairCommandArgs, deps: PairCommandDeps): Promise<number> {
  const readIdentity = deps.readIdentity ?? ((warn?: (message: string) => void) => readCloudIdentity(undefined, warn))
  const writeIdentity = deps.writeIdentity ?? ((identity: CloudIdentity) => writeCloudIdentity(identity))
  const deleteIdentity = deps.deleteIdentity ?? (() => deleteCloudIdentity())
  const createApiClient = deps.createApiClient ?? ((controlUrl?: string) => createCloudApiClient({ controlUrl }))
  const getMachineName = deps.getMachineName ?? getMachineDisplayName
  const confirm = deps.confirm ?? promptConfirm
  const { log, warn } = deps

  // While pairing, an unreadable/outdated cloud.json is irrelevant — it's
  // about to be replaced, so don't tell the user to "run kanna pair again"
  // mid-pair. For the management actions the warning matters.
  const identity = await readIdentity(
    args.action === "pair" ? () => {} : (message) => warn(`${LOG_PREFIX} ${message}`),
  )

  switch (args.action) {
    case "pair": {
      if (!args.pairingCode) {
        // No code: run the device flow right here — print a claim link (and a
        // QR for phones) and wait for someone to name the machine on kanna.sh.
        return runDeviceCodePairing({
          identity,
          log,
          warn,
          createPairSession: deps.createPairSession ?? createPairSessionManager,
          createApiClient,
          writeIdentity,
          getMachineName,
          renderQr: deps.renderQr ?? ((url) => renderANSI(url, { ecc: "L", border: 2 })),
          sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        })
      }
      if (identity) {
        warn(`${LOG_PREFIX} this machine is already paired as ${identity.appOrigin} — re-pairing replaces it`)
      }

      const client = createApiClient()
      let response
      try {
        response = await client.pair(args.pairingCode, getMachineName())
      } catch (error) {
        if (error instanceof CloudApiError && (error.status === 404 || error.status === 410)) {
          warn(`${LOG_PREFIX} that pairing code is ${error.status === 410 ? "expired" : "invalid"} — generate a new one at https://kanna.sh/fleet`)
          return 1
        }
        warn(`${LOG_PREFIX} pairing failed: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }

      await writeIdentity({
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
    }

    case "status": {
      if (!identity) {
        log(`${LOG_PREFIX} not paired — get a pairing code at https://kanna.sh/fleet`)
        return 0
      }
      log(`${LOG_PREFIX} paired as ${identity.appOrigin}${identity.enabled ? "" : " (disabled)"}`)
      log(`${LOG_PREFIX} control plane: ${identity.controlUrl}`)
      log(`${LOG_PREFIX} cloud ${identity.enabled ? "starts with every `kanna` run (disable with `kanna pair --disable`)" : "is disabled (enable with `kanna pair --enable`)"}`)
      return 0
    }

    case "disable":
    case "enable": {
      if (!identity) {
        warn(`${LOG_PREFIX} not paired — nothing to ${args.action}`)
        return 1
      }
      const enabled = args.action === "enable"
      await writeIdentity({ ...identity, enabled })
      log(`${LOG_PREFIX} cloud ${enabled ? "enabled — run `kanna` to bring this machine online" : "disabled — `kanna` stays local-only (one that is running goes offline within a few seconds)"}`)
      return 0
    }

    case "remove": {
      if (!identity) {
        warn(`${LOG_PREFIX} not paired — nothing to remove`)
        return 1
      }
      const confirmed = await confirm(`Remove this machine (${identity.appOrigin}) from kanna.sh?`)
      if (!confirmed) {
        log(`${LOG_PREFIX} cancelled`)
        return 0
      }

      try {
        await createApiClient(identity.controlUrl).removeMachine(identity.machineToken)
      } catch (error) {
        // Best effort — the machine may already be revoked server-side.
        warn(`${LOG_PREFIX} could not remove the machine on kanna.sh (${error instanceof Error ? error.message : String(error)}); deleting local credentials anyway`)
        // Said plainly: "unpaired" below is this machine's half only.
        warn(`${LOG_PREFIX} kanna.sh may still list this machine. Remove it there too: https://kanna.sh/fleet`)
      }
      await deleteIdentity()
      log(`${LOG_PREFIX} unpaired — local credentials deleted (a running kanna goes offline within a few seconds)`)
      return 0
    }
  }
}
