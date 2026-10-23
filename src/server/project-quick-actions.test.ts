import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { normalizeQuickActions, readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"

describe("project quick actions", () => {
  test("normalizes persisted quick actions", () => {
    expect(normalizeQuickActions({
      quickActions: [
        { id: "dev", label: "Dev", command: "bun run dev" },
        { id: "dev", label: "Duplicate", command: "echo duplicate" },
        { id: "empty", label: "Empty", command: " " },
        { id: "test", command: "bun test" },
      ],
    })).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
      { id: "test", label: "bun test", command: "bun test" },
    ])
  })

  test("writes quick actions to the project .kanna directory", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))

    const written = await runTest(writeProjectQuickActions(projectPath, [
      { id: "dev", label: "Dev", command: "bun run dev" },
    ]))

    expect(written).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
    ])
    expect(await runTest(readProjectQuickActions(projectPath))).toEqual(written)
    await expect(Bun.file(path.join(projectPath, ".kanna", "quick-actions.json")).exists()).resolves.toBe(true)
  })

  test("reads no quick actions from a missing or broken file", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))
    expect(await runTest(readProjectQuickActions(projectPath))).toEqual([])

    await mkdir(path.join(projectPath, ".kanna"), { recursive: true })
    await writeFile(path.join(projectPath, ".kanna", "quick-actions.json"), "{not json", "utf8")
    expect(await runTest(readProjectQuickActions(projectPath))).toEqual([])
  })

  test("fails with QuickActionsFileError when the file cannot be written", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))
    // A file where the .kanna directory should be.
    await writeFile(path.join(projectPath, ".kanna"), "", "utf8")
    const result = await runTest(Effect.result(writeProjectQuickActions(projectPath, [])))
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/project-quick-actions/QuickActionsFileError")
  })
})
