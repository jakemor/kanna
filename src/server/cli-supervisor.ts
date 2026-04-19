import process from "node:process"
import { spawn } from "node:child_process"
import { CLI_COMMAND, LOG_PREFIX } from "../shared/branding"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_CHILD_COMMAND_ENV_VAR,
  CLI_CHILD_MODE,
  CLI_CHILD_MODE_ENV_VAR,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_SUPPRESS_OPEN_ONCE_ENV_VAR,
  isUiUpdateRestart,
  parseChildArgsEnv,
  shouldRestartCliProcess,
} from "./restart"

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

function getChildProcessSpec() {
  const command = process.env[CLI_CHILD_COMMAND_ENV_VAR] || CLI_COMMAND
  const args = parseChildArgsEnv(process.env[CLI_CHILD_ARGS_ENV_VAR])
  return { command, args }
}

function spawnChild(argv: string[]) {
  const childProcess = getChildProcessSpec()
  const suppressOpenThisChild = suppressOpenOnNextChild
  const skipUpdateThisChild = skipUpdateOnNextChild
  suppressOpenOnNextChild = false
  skipUpdateOnNextChild = false
  return new Promise<ChildExit>((resolve, reject) => {
    const child = spawn(childProcess.command, [...childProcess.args, ...argv], {
      stdio: "inherit",
      env: {
        ...process.env,
        [CLI_CHILD_MODE_ENV_VAR]: CLI_CHILD_MODE,
        ...(suppressOpenThisChild ? { [CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]: "1" } : {}),
        ...(skipUpdateThisChild ? { KANNA_DISABLE_SELF_UPDATE: "1" } : {}),
      },
    })

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null) return
      child.kill(signal)
    }

    const onSigint = () => {
      forwardSignal("SIGINT")
    }
    const onSigterm = () => {
      forwardSignal("SIGTERM")
    }

    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)

    child.once("error", (error) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      reject(error)
    })

    child.once("exit", (code, signal) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      resolve({ code, signal })
    })
  })
}

const argv = process.argv.slice(2)
let suppressOpenOnNextChild = false
let skipUpdateOnNextChild = false
let lastStartupUpdateRestart = false

while (true) {
  const result = await spawnChild(argv)
  if (shouldRestartCliProcess(result.code, result.signal)) {
    const isStartupUpdate = result.signal === null && result.code === CLI_STARTUP_UPDATE_RESTART_EXIT_CODE

    // Guard against infinite restart loops: if two consecutive startup-update
    // restarts happen it means the installed update did not change the binary
    // that actually runs (e.g. when launched via `bunx`, which maintains its
    // own package cache). Skip the self-update on the next spawn so the child
    // proceeds normally instead of trying to update again.
    if (isStartupUpdate && lastStartupUpdateRestart) {
      console.log(`${LOG_PREFIX} update installed but the running binary did not change, continuing with current version`)
      skipUpdateOnNextChild = true
      lastStartupUpdateRestart = false
    } else {
      lastStartupUpdateRestart = isStartupUpdate
    }

    suppressOpenOnNextChild = isUiUpdateRestart(result.code, result.signal)
    console.log(`${LOG_PREFIX} supervisor restarting ${CLI_COMMAND} in the same terminal session`)
    continue
  }

  process.exit(result.code ?? (result.signal ? 1 : 0))
}
