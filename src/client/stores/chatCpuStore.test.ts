import { describe, expect, test } from "bun:test"
import { chatCpuTotals } from "./chatCpuStore"

describe("chatCpuTotals", () => {
  test("a parent's figure is its own plus every descendant's, and counts the sub-chats", () => {
    const totals = chatCpuTotals(
      { parent: 2, child: 3, grandchild: 4, other: 9 },
      new Map([["child", "parent"], ["grandchild", "child"]]),
    )
    expect(totals.parent).toEqual({ percent: 9, subChats: 2 })
    expect(totals.child).toEqual({ percent: 7, subChats: 1 })
    expect(totals).not.toHaveProperty("grandchild")
    expect(totals).not.toHaveProperty("other")
  })

  test("a parent with no process of its own still shows its sub-chats", () => {
    expect(chatCpuTotals({ child: 5 }, new Map([["child", "parent"]]))).toEqual({ parent: { percent: 5, subChats: 1 } })
  })

  test("is capped at the whole machine and keeps one decimal under 10", () => {
    const parents = new Map([["a", "p"], ["b", "p"]])
    expect(chatCpuTotals({ a: 70, b: 60 }, parents).p?.percent).toBe(100)
    expect(chatCpuTotals({ a: 0.4, b: 0.3 }, parents).p?.percent).toBe(0.7)
  })

  test("a parent loop stops instead of running forever", () => {
    const totals = chatCpuTotals({ a: 1 }, new Map([["a", "b"], ["b", "a"]]))
    expect(totals.b).toEqual({ percent: 1, subChats: 1 })
  })
})
