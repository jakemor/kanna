import { spawn, spawnSync } from "node:child_process"

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    let settled = false

    const cleanup = () => {
      child.off("spawn", handleSpawn)
      child.off("error", handleError)
    }

    const handleSpawn = () => {
      if (settled) return
      settled = true
      cleanup()
      child.unref()
      resolve()
    }

    const handleError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    child.once("spawn", handleSpawn)
    child.once("error", handleError)
  })
}

export function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
