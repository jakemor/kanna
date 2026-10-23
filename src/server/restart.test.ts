import { describe, expect, test } from "bun:test"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_UI_UPDATE_RESTART_EXIT_CODE,
  isUiUpdateRestart,
  parseChildArgsEnv,
  sanitizeRestartArgv,
  shouldRestartCliProcess,
  splitBunRuntimeFlags,
  withBunRuntimeFlags,
} from "./restart"

describe("splitBunRuntimeFlags", () => {
  test("pulls inspector flags out and leaves kanna's own flags", () => {
    expect(splitBunRuntimeFlags(["--no-open", "--inspect", "--port", "4000"], "/home/u/.kanna/profiles", "/home/u")).toEqual({
      bunArgs: ["--inspect"],
      argv: ["--no-open", "--port", "4000"],
    })
    expect(splitBunRuntimeFlags(["--inspect-wait=127.0.0.1:9229", "--inspect-brk"], "/p", "/").bunArgs)
      .toEqual(["--inspect-wait=127.0.0.1:9229", "--inspect-brk"])
    expect(splitBunRuntimeFlags(["--inspector"], "/p", "/").argv).toEqual(["--inspector"])
  })

  test("--profile writes both profiles into the profile dir, heap dir relative to the cwd", () => {
    expect(splitBunRuntimeFlags(["--profile"], "/home/u/.kanna/profiles", "/home/u")).toEqual({
      bunArgs: [
        "--cpu-prof",
        "--cpu-prof-md",
        "--cpu-prof-dir=/home/u/.kanna/profiles",
        "--heap-prof",
        "--heap-prof-dir=.kanna/profiles",
      ],
      argv: [],
    })
    expect(splitBunRuntimeFlags(["--profile"], "/home/u/.kanna/profiles", "/tmp").bunArgs.at(-1))
      .toBe("--heap-prof-dir=../home/u/.kanna/profiles")
  })
})

describe("withBunRuntimeFlags", () => {
  const runtime = { execPath: "/bin/bun", script: "/pkg/bin/kanna", overridden: false }

  test("leaves the child alone without flags", () => {
    expect(withBunRuntimeFlags({ command: "kanna", args: [] }, [], runtime)).toEqual({ command: "kanna", args: [] })
  })

  test("runs the kanna script under bun with the flags", () => {
    expect(withBunRuntimeFlags({ command: "kanna", args: [] }, ["--inspect"], runtime))
      .toEqual({ command: "/bin/bun", args: ["--inspect", "/pkg/bin/kanna"] })
  })

  test("an overridden bun child gets the flags right after bun", () => {
    expect(withBunRuntimeFlags(
      { command: "bun", args: ["run", "./scripts/dev-server.ts"] },
      ["--inspect"],
      { ...runtime, overridden: true },
    )).toEqual({ command: "bun", args: ["--inspect", "run", "./scripts/dev-server.ts"] })
    expect(() => withBunRuntimeFlags({ command: "node", args: [] }, ["--inspect"], { ...runtime, overridden: true }))
      .toThrow("need the server child to run under bun")
  })
})

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
    expect(() => parseChildArgsEnv("[\"run\", 1]")).toThrow(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}`)
    expect(() => parseChildArgsEnv("not json")).toThrow(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}`)
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
