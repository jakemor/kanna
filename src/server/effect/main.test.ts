import { describe, expect, test } from "bun:test"
import path from "node:path"

const MAIN = path.join(import.meta.dir, "main.ts")

/** Runs `body` (the program passed to runKannaMain) in a bun process of its own. */
function runProgram(body: string) {
  const script = `
    import { Effect } from "effect"
    import { runKannaMain } from ${JSON.stringify(MAIN)}
    runKannaMain(${body})
  `
  return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", cwd: import.meta.dir })
}

describe("runKannaMain", () => {
  test("exits with the program's code, even with a timer still pending", async () => {
    const child = runProgram(`Effect.gen(function* () {
      yield* Effect.forkChild(Effect.sleep("1 hour"))
      return 7
    })`)
    expect(await child.exited).toBe(7)
  })

  test("logs a failure with Kanna's logger and exits 1", async () => {
    const child = runProgram(`Effect.fail(new Error("no data dir"))`)
    expect(await child.exited).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toStartWith("[kanna] ")
    expect(stderr).toContain("no data dir")
  })

  test("leaves SIGINT to the program", async () => {
    // Nothing in the program handles SIGINT, so it ends the process the
    // default way rather than interrupting the program (BunRuntime.runMain's 130).
    const child = runProgram(`Effect.gen(function* () {
      yield* Effect.sync(() => console.log("ready"))
      yield* Effect.never
      return 0
    })`)
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain("ready")
    child.kill("SIGINT")
    await child.exited
    expect(child.signalCode).toBe("SIGINT")
  })
})
