import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type {
  CursorCurrentPeriodUsageRaw,
  CursorHardLimitRaw,
  CursorPlanInfoRaw,
  CursorUsageRaw,
} from "./usage-limits"

export const CURSOR_DASHBOARD_SERVICE_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService"

type DashboardMethod = "GetCurrentPeriodUsage" | "GetPlanInfo" | "GetHardLimit"

export type CursorDashboardRpc = (method: DashboardMethod, accessToken: string) => Promise<unknown>

interface CursorAuthFile {
  accessToken?: string | null
}

/** Parse `~/.config/cursor/auth.json` for an OAuth session token. */
export function parseCursorAuthFile(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as CursorAuthFile
    return typeof parsed.accessToken === "string" && parsed.accessToken.trim()
      ? parsed.accessToken.trim()
      : null
  } catch {
    return null
  }
}

export async function readCursorAccessToken(
  readFileFn: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, "utf8"),
): Promise<string | null> {
  const authPath = path.join(homedir(), ".config", "cursor", "auth.json")
  try {
    return parseCursorAuthFile(await readFileFn(authPath))
  } catch {
    return null
  }
}

/** api2.cursor.sh is unofficial and unmonitored; a stall shouldn't hang every later usage refresh. */
const CURSOR_DASHBOARD_TIMEOUT_MS = 10_000

export async function defaultCursorDashboardRpc(
  method: DashboardMethod,
  accessToken: string,
): Promise<unknown> {
  const response = await fetch(`${CURSOR_DASHBOARD_SERVICE_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
    signal: AbortSignal.timeout(CURSOR_DASHBOARD_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Cursor ${method} failed with HTTP ${response.status}`)
  }
  return await response.json()
}

export interface FetchCursorAccountUsageDeps {
  readAccessToken?: () => Promise<string | null>
  dashboardRpc?: CursorDashboardRpc
}

/** Read Cursor subscription usage via DashboardService (same RPCs the CLI uses). */
export async function fetchCursorAccountUsage(
  deps: FetchCursorAccountUsageDeps = {},
): Promise<CursorUsageRaw | null> {
  const readAccessToken = deps.readAccessToken ?? readCursorAccessToken
  const dashboardRpc = deps.dashboardRpc ?? defaultCursorDashboardRpc
  const accessToken = await readAccessToken()
  if (!accessToken) return null

  // GetCurrentPeriodUsage carries the actual usage percentages this call
  // exists for; GetPlanInfo and GetHardLimit only supply auxiliary labeling
  // and an on-demand fallback limit, so their failure shouldn't take down
  // otherwise-valid usage data.
  const [currentPeriodUsage, planInfo, hardLimit] = await Promise.all([
    dashboardRpc("GetCurrentPeriodUsage", accessToken),
    dashboardRpc("GetPlanInfo", accessToken).catch(() => null),
    dashboardRpc("GetHardLimit", accessToken).catch(() => null),
  ])

  return {
    currentPeriodUsage: currentPeriodUsage as CursorCurrentPeriodUsageRaw,
    planInfo: (planInfo as CursorPlanInfoRaw | null) ?? null,
    hardLimit: (hardLimit as CursorHardLimitRaw | null) ?? null,
  }
}
