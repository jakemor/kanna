import type { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"

/** LF-delimited records, including JSONL and stdio JSON-RPC. Unlike Bun's
 * readline, Unicode line/paragraph separators remain part of the record.
 * StringDecoder preserves UTF-8 characters split across transport chunks.
 */
function lineDecoder() {
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  return {
    push(chunk: Buffer | string): string[] {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      return lines
    },
    end(): string[] {
      buffer += decoder.end()
      return buffer.length ? [buffer] : []
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
