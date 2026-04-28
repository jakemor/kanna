import { describe, expect, test } from "bun:test"
import { evaluateBashOutput } from "./detector"

describe("evaluateBashOutput", () => {
  test("extracts port from Vite-style localhost URL", () => {
    const result = evaluateBashOutput({
      command: "bun run dev",
      stdout: "  ➜  Local:   http://localhost:5173/\n",
    })
    expect(result).toEqual({ isServer: true, ports: [5173] })
  })

  test("extracts port from 'listening on PORT'", () => {
    const result = evaluateBashOutput({
      command: "go run main.go",
      stdout: "Server listening on port 8080\n",
    })
    expect(result).toEqual({ isServer: true, ports: [8080] })
  })

  test("dedups + sorts multiple ports", () => {
    const result = evaluateBashOutput({
      command: "bun run dev",
      stdout: "Local: http://localhost:5174\nNetwork: http://127.0.0.1:5174\nHMR ready on port 5173\n",
    })
    expect(result).toEqual({ isServer: true, ports: [5173, 5174] })
  })

  test("handles ipv6 [::1]:port", () => {
    const result = evaluateBashOutput({
      command: "node server.js",
      stdout: "Listening on [::1]:3000\n",
    })
    expect(result).toEqual({ isServer: true, ports: [3000] })
  })

  test("handles 0.0.0.0:port", () => {
    const result = evaluateBashOutput({
      command: "uvicorn app:main",
      stdout: "Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)\n",
    })
    expect(result).toEqual({ isServer: true, ports: [8000] })
  })

  test("returns no-server for non-server output", () => {
    expect(evaluateBashOutput({ command: "ls", stdout: "a b c\n" })).toEqual({ isServer: false })
  })

  test("rejects ports below 1024", () => {
    const result = evaluateBashOutput({
      command: "x",
      stdout: "localhost:80 listening\n",
    })
    expect(result).toEqual({ isServer: false })
  })

  test("caps at 5 ports", () => {
    const stdout = Array.from({ length: 10 }, (_, i) => `localhost:${5000 + i}`).join("\n")
    const result = evaluateBashOutput({ command: "x", stdout })
    if (result.isServer) {
      expect(result.ports).toHaveLength(5)
    } else {
      throw new Error("expected isServer true")
    }
  })

  test("trims stdout to last 8KB", () => {
    const stdout = "x".repeat(20_000) + "\nLocal: http://localhost:5173"
    const result = evaluateBashOutput({ command: "x", stdout })
    expect(result).toEqual({ isServer: true, ports: [5173] })
  })
})
