/**
 * Cross-repo wire e2e: the full kanna ↔ kanna-site pairing contract over
 * real HTTP (v2 — named tunnels), with zero production-code test seams.
 *
 *   kanna-site worker (built, under Miniflare via its test harness bridge)
 *     ⇅ real /api/cloud/{pair,heartbeat,offline,machine} + subdomain proxying
 *     → fake Cloudflare API (records tunnel/DNS lifecycle)
 *   real kanna server (startKannaServer + CloudRuntime)
 *     with a DI'd connector (named tunnels connect, they don't mint URLs)
 *
 * Flow: seeded account session → add machine (provisions tunnel + DNS via
 * the fake CF API) → machine pairs with the real api-client (gets connector
 * token + permanent tunnel host) → supervisor connects + heartbeats →
 * browser fetches the app THROUGH the proxy → ws-endpoint (static tunnel WS
 * URL) → direct WebSocket → sidebar snapshot → lockdown → unpair (CF
 * cleanup).
 *
 * Run with `bun run test:cloud`. Requires ../kanna-site with node_modules
 * and a `bun run build` (dist/kanna_site + dist/client) plus kanna's own
 * dist/client.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Subprocess } from "bun"
import { PROXY_AUTH_HEADER, type CloudWsEndpointResponse } from "../../shared/cloud-api"
import { startKannaServer } from "../server"
import { createCloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { createCloudRuntime, type CloudRuntime } from "./index"

const KANNA_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SITE_ROOT = path.resolve(KANNA_ROOT, "..", "kanna-site")
const SESSION_TOKEN = "wire-e2e-session-token"
const GITHUB_LOGIN = "wiretest"
const SUBDOMAIN = `${GITHUB_LOGIN}-mbp`
const KANNA_PORT = 4372

const missing = [
  !existsSync(path.join(SITE_ROOT, "package.json")) && "../kanna-site checkout",
  !existsSync(path.join(SITE_ROOT, "node_modules", "miniflare")) && "../kanna-site node_modules (run `bun install`)",
  !existsSync(path.join(SITE_ROOT, "dist", "kanna_site", "index.js")) && "../kanna-site build (run `bun run build`)",
  !existsSync(path.join(KANNA_ROOT, "dist", "client", "index.html")) && "kanna client build (run `bun run build`)",
].filter((value): value is string => Boolean(value))

let harness: Subprocess<"ignore", "pipe", "inherit"> | null = null
let controlBase = ""
let kannaStop: (() => Promise<void>) | null = null
let kannaLocalUrl = ""
let cloudRuntime: CloudRuntime | null = null
let identity: CloudIdentity | null = null
let dataDir = ""

// Fake Cloudflare API: records the tunnel/DNS lifecycle calls.
let fakeCf: ReturnType<typeof Bun.serve> | null = null
const cfCalls: Array<{ method: string; path: string }> = []

// The DI'd connector records what it was started with.
const connectorStarts: Array<{ localUrl: string; token: string }> = []

function startFakeCf() {
  fakeCf = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      cfCalls.push({ method: req.method, path: url.pathname + url.search })
      if (url.pathname.endsWith("/cfd_tunnel") && req.method === "POST") {
        return Response.json({ success: true, result: { id: "wire-tunnel-uuid", token: "wire-connector-token" } })
      }
      if (url.pathname.includes("/dns_records") && req.method === "POST") {
        return Response.json({ success: true, result: { id: "wire-dns-id" } })
      }
      return Response.json({ success: true, result: {} })
    },
  })
}

async function startHarness() {
  harness = Bun.spawn(
    [
      "node",
      path.join(SITE_ROOT, "test", "harness", "serve.mjs"),
      "--session-token", SESSION_TOKEN,
      "--github-login", GITHUB_LOGIN,
      "--cf-api-base", `http://127.0.0.1:${fakeCf!.port}`,
      // The proxy forwards to this instead of https://tun-<id>.kanna.sh —
      // pointed straight at the kanna server, exactly where the real tunnel
      // would deliver the bytes.
      "--tunnel-origin-override", `http://127.0.0.1:${KANNA_PORT}`,
    ],
    { cwd: SITE_ROOT, stdout: "pipe", stderr: "inherit" },
  )

  const reader = harness.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    const match = buffer.match(/KANNA_SITE_HARNESS_READY port=(\d+)/)
    if (match) {
      reader.releaseLock()
      return Number(match[1])
    }
  }
  throw new Error(`kanna-site harness did not become ready. output: ${buffer}`)
}

/** Browser-side request through the kanna.sh proxy (simulated host header). */
function proxyFetch(pathname: string, init: RequestInit & { host?: string; session?: boolean } = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-kanna-test-host", init.host ?? `${SUBDOMAIN}.kanna.sh`)
  if (init.session !== false) {
    headers.set("cookie", `kanna_cloud_session=${SESSION_TOKEN}`)
  }
  return fetch(`${controlBase}${pathname}`, { ...init, headers, redirect: "manual" })
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(50)
  }
  throw new Error("waitFor timed out")
}

describe.if(missing.length === 0)("kanna ↔ kanna-site wire e2e (named tunnels)", () => {
  beforeAll(async () => {
    startFakeCf()
    const harnessPort = await startHarness()
    controlBase = `http://127.0.0.1:${harnessPort}`

    dataDir = await mkdtemp(path.join(tmpdir(), "kanna-wire-e2e-"))
  }, 90_000)

  afterAll(async () => {
    await cloudRuntime?.stop()
    await kannaStop?.()
    harness?.kill()
    fakeCf?.stop(true)
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  let pairingCode = ""
  let machineId = ""

  test("dashboard: add machine → tunnel + DNS provisioned, pairing code issued", async () => {
    const response = await proxyFetch("/api/cloud/machines", {
      method: "POST",
      host: "kanna.sh",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: SUBDOMAIN }),
    })
    expect(response.status).toBe(201)
    const payload = await response.json() as {
      machine: { id: string }
      pairing: { pairingCode: string }
    }
    pairingCode = payload.pairing.pairingCode
    machineId = payload.machine.id

    const paths = cfCalls.map((call) => `${call.method} ${call.path}`)
    expect(paths.some((p) => p.includes("POST") && p.includes("/cfd_tunnel"))).toBe(true)
    expect(paths.some((p) => p.includes("/configurations"))).toBe(true)
    expect(paths.some((p) => p.includes("/dns_records"))).toBe(true)
    cfCalls.length = 0
  })

  test("machine: pair with the real api-client → connector credentials", async () => {
    const client = createCloudApiClient({ controlUrl: `${controlBase}/api/cloud` })
    const response = await client.pair(pairingCode, "Wire E2E Machine")
    expect(response.subdomain).toBe(SUBDOMAIN)
    expect(response.appOrigin).toBe(`https://${SUBDOMAIN}.kanna.sh`)
    expect(response.tunnelToken).toBe("wire-connector-token")
    expect(response.tunnelHost).toBe(`tun-${machineId}.kanna.sh`)

    identity = {
      controlUrl: `${controlBase}/api/cloud`,
      machineToken: response.machineToken,
      proxySecret: response.proxySecret,
      subdomain: response.subdomain,
      appOrigin: response.appOrigin,
      tunnelToken: response.tunnelToken,
      tunnelHost: response.tunnelHost,
      enabled: true,
    }
  })

  test("machine: server + connector come online via heartbeat", async () => {
    if (!identity) throw new Error("pairing did not run")

    // DI'd connector: named tunnels just connect (no URL); real traffic is
    // delivered by the proxy's TUNNEL_ORIGIN_OVERRIDE → this server.
    cloudRuntime = createCloudRuntime(identity, {
      apiClient: createCloudApiClient({ controlUrl: identity.controlUrl }),
      supervisorDeps: {
        startTunnelImpl: async (localUrl, token) => {
          connectorStarts.push({ localUrl, token })
          return { publicUrl: null, stop: () => {} }
        },
      },
    })

    const server = await startKannaServer({
      dataDir,
      port: KANNA_PORT,
      strictPort: true,
      cloud: cloudRuntime,
      trustProxy: true,
    })
    kannaStop = server.stop
    kannaLocalUrl = `http://127.0.0.1:${server.port}`
    cloudRuntime.start({ localUrl: kannaLocalUrl })

    // The supervisor heartbeats the moment the connector is up — no
    // propagation wait, no URL registration.
    await waitFor(async () => {
      const response = await proxyFetch("/__cloud/machines")
      if (response.status !== 200) return false
      const payload = await response.json() as { machines: Array<{ online: boolean }> }
      return payload.machines[0]?.online === true
    })

    expect(connectorStarts).toEqual([
      { localUrl: kannaLocalUrl, token: "wire-connector-token" },
    ])
  }, 30_000)

  test("browser: the app is served through the proxy", async () => {
    const response = await proxyFetch("/")
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("<!doctype html>")
    expect(body.toLowerCase()).toContain("kanna")
  })

  test("browser without a session: login redirect at the proxy", async () => {
    const response = await proxyFetch("/", { session: false })
    expect(response.status).toBe(302)
    expect(response.headers.get("location") ?? "").toContain("kanna.sh/login")
  })

  test("browser: ws-endpoint → static tunnel WS URL → direct WebSocket → sidebar snapshot", async () => {
    if (!identity) throw new Error("pairing did not run")
    const endpointResponse = await proxyFetch("/api/cloud/ws-endpoint")
    expect(endpointResponse.status).toBe(200)
    const endpoint = await endpointResponse.json() as CloudWsEndpointResponse
    expect(endpoint.wsUrl).toBe(`wss://tun-${machineId}.kanna.sh/ws`)
    expect(typeof endpoint.connectToken).toBe("string")

    // In production the browser dials that hostname and Cloudflare delivers
    // it to this server; here we dial the server directly while simulating
    // the tunnel Host + page Origin — same guard path.
    const socket = new WebSocket(
      `ws://127.0.0.1:${KANNA_PORT}/ws?token=${endpoint.connectToken}`,
      { headers: { host: identity.tunnelHost, origin: identity.appOrigin } } as unknown as string[],
    )
    const snapshot = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no snapshot within 10s")), 10_000)
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "wire-e2e", topic: { type: "sidebar" } }))
      })
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as { type?: string; id?: string }
        if (payload.type === "snapshot" && payload.id === "wire-e2e") {
          clearTimeout(timer)
          resolve(payload)
        }
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("websocket error"))
      })
    })
    socket.close()
    expect(snapshot).toBeTruthy()
  }, 20_000)

  test("proxy injects the auth header; raw tunnel traffic is locked down", async () => {
    if (!identity) throw new Error("pairing did not run")
    // Through the proxy: full app.
    const proxied = await proxyFetch("/health")
    expect(proxied.status).toBe(200)

    // Raw tunnel-host hit (no proxy header): only /health + token-gated /ws.
    const rawHealth = await fetch(`${kannaLocalUrl}/health`, {
      headers: { host: identity.tunnelHost },
    })
    expect(rawHealth.status).toBe(200)
    const rawApp = await fetch(`${kannaLocalUrl}/`, {
      headers: { host: identity.tunnelHost },
    })
    expect(rawApp.status).toBe(404)

    // A spoofed proxy header with the wrong secret stays untrusted.
    const spoofed = await fetch(`${kannaLocalUrl}/`, {
      headers: { host: identity.tunnelHost, [PROXY_AUTH_HEADER]: "wrong-secret" },
    })
    expect(spoofed.status).toBe(404)
  })

  test("graceful stop flips the machine offline via the offline signal", async () => {
    if (!cloudRuntime) throw new Error("runtime missing")
    await cloudRuntime.stop()

    const response = await proxyFetch("/__cloud/machines")
    const payload = await response.json() as { machines: Array<{ online: boolean }> }
    expect(payload.machines[0].online).toBe(false)
  })

  test("machine: unpair via the contract → CF cleanup, proxy forgets it", async () => {
    if (!identity) throw new Error("pairing did not run")
    cfCalls.length = 0
    const client = createCloudApiClient({ controlUrl: identity.controlUrl })
    await client.removeMachine(identity.machineToken)

    const paths = cfCalls.map((call) => `${call.method} ${call.path}`)
    expect(paths.some((p) => p.startsWith("DELETE") && p.includes("/dns_records/wire-dns-id"))).toBe(true)
    expect(paths.some((p) => p.startsWith("DELETE") && p.includes("/cfd_tunnel/wire-tunnel-uuid"))).toBe(true)

    const response = await proxyFetch("/")
    expect(response.status).toBe(404)
  })
})

if (missing.length > 0) {
  test("wire e2e (skipped)", () => {
    console.warn(`Skipping kanna ↔ kanna-site wire e2e — missing: ${missing.join(", ")}`)
    expect(true).toBe(true)
  })
}
