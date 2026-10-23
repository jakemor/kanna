import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { CLOUD_CONTROL_URL_ENV_VAR, DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import { CloudApiError, createCloudApiClient, resolveControlUrl } from "./api-client"

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  return { fetchImpl, calls }
}

const PAIR_RESPONSE = {
  machineToken: "mt",
  proxySecret: "ps",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
}

describe("resolveControlUrl", () => {
  test("explicit > env > default, trailing slash stripped", () => {
    expect(resolveControlUrl(undefined, {})).toBe(DEFAULT_CLOUD_CONTROL_URL)
    expect(resolveControlUrl(undefined, { [CLOUD_CONTROL_URL_ENV_VAR]: "http://x/api/" })).toBe("http://x/api")
    expect(resolveControlUrl("http://y/api/", { [CLOUD_CONTROL_URL_ENV_VAR]: "http://x/api" })).toBe("http://y/api")
  })
})

describe("cloud api client", () => {
  test("pair posts the code and returns credentials", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(PAIR_RESPONSE))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const result = await runTest(client.pair("ABC123", "Jake's MBP"))
    expect(result).toEqual(PAIR_RESPONSE)
    expect(calls[0].url).toBe("http://cp/api/cloud/pair")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      pairingCode: "ABC123",
      machineName: "Jake's MBP",
    })
  })

  test("pair surfaces 404/410 with server message", async () => {
    const { fetchImpl } = fakeFetch(() =>
      Response.json({ error: "Pairing code expired" }, { status: 410 }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const result = await runTest(Effect.result(client.pair("STALE")))
    if (!Result.isFailure(result)) throw new Error("expected pair to fail")
    expect(result.failure).toBeInstanceOf(CloudApiError)
    expect(result.failure._tag).toBe("@kanna/server/cloud/api-client/CloudApiError")
    if (result.failure._tag !== "@kanna/server/cloud/api-client/CloudApiError") return
    expect(result.failure.status).toBe(410)
    expect(result.failure.message).toBe("Pairing code expired")
  })

  test("pair rejects incomplete responses (e.g. missing tunnel credentials)", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({
      machineToken: "mt",
      proxySecret: "ps",
      subdomain: "s",
      appOrigin: "https://s.kanna.sh",
      // tunnelToken / tunnelHost missing
    }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })
    await expect(runTest(client.pair("ABC"))).rejects.toThrow("incomplete pair response")
  })

  test("heartbeat sends the bearer token and local service", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await runTest(client.heartbeat("token", { localUrl: "http://localhost:3210" }))
    expect(calls[0].url).toBe("http://cp/api/cloud/heartbeat")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer token")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ localUrl: "http://localhost:3210" })
  })

  test("heartbeat surfaces 401 (revoked machine)", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const result = await runTest(Effect.result(client.heartbeat("gone", { localUrl: "http://localhost:3210" })))
    if (!Result.isFailure(result)) throw new Error("expected heartbeat to fail")
    expect(result.failure).toMatchObject({ _tag: "@kanna/server/cloud/api-client/CloudApiError", status: 401 })
  })

  test("markOffline posts with the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await runTest(client.markOffline("token"))
    expect(calls[0].url).toBe("http://cp/api/cloud/offline")
    expect(calls[0].init.method).toBe("POST")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer token")
  })

  test("removeMachine issues DELETE", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await runTest(client.removeMachine("token"))
    expect(calls[0].url).toBe("http://cp/api/cloud/machine")
    expect(calls[0].init.method).toBe("DELETE")
  })
})

describe("cloud api client failures", () => {
  test("an unreachable control plane fails with a network error naming the route", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Unable to connect")
    }) as unknown as typeof fetch
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const result = await runTest(Effect.result(client.heartbeat("token", { localUrl: "http://localhost:3210" })))
    if (!Result.isFailure(result)) throw new Error("expected heartbeat to fail")
    expect(result.failure).toMatchObject({
      _tag: "@kanna/server/cloud/api-client/CloudNetworkError",
      path: "/heartbeat",
      message: "Unable to connect",
    })
  })

  test("a non-JSON error body falls back to the status line", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const result = await runTest(Effect.result(client.markOffline("token")))
    if (!Result.isFailure(result)) throw new Error("expected markOffline to fail")
    expect(result.failure).toMatchObject({ status: 502, message: "control plane returned 502" })
  })

  test("device code: a missing poll interval reads as 0 (the session's fallback applies)", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({
      code: "ABC123",
      deviceToken: "device-token",
      claimUrl: "https://kanna.sh/machine?pair=ABC123",
      expiresAt: 1_700_000_000_000,
    }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    const issued = await runTest(client.requestDeviceCode("Jake's MBP"))
    expect(issued.pollIntervalMs).toBe(0)
    expect(issued.claimUrl).toBe("https://kanna.sh/machine?pair=ABC123")
  })

  test("device code poll: any status but claimed is pending; claimed needs credentials", async () => {
    let body: unknown = { status: "slow_down" }
    const { fetchImpl } = fakeFetch(() => Response.json(body))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    expect(await runTest(client.pollDeviceCode("device-token"))).toEqual({ status: "pending" })

    body = { status: "claimed", pairing: PAIR_RESPONSE }
    expect(await runTest(client.pollDeviceCode("device-token"))).toEqual({ status: "claimed", pairing: PAIR_RESPONSE })

    body = { status: "claimed", pairing: { machineToken: "" } }
    await expect(runTest(client.pollDeviceCode("device-token"))).rejects.toThrow("without credentials")
  })
})
