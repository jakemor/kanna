import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Kanna's server runs on Bun today and is meant to run on other hosts (a
 * Durable Object, with the machine in a container) by swapping the platform
 * layers. That only works if every use of Bun or the OS goes through a
 * service in `platform/`. This test holds that line: outside the bindings
 * (`platform/bun/`) and the `kanna` process's own entry points, no server
 * module may import an OS-bound module or touch `Bun.*` / `process.*`.
 */

const SERVER_DIR = path.join(import.meta.dir, "..")

const FORBIDDEN_MODULES = new Set([
  "bun",
  "default-shell",
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:process",
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:v8",
  "node:vm",
  "node:worker_threads",
])

const FORBIDDEN_GLOBALS: ReadonlyArray<readonly [RegExp, string]> = [
  // A property access (`session.process`) isn't the global; a spread
  // (`...process.env`) is.
  [/(?<![\w$])(?<![^.]\.)Bun\.[A-Za-z]/, "Bun.*"],
  [/\bimport\.meta\.(?:dir|dirname|file|filename|path|main)\b/, "import.meta (Bun's file location)"],
  [/(?<![\w$])(?<![^.]\.)process\.(?:env|platform|arch|cwd|argv|exit|exitCode|on|once|off|kill|pid|ppid|stdout|stderr|stdin|memoryUsage|cpuUsage|uptime|hrtime|chdir|execPath|versions|umask)\b/, "process.*"],
]

/**
 * The `kanna` OS process itself: argv, exit codes, signals, the supervisor
 * that spawns the server child, the single-instance socket. A hosted build
 * never loads these.
 */
const PROCESS_ENTRY_POINTS: Record<string, string> = {
  "entry.ts": "chooses supervisor or server child from the process env",
  "cli.ts": "the server child's main: argv, exit, signals",
  "cli-supervisor.ts": "spawns and restarts the server child, forwards signals",
  "cli-runtime.ts": "CLI commands: argv parsing, stdout, exit codes",
  "instance-socket.ts": "single-instance coordination over a local unix socket",
  "effect/main.ts": "runs a kanna process's program and exits with its code",
  "server-bun.ts": "starts the server on Bun, finding dist/ from its own location",
}

/**
 * Modules that compose the Bun bindings into something runnable, and so may
 * import them (`effect/runtime`, `platform/bun`). Every other module takes
 * its platform from its caller, so another host can hand it a different one.
 */
const BUN_COMPOSITION_ROOTS: Record<string, string> = {
  "effect/runtime.ts": "ServerPlatform: the Bun bindings plus the logger",
  "event-store-bridge.ts": "Promise face of the event store, kept for tests",
  "orchestrator-bridge.ts": "Promise face of the orchestrator, kept for tests",
}

const BINDINGS_IMPORT = "imports the Bun bindings"

/**
 * Modules not yet moved onto the platform services. Shrinks to empty; a
 * module that no longer needs its entry fails the test until it is removed.
 */
const PENDING: ReadonlySet<string> = new Set<string>([
])

function serverModules(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (relative === "platform/bun" || relative === "testing" || entry.name === "__fixtures__") return []
      return serverModules(path.join(directory, entry.name), relative)
    }
    if (!entry.name.endsWith(".ts")) return []
    // Tests, fakes and test helpers run on Bun by definition.
    if (/\.(test|fake|e2e)\.ts$/.test(entry.name) || entry.name === "testing.ts") return []
    return [relative]
  })
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

/** Comments can mention `Bun.spawn` freely; only code counts. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

export function findViolations(source: string): string[] {
  const code = stripComments(source)
  const found = new Set<string>()
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2]
    if (specifier && FORBIDDEN_MODULES.has(specifier)) found.add(`imports ${specifier}`)
    if (specifier && /(?:^|\/)(?:effect\/runtime|platform\/bun)(?:\/|$)/.test(specifier)) found.add(BINDINGS_IMPORT)
  }
  for (const [pattern, label] of FORBIDDEN_GLOBALS) {
    if (pattern.test(code)) found.add(`uses ${label}`)
  }
  return [...found].sort()
}

describe("server portability", () => {
  const modules = serverModules(SERVER_DIR)
  const violations = new Map(modules.map((file) => [file, findViolations(readFileSync(path.join(SERVER_DIR, file), "utf8"))]))

  test("only the platform bindings and process entry points touch Bun or the OS", () => {
    const offenders = [...violations]
      .map(([file, found]) => [file, file in BUN_COMPOSITION_ROOTS ? found.filter((v) => v !== BINDINGS_IMPORT) : found] as const)
      .filter(([file, found]) => found.length > 0 && !(file in PROCESS_ENTRY_POINTS) && !PENDING.has(file))
      .map(([file, found]) => `${file}: ${found.join(", ")}`)
    expect(offenders).toEqual([])
  })

  test("the pending list names only modules that still need it", () => {
    const stale = [...PENDING].filter((file) => (violations.get(file) ?? []).length === 0)
    expect(stale).toEqual([])
  })

  test("the scan catches what it should", () => {
    expect(findViolations(`import { spawn } from "node:child_process"`)).toEqual(["imports node:child_process"])
    expect(findViolations(`import type { ServerWebSocket } from "bun"`)).toEqual(["imports bun"])
    expect(findViolations(`const x = Bun.spawn(["git"])`)).toEqual(["uses Bun.*"])
    expect(findViolations(`if (process.platform === "win32") {}`)).toEqual(["uses process.*"])
    expect(findViolations(`session.process.kill()`)).toEqual([])
    expect(findViolations(`const env = { ...process.env }`)).toEqual(["uses process.*"])
    expect(findViolations(`// Bun.spawn used to live here`)).toEqual([])
    expect(findViolations(`import path from "node:path"`)).toEqual([])
    expect(findViolations(`import { ServerPlatform } from "./effect/runtime"`)).toEqual([BINDINGS_IMPORT])
    expect(findViolations(`import { BunPlatform } from "../platform/bun"`)).toEqual([BINDINGS_IMPORT])
    expect(findViolations(`const dist = path.join(import.meta.dir, "dist")`)).toEqual(["uses import.meta (Bun's file location)"])
  })
})
