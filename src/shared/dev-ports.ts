import type { ShareMode } from "./share"
import { assertNoHostOverride, getShareCliFlag, isShareEnabled } from "./share"

export const DEFAULT_DEV_CLIENT_PORT = 5174

export function getDefaultDevServerPort(clientPort = DEFAULT_DEV_CLIENT_PORT) {
  return clientPort + 1
}

export interface DevArgResolution {
  clientPort: number
  serverPort: number
  share: ShareMode
  backendTargetHost: string
  /** `--remote` or a non-loopback `--host`: Vite listens on every interface too. */
  lanBind: boolean
  /**
   * Names Vite answers to beyond localhost and IP literals, which it always
   * accepts. vite.config.ts adds the machine's own names under a LAN bind.
   */
  allowedHosts: true | string[]
  serverArgs: string[]
}

/** The env var that opens the dev client to the network (vite.config.ts). */
export const DEV_LAN_ENV = "KANNA_DEV_LAN"

function isLoopbackHost(host: string) {
  const value = host.trim().toLowerCase()
  return value === "localhost" || value === "::1" || value === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(value)
}

export function resolveDevPorts(args: string[]) {
  let clientPort = DEFAULT_DEV_CLIENT_PORT

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== "--port") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) {
      throw new Error("Missing value for --port")
    }

    clientPort = Number(next)
    index += 1
  }

  return {
    clientPort,
    serverPort: getDefaultDevServerPort(clientPort),
  }
}

export function stripPortArg(args: string[]) {
  const stripped: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--port") {
      index += 1
      continue
    }

    stripped.push(arg)
  }

  return stripped
}

export function stripShareArg(args: string[]) {
  const stripped: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--share") {
      continue
    }

    if (arg === "--cloudflared") {
      index += 1
      continue
    }

    if (arg !== "--share") {
      stripped.push(arg)
    }
  }

  return stripped
}

export function parseDevArgs(args: string[]): DevArgResolution {
  const { clientPort, serverPort } = resolveDevPorts(args)
  const serverArgs = stripShareArg(stripPortArg(args))
  let share: ShareMode = false
  let sawHost = false
  let sawRemote = false
  let backendTargetHost = "127.0.0.1"
  let lanBind = false
  const hosts = new Set<string>()

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--share") {
      assertNoHostOverride("--share", sawHost, sawRemote)
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      assertNoHostOverride("--cloudflared", sawHost, sawRemote)
      const next = args[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --cloudflared")
      share = { kind: "token", token: next }
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throw new Error(`${getShareCliFlag(share)} cannot be used with --remote`)
      }
      sawRemote = true
      backendTargetHost = "127.0.0.1"
      lanBind = true
      continue
    }
    // The server takes --allow-host too (serverArgs); Vite proxies to it under the same name.
    if (arg === "--allow-host") {
      const next = args[index + 1]
      if (next && !next.startsWith("-")) {
        hosts.add(next.trim().toLowerCase())
        index += 1
      }
      continue
    }
    if (arg !== "--host") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) continue
    if (isShareEnabled(share)) {
      throw new Error(`${getShareCliFlag(share)} cannot be used with --host`)
    }
    sawHost = true
    if (!isLoopbackHost(next)) {
      lanBind = true
      if (next !== "0.0.0.0") hosts.add(next.toLowerCase())
    }
    backendTargetHost = next === "0.0.0.0" ? "127.0.0.1" : next
    index += 1
  }

  return {
    clientPort,
    serverPort,
    share,
    backendTargetHost,
    lanBind,
    // A share tunnel's hostname is only known once cloudflared prints it.
    allowedHosts: isShareEnabled(share) ? true : [...hosts],
    serverArgs,
  }
}
