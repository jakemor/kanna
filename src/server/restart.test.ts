import { describe, expect, test } from "bun:test"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_UI_UPDATE_RESTART_EXIT_CODE,
  isUiUpdateRestart,
  parseChildArgsEnv,
  sanitizeRestartArgv,
  shouldRestartCliProcess,
} from "./restart"

describe("shouldRestartCliProcess", () => {
  test("restarts only for the sentinel exit code without a signal", () => {
    expect(shouldRestartCliProcess(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(shouldRestartCliProcess(CLI_UI_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(shouldRestartCliProcess(0, null)).toBe(false)
    expect(shouldRestartCliProcess(1, null)).toBe(false)
    expect(shouldRestartCliProcess(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, "SIGTERM")).toBe(false)
    expect(isUiUpdateRestart(CLI_UI_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(isUiUpdateRestart(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, null)).toBe(false)
  })

  test("parses configured child args from the environment", () => {
    expect(parseChildArgsEnv(undefined)).toEqual([])
    expect(parseChildArgsEnv("[\"run\",\"./scripts/dev-server.ts\"]")).toEqual(["run", "./scripts/dev-server.ts"])
    expect(() => parseChildArgsEnv("{\"bad\":true}")).toThrow(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}`)
  })
})

describe("sanitizeRestartArgv", () => {
  test("a pair launch respawns as a plain run (codes are single-use)", () => {
    expect(sanitizeRestartArgv(["pair", "ABC123"])).toEqual([])
    expect(sanitizeRestartArgv(["pair", "--status"])).toEqual([])
  })

  test("normal launches respawn with their original flags", () => {
    expect(sanitizeRestartArgv([])).toEqual([])
    expect(sanitizeRestartArgv(["--no-open", "--port", "4000"])).toEqual(["--no-open", "--port", "4000"])
    expect(sanitizeRestartArgv(["--share"])).toEqual(["--share"])
  })
})
