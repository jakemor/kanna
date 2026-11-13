export const VISUALIZATION_TOOL_NAME = "show_visualization"
export const VISUALIZATION_MAX_BYTES = 2 * 1024 * 1024
/**
 * The tallest a frame gets, asked for or measured. Content past it scrolls
 * inside the frame. The iOS app has the same number (`VisualizationArtifact.maxHeight`).
 */
export const VISUALIZATION_MAX_HEIGHT = 2000

/**
 * The expand button the web client lays over an inline visualization's
 * top-right corner, in CSS px: flush in the corner, on the edge, with no
 * inset. `clear` is the square of that corner authored content keeps free:
 * the button and a margin. The tool description quotes it, so the button and
 * the prompt cannot drift apart.
 */
export const VISUALIZATION_EXPAND_BUTTON = { size: 28, inset: 0, clear: 40 } as const

export interface VisualizationArtifact {
  type: "visualization"
  version: 1
  url: string
  title: string
  height: number
}

// Only our immutable media files (or their exported copies) can become executable content.
export function isVisualizationUrl(value: string): boolean {
  return /^\/api\/chats\/[a-zA-Z0-9_-]+\/media\/visualization-[a-zA-Z0-9_-]+\.html$/.test(value)
    || /^\.\/attachments\/visualization-[a-zA-Z0-9_-]+\.html$/.test(value)
}

export function readVisualizationArtifact(value: unknown): VisualizationArtifact | null {
  if (!Array.isArray(value)) return null
  const artifact = value.find(item => item?.type === "visualization")
  if (!artifact || artifact.version !== 1 || typeof artifact.title !== "string"
    || typeof artifact.url !== "string" || !isVisualizationUrl(artifact.url)
    || typeof artifact.height !== "number" || !Number.isFinite(artifact.height)) return null
  return { ...artifact, height: Math.max(80, Math.min(VISUALIZATION_MAX_HEIGHT, artifact.height)) }
}

export function visualizationHeight(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(40, Math.min(VISUALIZATION_MAX_HEIGHT, Math.ceil(value))) : null
}

/** `URL` has already put every spelling of an address into one form. */
function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === "0.0.0.0"
    || hostname === "[::1]" || hostname === "[::]" || hostname.startsWith("[::ffff:7f")
}

/**
 * A link a visualization asks its host to open. The document is an agent's
 * and its script posts what it likes, so a link may not lead back to the
 * app (`appOrigin`, the page showing it) or to anything on this machine: a
 * tab there is on an origin that can reach the server.
 */
export function visualizationLink(value: unknown, appOrigin?: string): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null
    if (isLoopbackHostname(url.hostname) || (appOrigin !== undefined && url.origin === appOrigin)) return null
    return url.href
  } catch { return null }
}

/**
 * Heights a visualization has measured, each with the frame width it was
 * measured at, ascending by width. A page wraps differently at every width,
 * so a height says nothing without one.
 *
 * A client that shows a visualization keeps what it measured and reports it
 * to the server, which keeps it with the document (`visualization-heights.ts`).
 * The next client to show it starts its frame at that height in place of the
 * agent's guess, and nothing under the frame moves when the page loads. It
 * is only where the frame starts: the page still reports its own height once
 * it is in, and the frame follows that.
 */
export type VisualizationHeights = ReadonlyArray<readonly [width: number, height: number]>

const HEIGHT_WIDTH_STEP = 16
const HEIGHT_WIDTHS_KEPT = 24

/** Widths that lay a page out alike share a height. The chat column resizes by the pixel. */
export function visualizationWidthBucket(width: number): number {
  return Math.max(HEIGHT_WIDTH_STEP, Math.min(4096, Math.round(width / HEIGHT_WIDTH_STEP) * HEIGHT_WIDTH_STEP))
}

/** What was stored or sent, kept only if every pair is sound. */
export function readVisualizationHeights(value: unknown): VisualizationHeights {
  if (!Array.isArray(value) || value.length > HEIGHT_WIDTHS_KEPT) return []
  const heights: Array<readonly [number, number]> = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return []
    const height = visualizationHeight(entry[1])
    if (typeof entry[0] !== "number" || !Number.isFinite(entry[0]) || entry[0] <= 0 || height === null) return []
    heights.push([visualizationWidthBucket(entry[0]), height])
  }
  return heights.sort((left, right) => left[0] - right[0])
}

/** `heights` with this measurement in it. Past the limit, the width furthest from this one goes. */
export function withVisualizationHeight(heights: VisualizationHeights, width: number, height: number): VisualizationHeights {
  const bucket = visualizationWidthBucket(width)
  const fitted = visualizationHeight(height)
  if (fitted === null) return heights
  const next = [...heights.filter(([measured]) => measured !== bucket), [bucket, fitted] as const]
  while (next.length > HEIGHT_WIDTHS_KEPT) {
    let furthest = 0
    for (const [index, [measured]] of next.entries()) {
      if (Math.abs(measured - bucket) > Math.abs(next[furthest]![0] - bucket)) furthest = index
    }
    next.splice(furthest, 1)
  }
  return next.sort((left, right) => left[0] - right[0])
}

/**
 * The height to start a frame of this width at, or null with nothing
 * measured. At a width never measured it is the taller of the nearest one
 * on each side: a breakpoint between them can make the page as tall as
 * either, and a frame too short scrolls inside itself, where one too tall
 * only waits a moment with room to spare.
 */
export function pickVisualizationHeight(heights: VisualizationHeights, width: number): number | null {
  if (heights.length === 0) return null
  const bucket = visualizationWidthBucket(width)
  const above = heights.findIndex(([measured]) => measured >= bucket)
  // Wider than anything measured: the widest is the only neighbour.
  if (above === -1) return heights.at(-1)![1]
  const below = heights[above]![0] === bucket ? above : Math.max(0, above - 1)
  return Math.max(heights[below]![1], heights[above]![1])
}

/** Where a saved visualization's measured heights are read and reported, or null for one in an exported chat. */
export function visualizationHeightsUrl(url: string): string | null {
  return /^\/api\/chats\/[a-zA-Z0-9_-]+\/media\/visualization-[a-zA-Z0-9_-]+\.html$/.test(url) ? `${url}/heights` : null
}

export interface VisualizationDownload {
  filename: string
  content: string
  mimeType: "text/csv" | "application/json" | "text/plain"
}

export function visualizationDownload(value: unknown): VisualizationDownload | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const extensions: Record<string, string> = { "text/csv": ".csv", "application/json": ".json", "text/plain": ".txt" }
  if (typeof input.mimeType !== "string" || !Object.hasOwn(extensions, input.mimeType)
    || typeof input.content !== "string" || new TextEncoder().encode(input.content).length > VISUALIZATION_MAX_BYTES) return null
  let filename = typeof input.filename === "string" ? input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) : "data"
  if (!filename) filename = "data"
  if (!filename.endsWith(extensions[input.mimeType]!)) filename += extensions[input.mimeType]
  return { filename, content: input.content, mimeType: input.mimeType as VisualizationDownload["mimeType"] }
}
