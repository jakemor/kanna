import process from "node:process"
import type { ClientCommand } from "../shared/protocol"
import { resolveLocalPath } from "./paths"
import { canOpenMacApp, hasCommand, spawnDetached } from "./process-utils"

type OpenExternalAction = Extract<ClientCommand, { type: "system.openExternal" }>["action"]

export function openExternal(localPath: string, action: OpenExternalAction) {
  const resolvedPath = resolveLocalPath(localPath)
  const platform = process.platform

  if (platform === "darwin") {
    if (action === "open_finder") {
      spawnDetached("open", [resolvedPath])
      return
    }
    if (action === "open_terminal") {
      spawnDetached("open", ["-a", "Terminal", resolvedPath])
      return
    }
    if (action === "open_editor") {
      if (hasCommand("cursor")) {
        spawnDetached("cursor", [resolvedPath])
        return
      }
      for (const appName of ["Cursor", "Visual Studio Code", "Windsurf"]) {
        if (!canOpenMacApp(appName)) continue
        spawnDetached("open", ["-a", appName, resolvedPath])
        return
      }
      spawnDetached("open", [resolvedPath])
      return
    }
  }

  if (platform === "win32") {
    if (action === "open_finder") {
      spawnDetached("explorer", [resolvedPath])
      return
    }
    if (action === "open_terminal") {
      if (hasCommand("wt")) {
        spawnDetached("wt", ["-d", resolvedPath])
        return
      }
      spawnDetached("cmd", ["/c", "start", "", "cmd", "/K", `cd /d ${resolvedPath}`])
      return
    }
    if (action === "open_editor") {
      if (hasCommand("cursor")) {
        spawnDetached("cursor", [resolvedPath])
        return
      }
      if (hasCommand("code")) {
        spawnDetached("code", [resolvedPath])
        return
      }
      spawnDetached("explorer", [resolvedPath])
      return
    }
  }

  if (action === "open_finder") {
    spawnDetached("xdg-open", [resolvedPath])
    return
  }
  if (action === "open_terminal") {
    for (const command of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
      if (!hasCommand(command)) continue
      if (command === "gnome-terminal") {
        spawnDetached(command, ["--working-directory", resolvedPath])
      } else if (command === "konsole") {
        spawnDetached(command, ["--workdir", resolvedPath])
      } else {
        spawnDetached(command, ["--working-directory", resolvedPath])
      }
      return
    }
    spawnDetached("xdg-open", [resolvedPath])
    return
  }
  if (hasCommand("cursor")) {
    spawnDetached("cursor", [resolvedPath])
    return
  }
  if (hasCommand("code")) {
    spawnDetached("code", [resolvedPath])
    return
  }
  spawnDetached("xdg-open", [resolvedPath])
}
