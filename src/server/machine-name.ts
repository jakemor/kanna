import { readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { getCloudFilePath } from "../shared/branding"
import { machineHostNames } from "./request-guard"

function runAndRead(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

export function getMachineNameOverridePath() {
  return path.join(homedir(), ".kanna", "machine-name")
}

/**
 * ~/.kanna/machine-name — explicit display-name override (first non-empty
 * line). Written by environments whose hostname is meaningless, e.g. deploy
 * previews name themselves after the ref they serve; users can set it too.
 */
export function readMachineNameOverride(overridePath = getMachineNameOverridePath()): string | null {
  try {
    const firstLine = readFileSync(overridePath, "utf8").split("\n")[0]?.trim() ?? ""
    return firstLine ? firstLine.slice(0, 80) : null
  } catch {
    return null
  }
}

/**
 * Dev-boxes (direct-mode cloud identities) are named by the subdomain the
 * user picked at creation — the sandbox's own hostname is a random id.
 */
export function readDevboxSubdomain(identityPath = getCloudFilePath(homedir())): string | null {
  try {
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as {
      mode?: unknown
      subdomain?: unknown
    }
    if (parsed?.mode !== "direct") return null
    const subdomain = typeof parsed.subdomain === "string" ? parsed.subdomain.trim() : ""
    return subdomain || null
  } catch {
    return null
  }
}

export function getMachineDisplayName(identityPath?: string, overridePath?: string) {
  const override = readMachineNameOverride(overridePath)
  if (override) {
    return override
  }

  const devboxSubdomain = readDevboxSubdomain(identityPath)
  if (devboxSubdomain) {
    return devboxSubdomain
  }

  if (process.platform === "darwin") {
    const computerName = runAndRead("scutil", ["--get", "ComputerName"])
    if (computerName) {
      return computerName
    }
  }

  const rawHostname = hostname().trim()
  return rawHostname.replace(/\.local$|\.lan$/i, "") || "This Machine"
}

/**
 * The names this machine is reached by on its network, for the server's Host
 * check (request-guard.ts). The Bonjour name is asked for on its own because
 * a DHCP server can hand out a different hostname.
 */
export function getMachineHostNames() {
  const bonjourName = process.platform === "darwin" ? runAndRead("scutil", ["--get", "LocalHostName"]) : null
  return machineHostNames(hostname(), bonjourName)
}
