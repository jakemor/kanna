export const APP_NAME = "Kanna"
export const CLI_COMMAND = "kanna"
export const DATA_ROOT_NAME = ".kanna"
export const DEV_DATA_ROOT_NAME = ".kanna-dev"
export const RC_DATA_ROOT_NAME = ".kanna-rc"
export const PACKAGE_NAME = "kanna-code"
export const RUNTIME_PROFILE_ENV_VAR = "KANNA_RUNTIME_PROFILE"
// Read version from package.json — JSON import works in both Bun and Vite
import pkg from "../../package.json"
export const APP_VERSION = pkg.version
export const SDK_CLIENT_APP = `kanna/${pkg.version}`
export const LOG_PREFIX = "[kanna]"
export const DEFAULT_NEW_PROJECT_ROOT = `~/${APP_NAME}`

export type RuntimeProfile = "dev" | "rc" | "prod"

type RuntimeEnv = Record<string, string | undefined> | undefined

function getRuntimeEnv(): RuntimeEnv {
  const candidate = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>
    }
  }
  return candidate.process?.env
}

export function getRuntimeProfile(env: RuntimeEnv = getRuntimeEnv()): RuntimeProfile {
  const profile = env?.[RUNTIME_PROFILE_ENV_VAR]?.trim().toLowerCase()
  if (profile === "dev" || profile === "rc") return profile
  return "prod"
}

export function getDataRootName(env: RuntimeEnv = getRuntimeEnv()) {
  const profile = getRuntimeProfile(env)
  if (profile === "dev") return DEV_DATA_ROOT_NAME
  if (profile === "rc") return RC_DATA_ROOT_NAME
  return DATA_ROOT_NAME
}

export function getCliCommand(env: RuntimeEnv = getRuntimeEnv()) {
  return getRuntimeProfile(env) === "rc" ? "kanna-rc" : CLI_COMMAND
}

export function getDataRootDir(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${homeDir}/${getDataRootName(env)}`
}

export function getDataRootDirDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `~/${getDataRootName(env)}`
}

export function getDataDir(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/data`
}

export function getDataDirDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/data`
}

export function getSettingsFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataDir(homeDir, env)}/settings.json`
}

export function getKeybindingsFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/keybindings.json`
}

export function getKeybindingsFilePathDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/keybindings.json`
}

export function getLlmProviderFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/llm-provider.json`
}

export function getCloudFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/cloud.json`
}

export function getCloudFilePathDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/cloud.json`
}

export function getCliInvocation(arg?: string) {
  const command = getCliCommand()
  return arg ? `${command} ${arg}` : command
}
