export type ThinkingSegment =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }

const THINKING_TAG_REGEX = /<thinking>([\s\S]*?)<\/thinking>/gi

// Split assistant text into thinking and non-thinking segments. Prompted
// `<thinking>...</thinking>` blocks are emitted by some models alongside
// their visible answer; the UI renders them collapsed instead of inline.
// Unterminated `<thinking>` (still streaming) is treated as one open block
// so the user sees the partial monologue, not the raw tag.
export function parseThinkingSegments(text: string): ThinkingSegment[] {
  const segments: ThinkingSegment[] = []
  let cursor = 0

  THINKING_TAG_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = THINKING_TAG_REGEX.exec(text)) !== null) {
    if (match.index > cursor) {
      const chunk = text.slice(cursor, match.index)
      if (chunk.length > 0) segments.push({ kind: "text", content: chunk })
    }
    segments.push({ kind: "thinking", content: match[1] ?? "" })
    cursor = match.index + match[0].length
  }

  const tail = text.slice(cursor)
  const openIdx = tail.search(/<thinking>/i)
  if (openIdx !== -1) {
    const before = tail.slice(0, openIdx)
    if (before.length > 0) segments.push({ kind: "text", content: before })
    const after = tail.slice(openIdx + "<thinking>".length)
    segments.push({ kind: "thinking", content: after })
  } else if (tail.length > 0) {
    segments.push({ kind: "text", content: tail })
  }

  return collapseAdjacentText(segments)
}

function collapseAdjacentText(segments: ThinkingSegment[]): ThinkingSegment[] {
  const out: ThinkingSegment[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (seg.kind === "text" && prev && prev.kind === "text") {
      prev.content += seg.content
    } else {
      out.push(seg)
    }
  }
  return out
}

export function stripThinking(text: string): string {
  return parseThinkingSegments(text)
    .filter((s) => s.kind === "text")
    .map((s) => s.content)
    .join("")
}
