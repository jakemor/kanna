import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { awaitParentExit, EXIT_WITH_PARENT_ENV_VAR } from "./mac-app"
import { runTest } from "./effect/testing"

const WATCH = { [EXIT_WITH_PARENT_ENV_VAR]: "1" }

/** The pid of a process that has already exited. */
async function deadPid() {
  const child = Bun.spawn(["true"])
  await child.exited
  return child.pid
}

describe("awaitParentExit", () => {
  test("never completes unless the app asked for it", async () => {
    const result = await runTest(awaitParentExit({}, await deadPid()).pipe(Effect.timeoutOption("2500 millis")))
    expect(Option.isNone(result)).toBe(true)
  })

  test("never completes for a parent that is launchd", async () => {
    const result = await runTest(awaitParentExit(WATCH, 1).pipe(Effect.timeoutOption("50 millis")))
    expect(Option.isNone(result)).toBe(true)
  })

  test("keeps waiting while the parent lives", async () => {
    const result = await runTest(awaitParentExit(WATCH, process.pid).pipe(Effect.timeoutOption("2500 millis")))
    expect(Option.isNone(result)).toBe(true)
  })

  test("completes at the first check after the parent is gone", async () => {
    const result = await runTest(awaitParentExit(WATCH, await deadPid()).pipe(Effect.timeoutOption("3 seconds")))
    expect(Option.isSome(result)).toBe(true)
  })
})
