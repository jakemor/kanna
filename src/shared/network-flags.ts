import type { ShareMode } from "./share"
import { isShareEnabled } from "./share"

export interface NetworkFlags {
  share: ShareMode
  host: string
  sawHost: boolean
  sawRemote: boolean
}

export function parseNetworkFlags(argv: string[]): NetworkFlags {
  let share: ShareMode = false
  let host = "127.0.0.1"
  let sawHost = false
  let sawRemote = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--share") {
      if (sawHost) throw new Error("--share cannot be used with --host")
      if (sawRemote) throw new Error("--share cannot be used with --remote")
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      if (sawHost) throw new Error("--cloudflared cannot be used with --host")
      if (sawRemote) throw new Error("--cloudflared cannot be used with --remote")
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --cloudflared")
      share = { kind: "token", token: next }
      index += 1
      continue
    }
    if (arg === "--host") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) continue
      if (isShareEnabled(share)) {
        throw new Error(typeof share === "string" ? "--share cannot be used with --host" : "--cloudflared cannot be used with --host")
      }
      host = next
      sawHost = true
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throw new Error(typeof share === "string" ? "--share cannot be used with --remote" : "--cloudflared cannot be used with --remote")
      }
      host = "0.0.0.0"
      sawRemote = true
      continue
    }
  }

  return { share, host, sawHost, sawRemote }
}
