import { hostname } from "node:os"
import process from "node:process"
import { spawnSync } from "node:child_process"

function runAndRead(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

export function getMachineDisplayName() {
  if (process.platform === "darwin") {
    const computerName = runAndRead("scutil", ["--get", "ComputerName"])
    if (computerName) {
      return computerName
    }
  }

  const rawHostname = hostname().trim()
  return rawHostname.replace(/\.local$|\.lan$/i, "") || "This Machine"
}
