import path from "node:path"
import { Effect, Exit, FileSystem, Schema, Scope } from "effect"
import type { KannaToolHost } from "./kanna-tools"
import { serveKannaMcp } from "./kanna-mcp"

export class CursorKannaToolsError extends Schema.TaggedError<CursorKannaToolsError>()(
  "@kanna/server/cursor-kanna-tools/CursorKannaToolsError",
  {
    operation: Schema.Literals(["make-directory", "start-server", "write"]),
    directory: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export interface CursorKannaTools {
  /** The plugin directory to hand `cursor-agent --plugin-dir`. */
  readonly directory: string
  /** Stops the MCP server and removes the directory, ahead of the scope. Idempotent. */
  readonly close: Effect.Effect<void>
}

/**
 * Kanna's MCP tools for one Cursor turn: a private plugin directory whose
 * `mcp.json` points at an MCP server bound to this chat, so the process gets
 * the tools without changing the project's MCP settings. Both live in the
 * caller's scope; `close` ends them sooner (when the CLI exits or is
 * interrupted).
 */
export const createCursorKannaTools = Effect.fn("CursorKannaTools.create")(function* (host: KannaToolHost) {
  const fs = yield* FileSystem.FileSystem
  // A failed removal is left behind, as before: it is a temp directory.
  const removeDirectory = (directory: string) =>
    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)

  const directory = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "kanna-cursor-tools-" }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new CursorKannaToolsError({ operation: "make-directory", cause }))),
    ),
    removeDirectory,
  )
  const serverScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const server = yield* Scope.provide(serveKannaMcp(host), serverScope).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(new CursorKannaToolsError({ operation: "start-server", directory, cause }))),
  )

  const write = (file: string, contents: string, options?: { readonly mode: number }) =>
    fs.writeFileString(path.join(directory, file), contents, options).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new CursorKannaToolsError({ operation: "write", directory, cause }))),
    )
  yield* fs.makeDirectory(path.join(directory, ".cursor-plugin")).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new CursorKannaToolsError({ operation: "write", directory, cause }))),
  )
  yield* write(".cursor-plugin/plugin.json", JSON.stringify({
    name: "kanna-tools",
    version: "1.0.0",
    description: "Tools for the current Kanna chat.",
  }))
  yield* write("mcp.json", JSON.stringify({
    mcpServers: {
      kanna: { url: server.url, headers: server.headers },
    },
  }), { mode: 0o600 })

  return {
    directory,
    close: Scope.close(serverScope, Exit.void).pipe(Effect.andThen(removeDirectory(directory))),
  } satisfies CursorKannaTools
})
