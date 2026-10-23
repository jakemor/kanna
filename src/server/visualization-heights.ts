import { Effect, FileSystem, Option, Schema } from "effect"
import { readVisualizationHeights, withVisualizationHeight, type VisualizationHeights } from "../shared/visualization"
import type { EventStore } from "./event-store"

/**
 * The heights clients have measured a saved visualization at, kept in a file
 * beside its document (see `VisualizationHeights`). Beside it so they go
 * where the document goes: copied with a fork, removed with the chat.
 *
 * Over HTTP, not the socket, like the document they describe: the frame that
 * measures is a leaf of the transcript and holds no socket, and the export
 * viewer, which shows the same frame, has no server at all. And not on the
 * document's own response, which a browser caches for a year.
 */
const ROUTE = /^(\/api\/chats\/[a-zA-Z0-9_-]+\/media\/visualization-[a-zA-Z0-9_-]+\.html)\/heights$/

export class VisualizationHeightsWriteError extends Schema.TaggedError<VisualizationHeightsWriteError>()(
  "@kanna/server/visualization-heights/VisualizationHeightsWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

function heightsPath(documentPath: string) {
  return `${documentPath}.heights.json`
}

/** The stored file holds a bare array; `readVisualizationHeights` decides which pairs in it are sound. */
const decodeStoredHeights = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** What a client reports: one width and the height it measured there. */
const decodeMeasurement = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
})))

export const readStoredVisualizationHeights = Effect.fn("VisualizationHeights.read")(function* (documentPath: string) {
  const fs = yield* FileSystem.FileSystem
  // None measured yet, or a file cut short: nothing known, which is where every document starts.
  const text = yield* fs.readFileString(heightsPath(documentPath)).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", () => Effect.succeedNone),
  )
  return Option.match(Option.flatMap(text, decodeStoredHeights), {
    onNone: (): VisualizationHeights => [],
    onSome: readVisualizationHeights,
  })
})

export const storeVisualizationHeight = Effect.fn("VisualizationHeights.store")(function* (documentPath: string, width: number, height: number) {
  const fs = yield* FileSystem.FileSystem
  const heights = withVisualizationHeight(yield* readStoredVisualizationHeights(documentPath), width, height)
  // Whole or not at all: two tabs can report at once, and a reader must never see half a file.
  const target = heightsPath(documentPath)
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  yield* fs.writeFileString(temporary, JSON.stringify(heights)).pipe(
    Effect.andThen(fs.rename(temporary, target)),
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new VisualizationHeightsWriteError({ filePath: target, cause }))),
  )
  return heights
})

export const handleVisualizationHeights = Effect.fn("VisualizationHeights.handle")(function* (
  req: Request,
  url: URL,
  store: Pick<EventStore["Service"], "resolveTranscriptMediaPath">,
) {
  const match = url.pathname.match(ROUTE)
  if (!match) return null
  if (req.method !== "GET" && req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } })

  const fs = yield* FileSystem.FileSystem
  const documentPath = store.resolveTranscriptMediaPath(match[1]!)
  const exists = documentPath
    ? yield* fs.stat(documentPath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    )
    : false
  if (!documentPath || !exists) return Response.json({ error: "Visualization not found" }, { status: 404 })

  const headers = { "Cache-Control": "no-store" }
  if (req.method === "GET") return Response.json({ heights: yield* readStoredVisualizationHeights(documentPath) }, { headers })

  // An unreadable body is a bad request like a malformed one.
  const body = yield* Effect.tryPromise(() => req.text()).pipe(
    Effect.catchTag("UnknownError", () => Effect.succeed("")),
  )
  const [measured] = Option.match(decodeMeasurement(body), {
    onNone: (): VisualizationHeights => [],
    onSome: ({ width, height }) => readVisualizationHeights([[width, height]]),
  })
  if (!measured) return Response.json({ error: "Expected a width and a height" }, { status: 400 })
  return Response.json({ heights: yield* storeVisualizationHeight(documentPath, measured[0], measured[1]) }, { headers })
})
