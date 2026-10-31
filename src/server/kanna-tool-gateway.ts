import type { KannaToolHost, KannaToolResult } from "./kanna-tools"

/**
 * Where `kanna <tool>` (kanna-tool-cli.ts) reaches a chat's Kanna tools from
 * the agent's shell. Each chat gets a random credential, made the first time
 * one of its turns starts and kept in memory only, for the life of this
 * server. The harness hands it to its shell in the environment
 * (`kannaToolEnv`), so a command in that shell acts as that chat and nothing
 * else: the call runs through the same `KannaToolHost` the chat's MCP tools
 * do, with the same checks, and lands in its transcript the same way.
 *
 * The listener is its own, on loopback, so a Cloudflare tunnel or a LAN bind
 * of the app never exposes it. A request with an Origin header is refused,
 * so a page in a browser cannot call it either.
 */

/** The variables a chat's shell gets. Not `..._TOKEN`: Codex strips every variable whose name holds KEY, SECRET or TOKEN from the commands it runs. */
export const KANNA_TOOLS_URL_ENV = "KANNA_TOOLS_URL"
export const KANNA_TOOLS_AUTH_ENV = "KANNA_TOOLS_AUTH"
export const KANNA_CHAT_ID_ENV = "KANNA_CHAT_ID"

/** How often a call that is still running writes a blank line, so nothing between the CLI and here gives up on a quiet connection. */
const HEARTBEAT_MS = 10_000

export interface KannaToolGateway {
  /**
   * Points the chat's credential at `host`, the tool host of its current turn,
   * and returns the environment its harness passes to the agent's shell.
   */
  register: (chatId: string, host: KannaToolHost) => Record<string, string>
  /** Forgets the chat's credential: every later call with it is refused. */
  revoke: (chatId: string) => void
  close: () => void
}

export function createKannaToolGateway(options: {
  /** False for a chat that was deleted: its credential is revoked and the call refused. */
  isLive: (chatId: string) => boolean
}): KannaToolGateway {
  const chats = new Map<string, { auth: string; host: KannaToolHost }>()
  const byAuth = new Map<string, string>()
  const abortController = new AbortController()
  let server: ReturnType<typeof Bun.serve> | null = null

  const revoke = (chatId: string) => {
    const entry = chats.get(chatId)
    if (!entry) return
    chats.delete(chatId)
    byAuth.delete(entry.auth)
  }

  const refuse = (status: number, message: string) => Response.json({ error: message }, { status })

  async function handle(request: Request): Promise<Response> {
    if (request.headers.has("origin")) return refuse(403, "Forbidden")
    const match = /^\/tools\/([a-z_]+)$/.exec(new URL(request.url).pathname)
    if (request.method !== "POST" || !match) return refuse(404, "Not found")
    const header = request.headers.get("authorization") ?? ""
    const chatId = header.startsWith("Bearer ") ? byAuth.get(header.slice(7)) : undefined
    if (!chatId) return refuse(401, `Not authorized. ${KANNA_TOOLS_AUTH_ENV} is missing, wrong, or from a server that has since restarted.`)
    const claimed = request.headers.get("x-kanna-chat-id")
    if (claimed && claimed !== chatId) return refuse(401, `Not authorized: ${KANNA_TOOLS_AUTH_ENV} belongs to another chat than ${KANNA_CHAT_ID_ENV}.`)
    if (!options.isLive(chatId)) {
      revoke(chatId)
      return refuse(410, "This chat no longer exists.")
    }
    let input: unknown
    try {
      input = await request.json()
    } catch {
      return refuse(400, "The request body is not JSON.")
    }
    const host = chats.get(chatId)!.host
    const signal = AbortSignal.any([request.signal, abortController.signal])
    const encoder = new TextEncoder()
    // Streamed: request_secrets waits on the user for as long as they take.
    return new Response(new ReadableStream({
      async start(controller) {
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode("\n")), HEARTBEAT_MS)
        let result: KannaToolResult
        try {
          result = await host.execute(match[1]!, input, signal)
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }
        } finally {
          clearInterval(heartbeat)
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(result)}\n`))
          controller.close()
        } catch {
          // The CLI went away; the signal has already cancelled the call.
        }
      },
    }), { headers: { "content-type": "application/x-ndjson" } })
  }

  return {
    register(chatId, host) {
      server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle })
      let entry = chats.get(chatId)
      if (!entry) {
        entry = { auth: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), host }
        chats.set(chatId, entry)
        byAuth.set(entry.auth, chatId)
      }
      entry.host = host
      return {
        [KANNA_TOOLS_URL_ENV]: `http://127.0.0.1:${server.port}`,
        [KANNA_TOOLS_AUTH_ENV]: entry.auth,
        [KANNA_CHAT_ID_ENV]: chatId,
      }
    },
    revoke,
    close() {
      abortController.abort()
      server?.stop(true)
      server = null
      chats.clear()
      byAuth.clear()
    },
  }
}
