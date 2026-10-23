import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Option, Result, Schema, Scope } from "effect"
import { type CliSpawnArgs, collectCliOutput, lenient, pumpCliTurn, spawnCli } from "./cli-process"
import { makeFakeCli } from "./cli-process.fake"
import { runTest } from "./effect/testing"

const sh = (args: CliSpawnArgs) => spawnCli("sh").pipe(Effect.flatMap((spawn) => spawn(args)))

describe("spawnCli", () => {
  test("collects both pipes and the exit code, with stdin written then closed", () => runTest(Effect.gen(function* () {
    const output = yield* sh({ cwd: "/tmp", argv: ["-c", "cat; echo oops >&2; pwd; exit 3"], stdin: "from stdin\n" }).pipe(
      Effect.flatMap(collectCliOutput),
      Effect.scoped,
    )
    expect(output.stdout).toMatch(/^from stdin\n.*tmp\n$/)
    expect(output.stderr).toBe("oops\n")
    expect(output.exitCode).toBe(3)
  })))

  test("without stdin, stdin is closed from the start", () => runTest(Effect.gen(function* () {
    const output = yield* sh({ cwd: "/tmp", argv: ["-c", "cat; echo done"] }).pipe(Effect.flatMap(collectCliOutput), Effect.scoped)
    expect(output).toMatchObject({ stdout: "done\n", exitCode: 0 })
  })))

  test("a signalled process exits with no code", () => runTest(Effect.gen(function* () {
    const proc = yield* sh({ cwd: "/tmp", argv: ["-c", "sleep 30"] })
    yield* proc.kill("SIGINT")
    expect(yield* proc.exitCode).toBeNull()
  })))

  test("closing the scope kills the process", () => runTest(Effect.gen(function* () {
    const scope = yield* Scope.make()
    const proc = yield* sh({ cwd: "/tmp", argv: ["-c", "sleep 30"] }).pipe(Scope.provide(scope))
    yield* Scope.close(scope, Exit.void)
    expect(yield* proc.exitCode.pipe(Effect.timeout("5 seconds"))).toBeNull()
  })))

  test("a missing binary fails with the spawn error's own message", () => runTest(Effect.gen(function* () {
    const result = yield* Effect.result(spawnCli("kanna-no-such-cli").pipe(Effect.flatMap((spawn) => spawn({ cwd: "/tmp", argv: [] }))))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
      expect(result.failure.message).toContain("kanna-no-such-cli")
    }
  })))
})

describe("pumpCliTurn", () => {
  test("hands over lines as they arrive and exits after the pipes drain", () => runTest(Effect.gen(function* () {
    const seen: string[] = []
    const exited = yield* Deferred.make<{ readonly code: number | null; readonly stderr: string }>()
    const spawnSh = yield* spawnCli("sh")
    const proc = yield* pumpCliTurn({
      spawn: spawnSh({ cwd: "/tmp", argv: ["-c", "printf 'a\\nb\\r\\nc'; printf 'warn' >&2; exit 2"] }),
      onLine: (line) => Effect.sync(() => { seen.push(line) }),
      onExit: (value) => Deferred.succeed(exited, value).pipe(Effect.asVoid),
    })
    const exit = yield* Deferred.await(exited)
    expect(Option.isSome(proc)).toBe(true)
    expect(seen).toEqual(["a", "b", "c"])
    expect(exit).toEqual({ code: 2, stderr: "warn" })
  })))

  test("a spawn failure goes straight to onExit with the error as stderr", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli({ spawnError: "Executable not found" })
    const exited = yield* Deferred.make<{ readonly code: number | null; readonly stderr: string }>()
    const proc = yield* pumpCliTurn({
      spawn: fake.spawn({ cwd: "/tmp", argv: [] }),
      onLine: () => Effect.void,
      onExit: (value) => Deferred.succeed(exited, value).pipe(Effect.asVoid),
    })
    const exit = yield* Deferred.await(exited)
    expect(Option.isNone(proc)).toBe(true)
    expect(exit).toEqual({ code: null, stderr: "\nExecutable not found" })
  })))
})

describe("lenient", () => {
  test("reads a field of another type as absent instead of failing the struct", () => {
    const decode = Schema.decodeUnknownSync(Schema.Struct({ name: lenient(Schema.String), count: lenient(Schema.Number) }))
    expect(decode({ name: "x", count: 1, extra: true })).toEqual({ name: "x", count: 1 })
    expect(decode({ name: 5, count: "1" })).toEqual({})
  })
})
