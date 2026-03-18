import { spawn, spawnSync } from "node:child_process"

export function spawnDetached(command: string, args: string[]) {
  spawn(command, args, { stdio: "ignore", detached: true }).unref()
}

export function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
