import { randomUUID } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getSettingsFilePath, LOG_PREFIX } from "../shared/branding"
import { CLOUDFLARE_TUNNEL_DEFAULTS, type AppSettingsSnapshot, type CloudflareTunnelSettings } from "../shared/types"

interface AppSettingsFile {
  analyticsEnabled?: unknown
  analyticsUserId?: unknown
  cloudflareTunnel?: unknown
}

interface AppSettingsState extends AppSettingsSnapshot {
  analyticsUserId: string
}

interface NormalizedAppSettings {
  payload: {
    analyticsEnabled: boolean
    analyticsUserId: string
    cloudflareTunnel: CloudflareTunnelSettings
  }
  warning: string | null
  shouldWrite: boolean
}

function formatDisplayPath(filePath: string) {
  const homePath = homedir()
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}

function createAnalyticsUserId() {
  return `anon_${randomUUID()}`
}

function normalizeAppSettings(
  value: unknown,
  filePath = getSettingsFilePath(homedir())
): NormalizedAppSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as AppSettingsFile
    : null
  const warnings: string[] = []

  if (value !== undefined && value !== null && !source) {
    warnings.push("Settings file must contain a JSON object")
  }

  const analyticsEnabled = typeof source?.analyticsEnabled === "boolean"
    ? source.analyticsEnabled
    : true
  if (source?.analyticsEnabled !== undefined && typeof source.analyticsEnabled !== "boolean") {
    warnings.push("analyticsEnabled must be a boolean")
  }

  const rawAnalyticsUserId = typeof source?.analyticsUserId === "string"
    ? source.analyticsUserId.trim()
    : ""
  if (source?.analyticsUserId !== undefined && typeof source.analyticsUserId !== "string") {
    warnings.push("analyticsUserId must be a string")
  }

  const analyticsUserId = rawAnalyticsUserId || createAnalyticsUserId()
  if (!rawAnalyticsUserId && source?.analyticsUserId !== undefined) {
    warnings.push("analyticsUserId must be a non-empty string")
  }

  const rawTunnel = source?.cloudflareTunnel
  const tunnelSource = rawTunnel && typeof rawTunnel === "object" && !Array.isArray(rawTunnel)
    ? rawTunnel as Record<string, unknown>
    : null

  if (rawTunnel !== undefined && !tunnelSource) {
    warnings.push("cloudflareTunnel must be an object")
  }

  const enabled = typeof tunnelSource?.enabled === "boolean"
    ? tunnelSource.enabled
    : CLOUDFLARE_TUNNEL_DEFAULTS.enabled
  if (tunnelSource?.enabled !== undefined && typeof tunnelSource.enabled !== "boolean") {
    warnings.push("cloudflareTunnel.enabled must be a boolean")
  }

  const cloudflaredPath = typeof tunnelSource?.cloudflaredPath === "string" && tunnelSource.cloudflaredPath.trim()
    ? tunnelSource.cloudflaredPath.trim()
    : CLOUDFLARE_TUNNEL_DEFAULTS.cloudflaredPath
  if (tunnelSource?.cloudflaredPath !== undefined && typeof tunnelSource.cloudflaredPath !== "string") {
    warnings.push("cloudflareTunnel.cloudflaredPath must be a string")
  }

  const rawMode = tunnelSource?.mode
  const mode: CloudflareTunnelSettings["mode"] =
    rawMode === "always-ask" || rawMode === "auto-expose"
      ? rawMode
      : CLOUDFLARE_TUNNEL_DEFAULTS.mode
  if (tunnelSource?.mode !== undefined && rawMode !== "always-ask" && rawMode !== "auto-expose") {
    warnings.push(`cloudflareTunnel.mode must be "always-ask" or "auto-expose"`)
  }

  const cloudflareTunnel: CloudflareTunnelSettings = { enabled, cloudflaredPath, mode }

  const shouldWrite = !source
    || source.analyticsEnabled !== analyticsEnabled
    || rawAnalyticsUserId !== analyticsUserId
    || JSON.stringify(rawTunnel) !== JSON.stringify(cloudflareTunnel)

  return {
    payload: {
      analyticsEnabled,
      analyticsUserId,
      cloudflareTunnel,
    },
    warning: warnings.length > 0
      ? `Some settings were reset to defaults: ${warnings.join("; ")}`
      : null,
    shouldWrite,
  }
}

function toSnapshot(state: AppSettingsState): AppSettingsSnapshot {
  return {
    analyticsEnabled: state.analyticsEnabled,
    warning: state.warning,
    filePathDisplay: state.filePathDisplay,
    cloudflareTunnel: state.cloudflareTunnel,
  }
}

export async function readAppSettingsSnapshot(filePath = getSettingsFilePath(homedir())) {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      const normalized = normalizeAppSettings(undefined, filePath)
      return {
        analyticsEnabled: normalized.payload.analyticsEnabled,
        cloudflareTunnel: normalized.payload.cloudflareTunnel,
        warning: "Settings file was empty. Using defaults.",
        filePathDisplay: formatDisplayPath(filePath),
      } satisfies AppSettingsSnapshot
    }

    const normalized = normalizeAppSettings(JSON.parse(text), filePath)
    return {
      analyticsEnabled: normalized.payload.analyticsEnabled,
      cloudflareTunnel: normalized.payload.cloudflareTunnel,
      warning: normalized.warning,
      filePathDisplay: formatDisplayPath(filePath),
    } satisfies AppSettingsSnapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        analyticsEnabled: true,
        cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
        warning: null,
        filePathDisplay: formatDisplayPath(filePath),
      } satisfies AppSettingsSnapshot
    }
    if (error instanceof SyntaxError) {
      return {
        analyticsEnabled: true,
        cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
        warning: "Settings file is invalid JSON. Using defaults.",
        filePathDisplay: formatDisplayPath(filePath),
      } satisfies AppSettingsSnapshot
    }
    throw error
  }
}

export class AppSettingsManager {
  readonly filePath: string
  private watcher: FSWatcher | null = null
  private state: AppSettingsState
  private readonly listeners = new Set<(snapshot: AppSettingsSnapshot) => void>()

  constructor(filePath = getSettingsFilePath(homedir())) {
    this.filePath = filePath
    const displayPath = formatDisplayPath(this.filePath)
    this.state = {
      analyticsEnabled: true,
      analyticsUserId: createAnalyticsUserId(),
      cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
      warning: null,
      filePathDisplay: displayPath,
    }
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await this.reload({ persistNormalized: true })
    this.startWatching()
  }

  dispose() {
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }

  getSnapshot() {
    return toSnapshot(this.state)
  }

  getState() {
    return this.state
  }

  onChange(listener: (snapshot: AppSettingsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async reload(options?: { persistNormalized?: boolean }) {
    const nextState = await this.readState(options)
    this.setState(nextState)
  }

  async write(value: { analyticsEnabled: boolean }) {
    const payload = {
      analyticsEnabled: value.analyticsEnabled,
      analyticsUserId: this.state.analyticsUserId || createAnalyticsUserId(),
      cloudflareTunnel: this.state.cloudflareTunnel,
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    const nextState: AppSettingsState = {
      analyticsEnabled: payload.analyticsEnabled,
      analyticsUserId: payload.analyticsUserId,
      cloudflareTunnel: this.state.cloudflareTunnel,
      warning: null,
      filePathDisplay: formatDisplayPath(this.filePath),
    }
    this.setState(nextState)
    return toSnapshot(nextState)
  }

  async setCloudflareTunnel(patch: Partial<CloudflareTunnelSettings>) {
    const next: CloudflareTunnelSettings = { ...this.state.cloudflareTunnel, ...patch }
    if (next.mode !== "always-ask" && next.mode !== "auto-expose") {
      throw new Error("Invalid cloudflareTunnel.mode")
    }
    const payload = {
      analyticsEnabled: this.state.analyticsEnabled,
      analyticsUserId: this.state.analyticsUserId || createAnalyticsUserId(),
      cloudflareTunnel: next,
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    const nextState: AppSettingsState = {
      analyticsEnabled: this.state.analyticsEnabled,
      analyticsUserId: payload.analyticsUserId,
      cloudflareTunnel: next,
      warning: null,
      filePathDisplay: formatDisplayPath(this.filePath),
    }
    this.setState(nextState)
    return toSnapshot(nextState)
  }

  private async readState(options?: { persistNormalized?: boolean }) {
    const file = Bun.file(this.filePath)
    const displayPath = formatDisplayPath(this.filePath)

    try {
      const text = await file.text()
      const hasText = text.trim().length > 0
      const normalized = normalizeAppSettings(hasText ? JSON.parse(text) : undefined, this.filePath)
      if (options?.persistNormalized && (!hasText || normalized.shouldWrite)) {
        await writeFile(this.filePath, `${JSON.stringify(normalized.payload, null, 2)}\n`, "utf8")
      }
      return {
        analyticsEnabled: normalized.payload.analyticsEnabled,
        analyticsUserId: normalized.payload.analyticsUserId,
        cloudflareTunnel: normalized.payload.cloudflareTunnel,
        warning: !hasText
          ? "Settings file was empty. Using defaults."
          : normalized.warning,
        filePathDisplay: displayPath,
      } satisfies AppSettingsState
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error
      }

      const warning = error instanceof SyntaxError
        ? "Settings file is invalid JSON. Using defaults."
        : null
      const normalized = normalizeAppSettings(undefined, this.filePath)
      if (options?.persistNormalized) {
        await writeFile(this.filePath, `${JSON.stringify(normalized.payload, null, 2)}\n`, "utf8")
      }
      return {
        analyticsEnabled: normalized.payload.analyticsEnabled,
        analyticsUserId: normalized.payload.analyticsUserId,
        cloudflareTunnel: normalized.payload.cloudflareTunnel,
        warning,
        filePathDisplay: displayPath,
      } satisfies AppSettingsState
    }
  }

  private setState(state: AppSettingsState) {
    this.state = state
    const snapshot = toSnapshot(state)
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private startWatching() {
    this.watcher?.close()
    try {
      this.watcher = watch(path.dirname(this.filePath), { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== path.basename(this.filePath)) {
          return
        }
        void this.reload().catch((error: unknown) => {
          console.warn(`${LOG_PREFIX} Failed to reload settings:`, error)
        })
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to watch settings file:`, error)
      this.watcher = null
    }
  }
}
