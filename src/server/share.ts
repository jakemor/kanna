import { existsSync } from "node:fs"
import { renderANSI } from "uqr"
import { ConfigHandler, Tunnel, bin as cloudflaredBin, install as installCloudflared } from "cloudflared"
import type { ShareMode } from "../shared/share"
import { isTokenShareMode } from "../shared/share"

export interface StartedShareTunnel {
  publicUrl: string | null
  stop: () => void
  /** Resolves when the cloudflared process exits, for any reason. */
  exited?: Promise<void>
}

export interface ShareTunnelProcess {
  once(event: "url", listener: (url: string) => void): ShareTunnelProcess
  once(event: "connected", listener: () => void): ShareTunnelProcess
  once(event: "error", listener: (error: Error) => void): ShareTunnelProcess
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): ShareTunnelProcess
  off(event: "url", listener: (url: string) => void): ShareTunnelProcess
  off(event: "connected", listener: () => void): ShareTunnelProcess
  off(event: "error", listener: (error: Error) => void): ShareTunnelProcess
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): ShareTunnelProcess
  stop(): boolean
  /** The cloudflared child, for escalating a stop that SIGINT didn't finish. */
  readonly process?: { kill(signal?: NodeJS.Signals): boolean }
}

export interface StartShareTunnelOptions {
  /**
   * Gives up on readiness and stops the connector when aborted. Callers that
   * must not wait forever (the cloud supervisor) pass a deadline here.
   */
  signal?: AbortSignal
}

/**
 * cloudflared drains in-flight requests for up to 30s (its --grace-period)
 * after SIGINT. Past that it is stuck, so stop() follows up with SIGKILL
 * rather than leave an orphaned connector behind a restart.
 */
const CONNECTOR_STOP_GRACE_MS = 35_000

export interface ShareTunnelDeps {
  cloudflaredBin?: string
  existsSync?: (path: string) => boolean
  installCloudflared?: (to: string) => Promise<string>
  createQuickTunnel?: (localUrl: string) => ShareTunnelProcess
  createNamedTunnel?: (token: string, localUrl: string) => ShareTunnelProcess
  log?: (message: string) => void
  stopGraceMs?: number
}

export async function renderTerminalQr(url: string) {
  return renderANSI(url, {
    ecc: "L",
    border: 2,
  })
}

export async function ensureCloudflaredInstalled(
  deps: ShareTunnelDeps = {},
) {
  const resolvedBin = deps.cloudflaredBin ?? cloudflaredBin
  const fileExists = deps.existsSync ?? existsSync
  const installBinary = deps.installCloudflared ?? installCloudflared

  if (fileExists(resolvedBin)) {
    return resolvedBin
  }

  deps.log?.("installing cloudflared binary")
  await installBinary(resolvedBin)
  return resolvedBin
}

function normalizePublicUrl(url: string) {
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

function createNamedTunnel(token: string, localUrl: string) {
  const tunnel = Tunnel.withToken(token, { "--url": localUrl })
  new ConfigHandler(tunnel)
  return tunnel
}

async function awaitTunnelReady(
  tunnel: ShareTunnelProcess,
  { expectUrl, signal }: { expectUrl: boolean; signal?: AbortSignal },
) {
  return await new Promise<string | null>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      tunnel.off("url", handleUrl)
      tunnel.off("connected", handleConnected)
      tunnel.off("error", handleError)
      tunnel.off("exit", handleExit)
      signal?.removeEventListener("abort", handleAbort)
    }

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const handleUrl = (url: string) => {
      settle(() => resolve(normalizePublicUrl(url)))
    }

    const handleConnected = () => {
      if (expectUrl) return
      settle(() => resolve(null))
    }

    const handleError = (error: Error) => {
      settle(() => reject(error))
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const readyState = expectUrl ? "a public URL was ready" : "it was ready"
      settle(() => reject(new Error(`Cloudflare tunnel exited before ${readyState} (code: ${String(code)}, signal: ${String(signal)})`)))
    }

    const handleAbort = () => {
      settle(() => reject(signal?.reason ?? new Error("Cloudflare tunnel start was cancelled")))
    }

    if (signal?.aborted) {
      handleAbort()
      return
    }
    signal?.addEventListener("abort", handleAbort, { once: true })
    tunnel.once("url", handleUrl)
    if (!expectUrl) {
      tunnel.once("connected", handleConnected)
    }
    tunnel.once("error", handleError)
    tunnel.once("exit", handleExit)
  })
}

export async function startShareTunnel(
  localUrl: string,
  shareMode: Exclude<ShareMode, false> = "quick",
  deps: ShareTunnelDeps = {},
  options: StartShareTunnelOptions = {},
): Promise<StartedShareTunnel> {
  await ensureCloudflaredInstalled(deps)
  options.signal?.throwIfAborted()
  const namedTunnel = isTokenShareMode(shareMode)
  const tunnel = namedTunnel
    ? (deps.createNamedTunnel ?? createNamedTunnel)(shareMode.token, localUrl)
    : (deps.createQuickTunnel ?? ((url) => Tunnel.quick(url)))(localUrl)

  // Listen for exit from the start, so an exit between readiness and the
  // caller's first await is not missed.
  let hasExited = false
  const exited = new Promise<void>((resolve) => {
    tunnel.once("exit", () => {
      hasExited = true
      resolve()
    })
  })
  // An "error" emitted with no listener throws out of cloudflared's stdout
  // handler. awaitTunnelReady listens only until it settles, so keep one here.
  const handleLateError = (error: Error) => {
    deps.log?.(`cloudflared error: ${error.message}`)
    tunnel.once("error", handleLateError)
  }

  // Idempotent: a second SIGINT makes cloudflared skip its graceful drain.
  let stopRequested = false
  const stop = () => {
    if (hasExited || stopRequested) return
    stopRequested = true
    tunnel.stop()
    const escalate = setTimeout(() => {
      if (!hasExited) tunnel.process?.kill("SIGKILL")
    }, deps.stopGraceMs ?? CONNECTOR_STOP_GRACE_MS)
    escalate.unref?.()
  }

  let publicUrl: string | null
  try {
    publicUrl = await awaitTunnelReady(tunnel, { expectUrl: !namedTunnel, signal: options.signal })
  } catch (error) {
    // A failed or abandoned start must not leave its process running.
    stop()
    throw error
  }
  tunnel.once("error", handleLateError)

  return {
    publicUrl,
    stop,
    exited,
  }
}

export async function logShareDetails(
  log: (message: string) => void,
  publicUrl: string,
  localUrl: string,
  renderShareQrImpl: (url: string) => Promise<string> = renderTerminalQr,
) {
  const qrCode = await renderShareQrImpl(publicUrl)

  log("QR Code:")
  log(qrCode.trimEnd())
  log("")
  log("Public URL:")
  log(publicUrl)
  log("")
  log("Local URL:")
  log(localUrl)
}
