import type { ShareMode } from "./share"
import { isShareEnabled } from "./share"
import { parseNetworkFlags } from "./network-flags"

export const DEFAULT_DEV_CLIENT_PORT = 5174

export function getDefaultDevServerPort(clientPort = DEFAULT_DEV_CLIENT_PORT) {
  return clientPort + 1
}

export interface DevArgResolution {
  clientPort: number
  serverPort: number
  share: ShareMode
  backendTargetHost: string
  allowedHosts: true | string[]
  serverArgs: string[]
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

export function parseDevArgs(args: string[], localHostname: string): DevArgResolution {
  const { clientPort, serverPort } = resolveDevPorts(args)
  const serverArgs = stripShareArg(stripPortArg(args))
  const network = parseNetworkFlags(args)
  const hosts = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", localHostname])
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false

  // Resolve dev-specific host behavior (allowed hosts list, backend target)
  if (network.sawRemote) {
    allowAllHosts = true
  }
  if (network.sawHost) {
    hosts.add(network.host)
    backendTargetHost = network.host === "0.0.0.0" ? "127.0.0.1" : network.host
  }

  return {
    clientPort,
    serverPort,
    share: network.share,
    backendTargetHost,
    allowedHosts: isShareEnabled(network.share) || allowAllHosts ? true : [...hosts],
    serverArgs,
  }
}
