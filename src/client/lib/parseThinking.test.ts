import { describe, expect, test } from "bun:test"
import { parseThinkingSegments, stripThinking } from "./parseThinking"

describe("parseThinkingSegments", () => {
  test("returns single text segment when no tags", () => {
    expect(parseThinkingSegments("hello world")).toEqual([
      { kind: "text", content: "hello world" },
    ])
  })

  test("returns empty array for empty input", () => {
    expect(parseThinkingSegments("")).toEqual([])
  })

  test("splits a single thinking block", () => {
    const input = "<thinking>internal</thinking>visible"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "thinking", content: "internal" },
      { kind: "text", content: "visible" },
    ])
  })

  test("handles text before and after thinking block", () => {
    const input = "before <thinking>thought</thinking> after"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "text", content: "before " },
      { kind: "thinking", content: "thought" },
      { kind: "text", content: " after" },
    ])
  })

  test("handles multiple thinking blocks", () => {
    const input = "a<thinking>x</thinking>b<thinking>y</thinking>c"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "text", content: "a" },
      { kind: "thinking", content: "x" },
      { kind: "text", content: "b" },
      { kind: "thinking", content: "y" },
      { kind: "text", content: "c" },
    ])
  })

  test("preserves newlines inside thinking block", () => {
    const input = "<thinking>line1\nline2\nline3</thinking>done"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "thinking", content: "line1\nline2\nline3" },
      { kind: "text", content: "done" },
    ])
  })

  test("case insensitive tag matching", () => {
    const input = "<Thinking>foo</Thinking>bar"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "thinking", content: "foo" },
      { kind: "text", content: "bar" },
    ])
  })

  test("treats unclosed thinking tag as streaming open block", () => {
    const input = "before <thinking>still thinking..."
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "text", content: "before " },
      { kind: "thinking", content: "still thinking..." },
    ])
  })

  test("empty thinking block yields empty content segment", () => {
    const input = "a<thinking></thinking>b"
    expect(parseThinkingSegments(input)).toEqual([
      { kind: "text", content: "a" },
      { kind: "thinking", content: "" },
      { kind: "text", content: "b" },
    ])
  })
})

describe("stripThinking", () => {
  test("removes all thinking blocks", () => {
    expect(stripThinking("<thinking>x</thinking>hello")).toBe("hello")
    expect(stripThinking("a<thinking>x</thinking>b<thinking>y</thinking>c")).toBe("abc")
  })

  test("returns original text when no thinking blocks", () => {
    expect(stripThinking("plain text")).toBe("plain text")
  })
})
