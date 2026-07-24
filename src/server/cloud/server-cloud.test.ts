import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CLOUD_WS_ENDPOINT_PATH,
  DEFAULT_CLOUD_CONTROL_URL,
  PROXY_AUTH_HEADER,
  type CloudWsEndpointResponse,
} from "../../shared/cloud-api"
import { startKannaServer } from "../server"
import { createConnectTokenManager } from "./connect-token"
import type { CloudIdentity } from "./identity"
import type { CloudRuntime } from "./index"

const PROXY_SECRET = "proxy-secret-for-tests"

const IDENTITY: CloudIdentity = {
  controlUrl: DEFAULT_CLOUD_CONTROL_URL,
  machineToken: "machine-token",
  proxySecret: PROXY_SECRET,
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

const tempDirs: string[] = []
const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeCloudRuntime(): CloudRuntime {
  return {
    identity: IDENTITY,
    connectTokens: createConnectTokenManager(),
    start: () => {},
    stop: async () => {},
  }
}

async function startCloudServer(options: { port: number; cloud?: CloudRuntime | null; password?: string | null }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-cloud-server-"))
  tempDirs.push(dataDir)
  const server = await startKannaServer({
    dataDir,
    port: options.port,
    cloud: options.cloud,
    password: options.password ?? null,
    trustProxy: Boolean(options.cloud),
  })
  stops.push(server.stop)
  return server
}

describe("server cloud integration", () => {
  test("/__cloud/* 404s even without cloud (client feature detection)", async () => {
    const server = await startCloudServer({ port: 4361 })
    const response = await fetch(`http://127.0.0.1:${server.port}/__cloud/machines`)
    expect(response.status).toBe(404)
  })

  test("raw tunnel traffic sees only /health and /ws", async () => {
    
    const server = await startCloudServer({ port: 4362, cloud: fakeCloudRuntime() })
    const base = `http://127.0.0.1:${server.port}`
    const tunnelHeaders = { host: "tun-m1.kanna.sh" }

    // Public health check for the supervisor self-ping.
    const health = await fetch(`${base}/health`, { headers: tunnelHeaders })
    expect(health.status).toBe(200)

    // Everything else is a 404 — no app shell, no APIs.
    for (const pathname of ["/", "/index.html", "/api/projects/x/uploads", "/auth/status", CLOUD_WS_ENDPOINT_PATH]) {
      const response = await fetch(`${base}${pathname}`, { headers: tunnelHeaders })
      expect(response.status).toBe(404)
    }

    // WS without a token is rejected.
    const noToken = await fetch(`${base}/ws`, { headers: tunnelHeaders })
    expect(noToken.status).toBe(401)
  })

  test("ws-endpoint: proxied → tunnel URL + token; local → null", async () => {
    const cloud = fakeCloudRuntime()
    const server = await startCloudServer({ port: 4363, cloud })
    const base = `http://127.0.0.1:${server.port}`

    const local = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`)
    expect(local.status).toBe(200)
    expect(await local.json() as CloudWsEndpointResponse).toEqual({ wsUrl: null })

    const proxied = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`, {
      headers: { host: "tun-m1.kanna.sh", [PROXY_AUTH_HEADER]: PROXY_SECRET },
    })
    expect(proxied.status).toBe(200)
    const payload = await proxied.json() as CloudWsEndpointResponse
    expect(payload.wsUrl).toBe("wss://tun-m1.kanna.sh/ws")
    expect(typeof payload.connectToken).toBe("string")
    expect(cloud.connectTokens.validate(payload.connectToken as string)).toBe(true)
  })

  test("ws-endpoint on a direct-mode dev-box points at the sandbox host", async () => {
    const cloud = fakeCloudRuntime()
    cloud.identity = {
      ...IDENTITY,
      tunnelToken: "",
      tunnelHost: "3210-sbx123.e2b.app",
      mode: "direct",
    }
    const server = await startCloudServer({ port: 4368, cloud })
    const base = `http://127.0.0.1:${server.port}`

    const proxied = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`, {
      headers: { host: "3210-sbx123.e2b.app", [PROXY_AUTH_HEADER]: PROXY_SECRET },
    })
    expect(proxied.status).toBe(200)
    const payload = await proxied.json() as CloudWsEndpointResponse
    expect(payload.wsUrl).toBe("wss://3210-sbx123.e2b.app/ws")
    expect(cloud.connectTokens.validate(payload.connectToken as string)).toBe(true)
  })

  test("proxied requests bypass password auth; local ones don't", async () => {
    const server = await startCloudServer({
      port: 4364,
      cloud: fakeCloudRuntime(),
      password: "hunter2",
    })
    const base = `http://127.0.0.1:${server.port}`

    const localApi = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`)
    expect(localApi.status).toBe(401)

    const proxiedApi = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`, {
      headers: { host: "tun-m1.kanna.sh", [PROXY_AUTH_HEADER]: PROXY_SECRET },
    })
    expect(proxiedApi.status).toBe(200)
  })

  test("cloud WS upgrade with a minted token succeeds on the raw tunnel", async () => {
    const cloud = fakeCloudRuntime()
    const server = await startCloudServer({ port: 4365, cloud })
    const { token } = cloud.connectTokens.mint()

    // Bun's WebSocket accepts { headers } at runtime; the DOM lib types only
    // know the protocols overload, hence the cast. Simulates a raw tunnel
    // hit: public Host, page origin on kanna.sh.
    const tunnelHeaders = { headers: { host: "tun-m1.kanna.sh", origin: IDENTITY.appOrigin } }
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?token=${token}`,
      tunnelHeaders as unknown as string[],
    )
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true })
      socket.addEventListener("error", () => resolve(false), { once: true })
      socket.addEventListener("close", () => resolve(false), { once: true })
    })
    expect(opened).toBe(true)
    socket.close()

    // Bad token is rejected.
    const badSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?token=bogus`,
      { headers: { host: "tun-m1.kanna.sh", origin: IDENTITY.appOrigin } } as unknown as string[],
    )
    const badOpened = await new Promise<boolean>((resolve) => {
      badSocket.addEventListener("open", () => resolve(true), { once: true })
      badSocket.addEventListener("error", () => resolve(false), { once: true })
      badSocket.addEventListener("close", () => resolve(false), { once: true })
    })
    expect(badOpened).toBe(false)
  })

  test("without cloud, behavior is unchanged (no guard)", async () => {
    const server = await startCloudServer({ port: 4366 })
    const base = `http://127.0.0.1:${server.port}`

    // Even a tunnel-looking Host serves the app when cloud is off.
    const response = await fetch(`${base}/health`, { headers: { host: "tun-m1.kanna.sh" } })
    expect(response.status).toBe(200)

    const wsEndpoint = await fetch(`${base}${CLOUD_WS_ENDPOINT_PATH}`)
    expect(await wsEndpoint.json() as CloudWsEndpointResponse).toEqual({ wsUrl: null })
  })
})
