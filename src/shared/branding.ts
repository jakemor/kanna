export const APP_NAME = "Kanna"
export const CLI_COMMAND = "kanna"
export const DATA_ROOT_NAME = ".kanna"
export const PACKAGE_NAME = "kanna-code"
// Read version from package.json — JSON import works in both Bun and Vite
import pkg from "../../package.json"
export const SDK_CLIENT_APP = `kanna/${pkg.version}`
export const LOG_PREFIX = "[kanna]"
export const DEFAULT_NEW_PROJECT_ROOT = `~/${APP_NAME}`

export function getDataRootName() {
  return DATA_ROOT_NAME
}

export function getDataRootDir(homeDir: string) {
  return `${homeDir}/${DATA_ROOT_NAME}`
}

export function getDataDir(homeDir: string) {
  return `${getDataRootDir(homeDir)}/data`
}

export function getDataDirDisplay() {
  return `~/${DATA_ROOT_NAME.slice(1)}/data`
}

export function getCliInvocation(arg?: string) {
  return arg ? `${CLI_COMMAND} ${arg}` : CLI_COMMAND
}
