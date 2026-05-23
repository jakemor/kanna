import { spawn } from "node:child_process"
import type { CodexAppServerProcess, SpawnCodexAppServer } from "./codex-app-server"

export const defaultSpawnCodexAppServer: SpawnCodexAppServer = (cwd) =>
  spawn("codex", ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as unknown as CodexAppServerProcess
