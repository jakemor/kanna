import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  CURSOR_DASHBOARD_SERVICE_BASE,
  fetchCursorAccountUsage,
  parseCursorAuthFile,
} from "./cursor-usage"
import type { CursorUsageRaw } from "./usage-limits"

function loadFixture(name: string): CursorUsageRaw {
  const text = readFileSync(path.join(import.meta.dir, "__fixtures__", name), "utf8")
  return JSON.parse(text) as CursorUsageRaw
}

describe("parseCursorAuthFile", () => {
  test("reads a bearer access token from cursor auth json", () => {
    expect(parseCursorAuthFile(JSON.stringify({ accessToken: "tok-abc" }))).toBe("tok-abc")
  })

  test("returns null for missing or invalid auth files", () => {
    expect(parseCursorAuthFile("{}")).toBeNull()
    expect(parseCursorAuthFile("not-json")).toBeNull()
  })
})

describe("fetchCursorAccountUsage", () => {
  test("calls the three DashboardService RPCs and assembles CursorUsageRaw", async () => {
    const fixture = loadFixture("cursor-usage-pro.json")
    const calls: string[] = []

    const usage = await fetchCursorAccountUsage({
      readAccessToken: async () => "session-token",
      dashboardRpc: async (method) => {
        calls.push(method)
        if (method === "GetCurrentPeriodUsage") return fixture.currentPeriodUsage
        if (method === "GetPlanInfo") return fixture.planInfo
        if (method === "GetHardLimit") return fixture.hardLimit
        throw new Error(`unexpected method ${method}`)
      },
    })

    expect(calls).toEqual(["GetCurrentPeriodUsage", "GetPlanInfo", "GetHardLimit"])
    expect(usage).toEqual(fixture)
  })

  test("returns null when there is no oauth session token", async () => {
    let rpcCalls = 0
    const usage = await fetchCursorAccountUsage({
      readAccessToken: async () => null,
      dashboardRpc: async () => {
        rpcCalls += 1
        return {}
      },
    })
    expect(usage).toBeNull()
    expect(rpcCalls).toBe(0)
  })

  test("treats a missing hard-limit read as optional", async () => {
    const fixture = loadFixture("cursor-usage-pro.json")
    const usage = await fetchCursorAccountUsage({
      readAccessToken: async () => "session-token",
      dashboardRpc: async (method) => {
        if (method === "GetCurrentPeriodUsage") return fixture.currentPeriodUsage
        if (method === "GetPlanInfo") return fixture.planInfo
        if (method === "GetHardLimit") throw new Error("forbidden")
        return null
      },
    })

    expect(usage?.hardLimit).toBeNull()
    expect(usage?.currentPeriodUsage).toEqual(fixture.currentPeriodUsage)
  })

  test("treats a failed plan-info read as optional, keeping the real usage percentages", async () => {
    const fixture = loadFixture("cursor-usage-pro.json")
    const usage = await fetchCursorAccountUsage({
      readAccessToken: async () => "session-token",
      dashboardRpc: async (method) => {
        if (method === "GetCurrentPeriodUsage") return fixture.currentPeriodUsage
        if (method === "GetPlanInfo") throw new Error("endpoint removed")
        if (method === "GetHardLimit") return fixture.hardLimit
        return null
      },
    })

    expect(usage?.planInfo).toBeNull()
    expect(usage?.currentPeriodUsage).toEqual(fixture.currentPeriodUsage)
  })

  test("exports the dashboard service base used by the probe", () => {
    expect(CURSOR_DASHBOARD_SERVICE_BASE).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService")
  })
})
