import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  pickVisualizationHeight,
  readVisualizationHeights,
  visualizationHeightsUrl,
  visualizationWidthBucket,
  withVisualizationHeight,
  VISUALIZATION_MAX_HEIGHT,
} from "../shared/visualization"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { handleVisualizationHeights, readStoredVisualizationHeights, storeVisualizationHeight } from "./visualization-heights"

describe("a visualization's measured heights", () => {
  test("a height belongs to the width it was measured at, and near widths share one", () => {
    expect(visualizationWidthBucket(728)).toBe(visualizationWidthBucket(731))
    expect(visualizationWidthBucket(728)).not.toBe(visualizationWidthBucket(393))
    let heights = withVisualizationHeight([], 728, 412.2)
    heights = withVisualizationHeight(heights, 393, 610)
    expect(heights).toEqual([[400, 610], [736, 413]])
    // Measured again at the same width: the newer height stands, alone.
    expect(withVisualizationHeight(heights, 730, 500)).toEqual([[400, 610], [736, 500]])
    expect(withVisualizationHeight(heights, 728, 99999)).toEqual([[400, 610], [736, VISUALIZATION_MAX_HEIGHT]])
    expect(withVisualizationHeight(heights, 728, Number.NaN)).toBe(heights)
  })

  test("a frame starts at the height measured at its width, or the taller of its neighbours'", () => {
    const heights = readVisualizationHeights([[736, 413], [400, 610]])
    expect(pickVisualizationHeight([], 728)).toBeNull()
    expect(pickVisualizationHeight(heights, 728)).toBe(413)
    expect(pickVisualizationHeight(heights, 393)).toBe(610)
    // Between two measured widths a breakpoint can make it as tall as either.
    expect(pickVisualizationHeight(heights, 560)).toBe(610)
    // Past the widest or the narrowest, the nearest is all there is.
    expect(pickVisualizationHeight(heights, 1200)).toBe(413)
    expect(pickVisualizationHeight(heights, 320)).toBe(610)
  })

  test("only sound pairs are read, and no more than are kept", () => {
    expect(readVisualizationHeights([[736, 413]])).toEqual([[736, 413]])
    for (const bad of [null, "x", [[736]], [[736, -1]], [["736", 413]], [[0, 413]], [[736, 413], "x"]]) {
      expect(readVisualizationHeights(bad)).toEqual([])
    }
    let heights = readVisualizationHeights([])
    for (let width = 320; width <= 320 + 16 * 40; width += 16) heights = withVisualizationHeight(heights, width, 400)
    expect(heights).toHaveLength(24)
    // The last width measured is kept, and the ones furthest from it went.
    expect(heights.at(-1)![0]).toBe(960)
    expect(heights[0]![0]).toBeGreaterThan(320)
  })

  test("only a saved visualization on a server has somewhere to report to", () => {
    expect(visualizationHeightsUrl("/api/chats/chat-1/media/visualization-abc.html")).toBe("/api/chats/chat-1/media/visualization-abc.html/heights")
    expect(visualizationHeightsUrl("./attachments/visualization-abc.html")).toBeNull()
    expect(visualizationHeightsUrl("/api/chats/chat-1/media/attachment-abc.png")).toBeNull()
  })
})

describe("the server keeps them beside the document", () => {
  let dir: string
  const documentUrl = "/api/chats/chat-1/media/visualization-abc.html"
  const store = { resolveTranscriptMediaPath: (url: string) => url === documentUrl ? path.join(dir, "visualization-abc.html") : null }
  const request = (method: string, pathname: string, body?: unknown) => {
    const url = new URL(`http://localhost${pathname}`)
    return runTest(handleVisualizationHeights(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, store))
  }
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kanna-visualization-heights-"))
    await writeFile(path.join(dir, "visualization-abc.html"), "<!doctype html>")
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test("what one client reports the next one reads, per width", async () => {
    expect(await (await request("GET", `${documentUrl}/heights`))!.json()).toEqual({ heights: [] })
    await request("PUT", `${documentUrl}/heights`, { width: 728, height: 412 })
    const reported = await request("PUT", `${documentUrl}/heights`, { width: 393, height: 610 })
    expect(await reported!.json()).toEqual({ heights: [[400, 610], [736, 412]] })
    const read = await request("GET", `${documentUrl}/heights`)
    expect(read!.headers.get("Cache-Control")).toBe("no-store")
    expect(await read!.json()).toEqual({ heights: [[400, 610], [736, 412]] })
    expect(await runTest(readStoredVisualizationHeights(path.join(dir, "visualization-abc.html")))).toEqual([[400, 610], [736, 412]])
  })

  test("it answers only for a document it has, and only with a width and a height", async () => {
    expect(await request("GET", documentUrl)).toBeNull()
    expect(await request("GET", "/api/chats/chat-1/media/attachment-abc.png/heights")).toBeNull()
    expect((await request("GET", "/api/chats/chat-2/media/visualization-abc.html/heights"))!.status).toBe(404)
    expect((await request("DELETE", `${documentUrl}/heights`))!.status).toBe(405)
    for (const body of [{ width: 728 }, { width: "728", height: 400 }, { width: 728, height: -5 }, "nonsense"]) {
      expect((await request("PUT", `${documentUrl}/heights`, body))!.status).toBe(400)
    }
    // A file cut short is nothing known, not an error.
    await writeFile(path.join(dir, "visualization-abc.html.heights.json"), "[[736,")
    expect(await (await request("GET", `${documentUrl}/heights`))!.json()).toEqual({ heights: [] })
  })

  test("a height that cannot be written fails as a write error, naming the file", async () => {
    const documentPath = path.join(dir, "gone", "visualization-abc.html")
    const result = await runTest(Effect.result(storeVisualizationHeight(documentPath, 728, 412)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/visualization-heights/VisualizationHeightsWriteError")
      expect(result.failure.filePath).toBe(`${documentPath}.heights.json`)
    }
  })
})
