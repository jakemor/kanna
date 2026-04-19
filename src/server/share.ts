import { existsSync } from "node:fs"
import { renderANSI } from "uqr"
import { ConfigHandler, Tunnel, bin as cloudflaredBin, install as installCloudflared } from "cloudflared"
import type { ShareMode } from "../shared/share"
import { isTokenShareMode } from "../shared/share"

export interface StartedShareTunnel {
  publicUrl: string | null
  stop: () => void
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
}

export interface ShareTunnelDeps {
  cloudflaredBin?: string
  existsSync?: (path: string) => boolean
  installCloudflared?: (to: string) => Promise<string>
  createQuickTunnel?: (localUrl: string) => ShareTunnelProcess
  createNamedTunnel?: (token: string, localUrl: string) => ShareTunnelProcess
  log?: (message: string) => void
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

async function awaitQuickTunnelUrl(tunnel: ShareTunnelProcess) {
  return await new Promise<string>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      tunnel.off("url", handleUrl)
      tunnel.off("error", handleError)
      tunnel.off("exit", handleExit)
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

    const handleError = (error: Error) => {
      settle(() => reject(error))
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => reject(new Error(`Cloudflare tunnel exited before a public URL was ready (code: ${String(code)}, signal: ${String(signal)})`)))
    }

    tunnel.once("url", handleUrl)
    tunnel.once("error", handleError)
    tunnel.once("exit", handleExit)
  })
}

async function awaitNamedTunnelReady(tunnel: ShareTunnelProcess) {
  return await new Promise<string | null>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      tunnel.off("url", handleUrl)
      tunnel.off("connected", handleConnected)
      tunnel.off("error", handleError)
      tunnel.off("exit", handleExit)
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
      settle(() => resolve(null))
    }

    const handleError = (error: Error) => {
      settle(() => reject(error))
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => reject(new Error(`Cloudflare tunnel exited before it was ready (code: ${String(code)}, signal: ${String(signal)})`)))
    }

    tunnel.once("url", handleUrl)
    tunnel.once("connected", handleConnected)
    tunnel.once("error", handleError)
    tunnel.once("exit", handleExit)
  })
}

export async function startShareTunnel(
  localUrl: string,
  shareMode: Exclude<ShareMode, false> = "quick",
  deps: ShareTunnelDeps = {},
): Promise<StartedShareTunnel> {
  await ensureCloudflaredInstalled(deps)
  const tunnel = isTokenShareMode(shareMode)
    ? (deps.createNamedTunnel ?? createNamedTunnel)(shareMode.token, localUrl)
    : (deps.createQuickTunnel ?? ((url) => Tunnel.quick(url)))(localUrl)
  const publicUrl = isTokenShareMode(shareMode)
    ? await awaitNamedTunnelReady(tunnel)
    : await awaitQuickTunnelUrl(tunnel)

  return {
    publicUrl,
    stop: () => {
      tunnel.stop()
    },
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
