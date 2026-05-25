export const CLI_CHILD_MODE_ENV_VAR = "KANNA_CLI_MODE"
export const CLI_CHILD_MODE = "child"
export const CLI_DEFERRED_RESTART_SIGNAL = "SIGUSR2" as const
export const CLI_STARTUP_UPDATE_RESTART_EXIT_CODE = 75
export const CLI_UI_UPDATE_RESTART_EXIT_CODE = 76
export const CLI_CHILD_COMMAND_ENV_VAR = "KANNA_CLI_CHILD_COMMAND"
export const CLI_CHILD_ARGS_ENV_VAR = "KANNA_CLI_CHILD_ARGS"
export const CLI_SUPPRESS_OPEN_ONCE_ENV_VAR = "KANNA_SUPPRESS_OPEN_ONCE"

export function shouldRestartCliProcess(code: number | null, signal: NodeJS.Signals | null) {
  return signal === null && (code === CLI_STARTUP_UPDATE_RESTART_EXIT_CODE || code === CLI_UI_UPDATE_RESTART_EXIT_CODE)
}

export function isUiUpdateRestart(code: number | null, signal: NodeJS.Signals | null) {
  return signal === null && code === CLI_UI_UPDATE_RESTART_EXIT_CODE
}

export function parseChildArgsEnv(value: string | undefined) {
  if (!value) return []

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error("child args must be an array of strings")
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}: ${message}`)
  }
}
