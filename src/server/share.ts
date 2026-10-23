import { renderANSI } from "uqr"
import { ConfigHandler, Tunnel, bin as cloudflaredBin, install as installCloudflared } from "cloudflared"
import { Deferred, Effect, Exit, FileSystem, Schema } from "effect"
import type { ShareMode } from "../shared/share"
import { isTokenShareMode } from "../shared/share"

export interface StartedShareTunnel {
  publicUrl: string | null
  stop: () => void
  /** Completes when the cloudflared process exits, for any reason. */
  exited?: Effect.Effect<void>
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

/** Downloading the cloudflared binary failed. */
export class CloudflaredInstallError extends Schema.TaggedError<CloudflaredInstallError>()(
  "@kanna/server/share/CloudflaredInstallError",
  {
    binPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** cloudflared reported an error before the tunnel was ready. The message is its own. */
export class ShareTunnelError extends Schema.TaggedError<ShareTunnelError>()(
  "@kanna/server/share/ShareTunnelError",
  {
    localUrl: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** cloudflared exited before the tunnel was ready. */
export class ShareTunnelExitedError extends Schema.TaggedError<ShareTunnelExitedError>()(
  "@kanna/server/share/ShareTunnelExitedError",
  {
    localUrl: Schema.String,
    expectedUrl: Schema.Boolean,
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
  },
) {
  override get message() {
    const readyState = this.expectedUrl ? "a public URL was ready" : "it was ready"
    return `Cloudflare tunnel exited before ${readyState} (code: ${String(this.code)}, signal: ${String(this.signal)})`
  }
}

/** The QR code for `url`, drawn with ANSI blocks for a terminal. */
export function renderTerminalQr(url: string) {
  return renderANSI(url, {
    ecc: "L",
    border: 2,
  })
}

/** The cloudflared binary's path, downloading it first when it is missing. */
export const ensureCloudflaredInstalled = Effect.fn("Share.ensureCloudflaredInstalled")(function* (
  deps: ShareTunnelDeps = {},
) {
  const resolvedBin = deps.cloudflaredBin ?? cloudflaredBin
  const exists = deps.existsSync
    ? Effect.sync(() => deps.existsSync!(resolvedBin))
    : (yield* FileSystem.FileSystem).exists(resolvedBin).pipe(Effect.orElseSucceed(() => false))
  const installBinary = deps.installCloudflared ?? installCloudflared

  if (yield* exists) {
    return resolvedBin
  }

  deps.log?.("installing cloudflared binary")
  yield* Effect.tryPromise({
    try: () => installBinary(resolvedBin),
    catch: (cause) => new CloudflaredInstallError({ binPath: resolvedBin, cause }),
  })
  return resolvedBin
})

function normalizePublicUrl(url: string) {
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

function createNamedTunnel(token: string, localUrl: string) {
  const tunnel = Tunnel.withToken(token, { "--url": localUrl })
  new ConfigHandler(tunnel)
  return tunnel
}

/**
 * Waits for the tunnel's public URL (quick tunnels) or its first connection
 * (named tunnels, whose hostname cloudflared may never print).
 */
function awaitTunnelReady(tunnel: ShareTunnelProcess, localUrl: string, expectUrl: boolean) {
  return Effect.callback<string | null, ShareTunnelError | ShareTunnelExitedError>((resume) => {
    const cleanup = () => {
      tunnel.off("url", handleUrl)
      tunnel.off("connected", handleConnected)
      tunnel.off("error", handleError)
      tunnel.off("exit", handleExit)
    }
    const settle = (effect: Effect.Effect<string | null, ShareTunnelError | ShareTunnelExitedError>) => {
      cleanup()
      resume(effect)
    }

    const handleUrl = (url: string) => settle(Effect.succeed(normalizePublicUrl(url)))
    const handleConnected = () => {
      if (expectUrl) return
      settle(Effect.succeed(null))
    }
    const handleError = (error: Error) => settle(Effect.fail(new ShareTunnelError({ localUrl, cause: error })))
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(Effect.fail(new ShareTunnelExitedError({ localUrl, expectedUrl: expectUrl, code, signal })))

    tunnel.once("url", handleUrl)
    if (!expectUrl) {
      tunnel.once("connected", handleConnected)
    }
    tunnel.once("error", handleError)
    tunnel.once("exit", handleExit)
    return Effect.sync(cleanup)
  })
}

/**
 * Starts cloudflared for `localUrl`: a quick tunnel, or a named one for a
 * token. The caller owns the result and calls `stop`; if this is interrupted
 * before the tunnel is ready, the process is stopped here.
 */
export const startShareTunnel = Effect.fn("Share.startShareTunnel")(function* (
  localUrl: string,
  shareMode: Exclude<ShareMode, false> = "quick",
  deps: ShareTunnelDeps = {},
) {
  yield* ensureCloudflaredInstalled(deps)
  const namedTunnel = isTokenShareMode(shareMode)
  const tunnel = namedTunnel
    ? (deps.createNamedTunnel ?? createNamedTunnel)(shareMode.token, localUrl)
    : (deps.createQuickTunnel ?? ((url) => Tunnel.quick(url)))(localUrl)
  const publicUrl = yield* awaitTunnelReady(tunnel, localUrl, !namedTunnel).pipe(
    Effect.onInterrupt(() => Effect.sync(() => {
      tunnel.stop()
    })),
  )
  const exited = Deferred.makeUnsafe<void>()
  tunnel.once("exit", () => {
    Deferred.doneUnsafe(exited, Exit.void)
  })

  return {
    publicUrl,
    stop: () => {
      tunnel.stop()
    },
    exited: Deferred.await(exited),
  } satisfies StartedShareTunnel
})

/**
 * Prints the share's QR code, public URL and local URL. This is the CLI's
 * terminal output, not logging: `log` writes the lines as they are.
 */
export function logShareDetails(
  log: (message: string) => void,
  publicUrl: string,
  localUrl: string,
  renderShareQrImpl: (url: string) => string = renderTerminalQr,
) {
  const qrCode = renderShareQrImpl(publicUrl)

  log("QR Code:")
  log(qrCode.trimEnd())
  log("")
  log("Public URL:")
  log(publicUrl)
  log("")
  log("Local URL:")
  log(localUrl)
}
