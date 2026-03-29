import type { ClientContext, CurrentUserDevice } from "../../shared/protocol"

type NavigatorLike = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
  userAgentData?: {
    platform?: string
    mobile?: boolean
    brands?: Array<{ brand?: string; version?: string }>
  }
}

function normalizedUserAgent(navigatorValue: NavigatorLike | undefined) {
  return `${navigatorValue?.userAgentData?.platform ?? ""} ${navigatorValue?.platform ?? ""} ${navigatorValue?.userAgent ?? ""}`
    .trim()
    .toLowerCase()
}

export function detectCurrentUserDevice(navigatorValue: NavigatorLike | undefined): CurrentUserDevice {
  const userAgent = normalizedUserAgent(navigatorValue)
  if (!userAgent) return "unknown"
  if (userAgent.includes("pixel")) return "pixel"
  if (userAgent.includes("android")) return "android"
  if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ios")) return "ios"
  if (userAgent.includes("macintosh") || userAgent.includes("mac os") || userAgent.includes("macos")) return "macbook"
  if (userAgent.includes("windows")) return "windows"
  if (userAgent.includes("linux")) return "linux"
  return "unknown"
}

export function detectClientContext(navigatorValue = globalThis.navigator): ClientContext {
  const currentUserDevice = detectCurrentUserDevice(navigatorValue)
  return {
    currentUserDevice,
    currentUserDeviceLabel: currentUserDevice,
  }
}
