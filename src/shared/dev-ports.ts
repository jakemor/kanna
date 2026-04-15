import type { ShareMode } from "./share"
import { isShareEnabled } from "./share"

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
  let share: ShareMode = false
  let sawHost = false
  let sawRemote = false
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false
  const hosts = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", localHostname])

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--share") {
      if (sawHost) throw new Error("--share cannot be used with --host")
      if (sawRemote) throw new Error("--share cannot be used with --remote")
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      if (sawHost) throw new Error("--cloudflared cannot be used with --host")
      if (sawRemote) throw new Error("--cloudflared cannot be used with --remote")
      const next = args[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --cloudflared")
      share = { kind: "token", token: next }
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throw new Error(typeof share === "string" ? "--share cannot be used with --remote" : "--cloudflared cannot be used with --remote")
      }
      sawRemote = true
      backendTargetHost = "127.0.0.1"
      allowAllHosts = true
      continue
    }
    if (arg !== "--host") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) continue
    if (isShareEnabled(share)) {
      throw new Error(typeof share === "string" ? "--share cannot be used with --host" : "--cloudflared cannot be used with --host")
    }
    sawHost = true
    hosts.add(next)
    backendTargetHost = next === "0.0.0.0" ? "127.0.0.1" : next
    index += 1
  }

  return {
    clientPort,
    serverPort,
    share,
    backendTargetHost,
    allowedHosts: isShareEnabled(share) || allowAllHosts ? true : [...hosts],
    serverArgs,
  }
}
