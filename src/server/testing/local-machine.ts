import { homedir } from "node:os"
import { statSync } from "node:fs"
import process from "node:process"
import { resolveLocalPath } from "../paths"
import type { LocalMachineFacts } from "../read-models"

/** `LocalMachineFacts` for tests, minus the display name: this computer's platform, home and real folder mtimes. */
export const testLocalMachine: Omit<LocalMachineFacts, "displayName"> = {
  platform: process.platform,
  homeDirectory: homedir(),
  folderModifiedAt: (localPath) => {
    try {
      return statSync(resolveLocalPath(localPath, homedir())).mtimeMs
    } catch {
      return undefined
    }
  },
}
