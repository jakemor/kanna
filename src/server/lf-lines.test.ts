import { expect, test } from "bun:test"
import { PassThrough, Readable } from "node:stream"
import { iterateLfLines, readLfLines } from "./lf-lines"

for (const mode of ["events", "iterator"] as const) {
  test(`${mode}: only LF delimits records across arbitrary UTF-8 chunks`, async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const done = mode === "events"
      ? new Promise<void>((resolve) => {
        readLfLines(stream, (line) => lines.push(line))
        stream.on("end", resolve)
      })
      : (async () => { for await (const line of iterateLfLines(stream)) lines.push(line) })()
    const record = JSON.stringify({ text: "é🙂\u2028\u2029\nend" })
    // Every byte boundary includes all possible splits of multibyte characters.
    for (const byte of Buffer.from(`${record}\r\n\nlast`)) stream.write(Buffer.from([byte]))
    stream.end()
    await done
    expect(lines).toEqual([record + "\r", "", "last"])
    expect(JSON.parse(lines[0]!)).toEqual({ text: "é🙂\u2028\u2029\nend" })
  })
}

test("iterator propagates read errors", async () => {
  const stream = new PassThrough()
  const reading = (async () => { for await (const _ of iterateLfLines(stream)) {} })()
  stream.destroy(new Error("read failed"))
  await expect(reading).rejects.toThrow("read failed")
})

test("iterator closes the input when the consumer stops early", async () => {
  const stream = Readable.from(["one\ntwo\n"])
  for await (const line of iterateLfLines(stream)) {
    expect(line).toBe("one")
    break
  }
  expect(stream.destroyed).toBe(true)
})
