import { describe, expect, test } from "bun:test"
import { CLOUD_CONTROL_URL_ENV_VAR, DEFAULT_CLOUD_CONTROL_URL } from "../../shared/cloud-api"
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

    const result = await client.pair("ABC123", "Jake's MBP")
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

    try {
      await client.pair("STALE")
      throw new Error("expected pair to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(CloudApiError)
      expect((error as CloudApiError).status).toBe(410)
      expect((error as CloudApiError).message).toBe("Pairing code expired")
    }
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
    await expect(client.pair("ABC")).rejects.toThrow("incomplete pair response")
  })

  test("heartbeat sends the bearer token and local service", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await client.heartbeat("token", { localUrl: "http://localhost:3210" })
    expect(calls[0].url).toBe("http://cp/api/cloud/heartbeat")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer token")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ localUrl: "http://localhost:3210" })
  })

  test("heartbeat surfaces 401 (revoked machine)", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    try {
      await client.heartbeat("gone", { localUrl: "http://localhost:3210" })
      throw new Error("expected heartbeat to throw")
    } catch (error) {
      expect((error as CloudApiError).status).toBe(401)
    }
  })

  test("markOffline posts with the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await client.markOffline("token")
    expect(calls[0].url).toBe("http://cp/api/cloud/offline")
    expect(calls[0].init.method).toBe("POST")
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer token")
  })

  test("removeMachine issues DELETE", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ ok: true }))
    const client = createCloudApiClient({ fetchImpl, controlUrl: "http://cp/api/cloud" })

    await client.removeMachine("token")
    expect(calls[0].url).toBe("http://cp/api/cloud/machine")
    expect(calls[0].init.method).toBe("DELETE")
  })
})
