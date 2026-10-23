import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { KannaToolRuntime } from "./kanna-tools"
import { externalResource } from "./kanna-visualization-tool"
import { readVisualizationArtifact, visualizationHeight, visualizationLink } from "../shared/visualization"
import { copyTranscriptMedia, getTranscriptMediaDir, parseTranscriptMediaUrl, retargetEntryMediaUrls } from "./transcript-media"
import type { TranscriptEntry } from "../shared/types"
import { runTest } from "./effect/testing"
import { testPlatformContext } from "./platform/testing"
let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kanna-visualization-")) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test("snapshots local HTML and keeps forked visualizations after the source is removed", async () => {
  const source = path.join(dir, 'demo.html')
  await writeFile(source, '<button onclick="this.textContent=42">Calculate</button>')
  const entries: TranscriptEntry[] = []
  const runtime = new KannaToolRuntime({ platform: testPlatformContext, chatId: 'source', cwd: dir, dataDir: dir,
    emit: async entry => { entries.push(entry) }, requestInput: async () => ({}) })
  const result = await runtime.execute('show_visualization', { title: 'Calculator', path: 'demo.html' })
  expect(result.isError).not.toBe(true)
  const entry = entries[1]!
  if (entry.kind !== 'tool_result') throw Error('Expected result')
  const artifact = readVisualizationArtifact(entry.content)!
  expect(artifact.title).toBe('Calculator')
  await rm(source)
  await runTest(copyTranscriptMedia(dir, 'source', 'fork'))
  const forked = retargetEntryMediaUrls(entry, 'source', 'fork')
  if (forked.kind !== 'tool_result') throw Error('Expected result')
  const fork = readVisualizationArtifact(forked.content)!
  expect(fork.url).toContain('/fork/')
  await rm(getTranscriptMediaDir(dir, 'source'), { recursive: true })
  const html = await readFile(path.join(getTranscriptMediaDir(dir, 'fork'), parseTranscriptMediaUrl(fork.url)!.name), 'utf8')
  expect(html).toContain('Calculate')
  expect(html).toContain('sandbox="allow-scripts"')
})

test("refuses a document that loads something external, and says what to do instead", async () => {
  const runtime = new KannaToolRuntime({ platform: testPlatformContext, chatId: 's', cwd: dir, dataDir: dir, emit: async () => {}, requestInput: async () => ({}) })
  const refused = await runtime.execute('show_visualization', { title: 'CDN', html: '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script><svg></svg>' })
  expect(refused.isError).toBe(true)
  expect(refused.content[0]!.text).toContain("a script from https://cdn.jsdelivr.net/npm/d3@7")
  expect(refused.content[0]!.text).toContain("Inline the script")
  expect(externalResource('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">')).toContain("a stylesheet from")
  expect(externalResource('<style>@import url("https://fonts.googleapis.com/css");</style>')).toContain("a stylesheet from")
  expect(externalResource('<img alt="" src="https://example.com/a.png">')).toBe("an image from https://example.com/a.png")
  // Links out, inline scripts that mention a URL, namespaces and data: images all load nothing.
  expect(externalResource('<script>const src = "https://example.com"</script><a href="https://example.com">x</a><svg xmlns="http://www.w3.org/2000/svg"></svg><img src="data:image/png;base64,AAAA">')).toBeNull()
})

test("rejects oversized UTF-8 and directories", async () => {
  const runtime = new KannaToolRuntime({ platform: testPlatformContext, chatId: 's', cwd: dir, dataDir: dir, emit: async () => {}, requestInput: async () => ({}) })
  expect((await runtime.execute('show_visualization', { title: 'Too big', html: '💜'.repeat(600000) })).isError).toBe(true)
  expect((await runtime.execute('show_visualization', { title: 'Directory', path: dir })).isError).toBe(true)
})

test("client accepts only saved or exported visualization artifacts and bounded bridge values", () => {
  const base = { type: 'visualization', version: 1, title: 'Tool', height: 360 }
  for (const url of ['https://bad.invalid/a.html', '/api/chats/c/media/attachment-a.html', '/api/chats/c/media/../a.html', 'javascript:alert(1)']) {
    expect(readVisualizationArtifact([{ ...base, url }])).toBeNull()
  }
  expect(readVisualizationArtifact([{ ...base, url: './attachments/visualization-abc.html' }])).not.toBeNull()
  expect(visualizationHeight(NaN)).toBeNull()
  expect(visualizationHeight(-1)).toBeNull()
  expect(visualizationHeight(99999)).toBe(2000)
  expect(visualizationLink('file:///etc/passwd')).toBeNull()
  expect(visualizationLink('https://example.com/report')).toBe('https://example.com/report')
})

test("download bridge permits bounded text exports without letting widgets choose host paths", async () => {
  const { visualizationDownload } = await import('../shared/visualization')
  expect(visualizationDownload({ filename: '../../private/report', content: 'a,b\n1,2', mimeType: 'text/csv' }))
    .toEqual({ filename: '_.._private_report.csv', content: 'a,b\n1,2', mimeType: 'text/csv' })
  expect(visualizationDownload({ filename: 'a.html', content: '<script>alert(1)</script>', mimeType: 'text/html' })).toBeNull()
  expect(visualizationDownload({ filename: 'data', content: '💜'.repeat(600000), mimeType: 'text/plain' })).toBeNull()
  expect(visualizationDownload({ content: '{}', mimeType: 'application/json' })?.filename).toBe('data.json')
})
