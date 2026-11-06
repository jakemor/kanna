import type { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"

/** LF-delimited records, including JSONL and stdio JSON-RPC. Unlike Bun's
 * readline, Unicode line/paragraph separators remain part of the record.
 * StringDecoder preserves UTF-8 characters split across transport chunks.
 */
function lineDecoder() {
  const decoder = new StringDecoder("utf8")
  let fragments: string[] = []
  return {
    push(chunk: Buffer | string): string[] {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk)
      const lines: string[] = []
      let start = 0
      let newline: number
      // Scan each chunk once; a large unfinished record is joined only when
      // its delimiter arrives, rather than rescanned on every data event.
      while ((newline = text.indexOf("\n", start)) !== -1) {
        fragments.push(text.slice(start, newline))
        lines.push(fragments.join(""))
        fragments = []
        start = newline + 1
      }
      if (start < text.length) fragments.push(text.slice(start))
      return lines
    },
    end(): string[] {
      fragments.push(decoder.end())
      const last = fragments.join("")
      fragments = []
      return last.length ? [last] : []
    },
  }
}

/** Deliver records synchronously with data events, before process close. */
export function readLfLines(stream: Readable, onLine: (line: string) => void) {
  const decoder = lineDecoder()
  stream.on("data", (chunk: Buffer | string) => {
    for (const line of decoder.push(chunk)) onLine(line)
  })
  stream.on("end", () => {
    for (const line of decoder.end()) onLine(line)
  })
}

/** Pull records with backpressure for consumers that await work per line.
 * Stream errors propagate and early iterator exit destroys the input.
 */
export async function* iterateLfLines(stream: Readable) {
  const decoder = lineDecoder()
  for await (const chunk of stream) {
    yield* decoder.push(chunk)
  }
  yield* decoder.end()
}
