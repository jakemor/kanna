import { describe, expect, test } from "bun:test"
import { spawnPtyProcess } from "./pty-process.adapter"

describe("spawnPtyProcess", () => {
  test(
    "spawns a child process and exits cleanly",
    async () => {
      if (process.platform === "win32") {
        console.log("skip: PTY not supported on Windows")
        return
      }
      if (typeof Bun.Terminal !== "function") {
        console.log("skip: Bun.Terminal not available")
        return
      }
      const handle = await spawnPtyProcess({
        command: "/bin/sh",
        args: ["-c", "echo hello"],
        cwd: "/tmp",
        env: process.env,
        cols: 80,
        rows: 24,
      })
      const exitCode = await handle.exited
      expect(exitCode).toBe(0)
      handle.close()
    },
    30_000,
  )

  test(
    "captures output via onOutput callback",
    async () => {
      if (process.platform === "win32" || typeof Bun.Terminal !== "function") return
      const chunks: string[] = []
      const handle = await spawnPtyProcess({
        command: "/bin/sh",
        args: ["-c", "echo hi"],
        cwd: "/tmp",
        env: process.env,
        onOutput: (chunk) => chunks.push(chunk),
      })
      await handle.exited
      handle.close()
      expect(chunks.join("")).toContain("hi")
    },
    30_000,
  )
})
