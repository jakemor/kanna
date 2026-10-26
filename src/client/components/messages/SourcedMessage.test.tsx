import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatSchedule } from "../../../shared/types"
import { ChatSchedulesProvider } from "../chat-ui/chat-reference"
import { REPLY_LINE, REPLY_LINE_LEFT_PX, SourcedMessage, sourcedSections } from "./SourcedMessage"
import { QUOTE_GEOMETRY, QUOTE_MARK_CENTER_PX } from "./tool-card"

const schedule: ChatSchedule = {
  id: "s1",
  name: "Deploy check",
  content: "check the deploy",
  target: { kind: "chat", chatId: "c" },
  trigger: { kind: "interval", everyMs: 5 * 60_000 },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: Date.now() + 4 * 60_000 - 1_000,
  runCount: 0,
}

describe("SourcedMessage", () => {
  test("a message a schedule sent quotes the schedule by name, as it stands now", () => {
    const html = renderToStaticMarkup(
      <ChatSchedulesProvider value={{ chatId: "c", schedules: [schedule], onEdit: () => {} }}>
        <SourcedMessage content="check the deploy" source={{ kind: "schedule", scheduleId: "s1" }} />
      </ChatSchedulesProvider>,
    )
    expect(html).toContain("Deploy check")
    expect(html).toContain("Automation · Every 5 min")
    expect(html).toContain("in 4m")
    // The quote does not repeat the message the bubble is showing.
    expect(html.split("check the deploy").length - 1).toBe(1)
  })

  test("a schedule that is gone is still an automation", () => {
    const html = renderToStaticMarkup(
      <ChatSchedulesProvider value={{ chatId: "c", schedules: [], onEdit: () => {} }}>
        <SourcedMessage content="check the deploy" source={{ kind: "schedule", scheduleId: "s1" }} />
      </ChatSchedulesProvider>,
    )
    expect(html).toContain(">Automation<")
    expect(html).not.toContain("Deploy check")
  })

  // The line between a quote and its bubble: 3px wide, 14 long, with 3 clear
  // at each end, and under the middle of the quote's mark.
  const LINE = '<span aria-hidden="true" class="my-[3px] h-[14px] w-[3px] rounded-full bg-border" style="margin-left:17.5px"></span>'
  const count = (html: string, text: string) => html.split(text).length - 1

  test("the quote sits over the bubble, outside it, with a line joining them", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />)
    const quote = html.indexOf(">Another agent<")
    const line = html.indexOf(LINE)
    const bubble = html.indexOf("rounded-2xl")
    // Quote, then the line, then the bubble, and the bubble holds the text and nothing else.
    expect(quote).toBeGreaterThan(-1)
    expect(quote).toBeLessThan(line)
    expect(line).toBeLessThan(bubble)
    expect(html.slice(bubble)).not.toContain("Another agent")
    expect(html.slice(bubble)).toContain("hello")
    expect(count(html, LINE)).toBe(1)
    // A straight line and nothing else: no drawn bend, and not something to read or press.
    expect(html).not.toContain("stroke-border")
  })

  test("the line's centre is the centre of the quote's mark, by the quote's own measurements", () => {
    // The mark's slot starts after the quote's border and padding.
    const markLeft = QUOTE_GEOMETRY.borderPx + QUOTE_GEOMETRY.paddingXPx
    expect(QUOTE_MARK_CENTER_PX).toBe(markLeft + QUOTE_GEOMETRY.markPx / 2)
    expect(REPLY_LINE_LEFT_PX + REPLY_LINE.widthPx / 2).toBe(QUOTE_MARK_CENTER_PX)
    // The numbers: a 16px slot whose centre is 19 in, and a 3px line from 17.5.
    expect(QUOTE_MARK_CENTER_PX).toBe(19)
    expect(REPLY_LINE_LEFT_PX).toBe(17.5)

    // And the line as drawn is the line as measured.
    const html = renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />)
    expect(html).toContain(`w-[${REPLY_LINE.widthPx}px]`)
    expect(html).toContain(`h-[${REPLY_LINE.heightPx}px]`)
    expect(html).toContain(`my-[${REPLY_LINE.clearPx}px]`)
    expect(html).toContain(`style="margin-left:${REPLY_LINE_LEFT_PX}px"`)
  })

  test("the quote starts at the bubble's edge and keeps its own width, as the bubble keeps its own", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />)
    // No inset, and no wider than 24rem.
    expect(html).toContain('<div class="flex min-w-0 max-w-full flex-col items-start"><div class="min-w-0 max-w-96">')
    expect(html).not.toContain("pl-10")
    // Neither stretches to the other: a long quote over a short message runs past it.
    expect(html).toContain("flex min-w-0 max-w-[85%] flex-col items-start")
    expect(html).not.toContain("flex-1 px-3.5")
    // The quote's own outline stays a hairline, and a fainter one than the line.
    expect(html).toContain("rounded-xl border border-border/50 bg-transparent")
  })

  test("the quote is an outline: a border, and the transcript showing through", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />)
    const quote = html.slice(html.indexOf("not-prose"), html.indexOf("rounded-2xl"))
    expect(quote).toContain("border border-border/50 bg-transparent")
    expect(quote).not.toContain("bg-card")
    // The bubble stays the one filled thing, with a typed prompt's padding.
    expect(html).toContain("bg-muted text-primary prose prose-sm prose-invert px-3.5 py-1.5")
  })

  test("an automation's quote takes the same place and the same look", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="check the deploy" source={{ kind: "schedule", scheduleId: "gone" }} />)
    expect(count(html, LINE)).toBe(1)
    expect(html.indexOf(">Automation<")).toBeLessThan(html.indexOf("rounded-2xl"))
    expect(html).toContain("bg-transparent")
  })

  test("a report on several sub-chats is a line for each, saying what happened, and nothing of what they said", () => {
    const html = renderToStaticMarkup(
      <SourcedMessage
        content={[
          "<system-message>\nSub-chat completed: [Joke](/chat/one) (chat id one)\n</system-message>\n\nFirst answer",
          "<system-message>\nSub-chat failed: [Deploy](/chat/two) (chat id two)\n</system-message>\n\n---\n\ncredentials expired",
          "<system-message>\nSub-chat needs_input: [Ask](/chat/three) (chat id three)\n</system-message>\n\n---\n\nwhich one?",
        ].join("\n\n")}
        source={{ kind: "report", chatIds: ["one", "two", "three"] }}
      />,
    )
    // Nothing here knows the chats' titles, so each is named for what it is.
    const order = [">A sub-chat replied<", ">A sub-chat failed<", ">A sub-chat needs input<"].map((text) => html.indexOf(text))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // No bubble, no quote, no line joining them, no reply.
    expect(html).not.toContain("rounded-2xl")
    expect(count(html, LINE)).toBe(0)
    expect(html).not.toContain(">Sub-chat<")
    for (const said of ["First answer", "credentials expired", "which one?", "Show more"]) expect(html).not.toContain(said)
    // A failed one takes a failed tool's mark.
    expect(count(html, "text-destructive")).toBe(1)
  })

  test("a report's line is a tool row's line: its slot, its mark and its words", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="all clear" source={{ kind: "report", chatIds: ["child"] }} />)
    expect(html).toContain("relative flex h-5 w-5 items-center justify-center")
    expect(html).toContain("size-4 text-muted-icon")
    expect(html).toContain("font-medium text-foreground/80")
    expect(html).toContain("text-sm")
    // A chat the sidebar does not know has nowhere to go, so it is no button.
    expect(html).not.toContain("<button")
  })

  // The line under a quote's title, where there is one.
  const CAPTION = "truncate pl-[26px] text-xs leading-4 text-muted-foreground"

  test("a quote with nothing to add is one line: the chat, and no words under it", () => {
    for (const html of [
      renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />),
    ]) {
      expect(html).not.toContain(CAPTION)
      expect(html).not.toContain("Replied to")
    }
  })

  test("what a quote is, is said to a reader who cannot see where it sits", () => {
    const html = renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />)
    // Ahead of the title, and out of the drawn row.
    expect(html).toContain('<span class="sr-only">Message from </span>')
    expect(html.indexOf("Message from")).toBeLessThan(html.indexOf(">Another agent<"))
  })

  test("only what a reader is shown becomes a bubble", () => {
    expect(sourcedSections("<system-message>for the agent</system-message>\n\nhello", { kind: "agent", chatId: "a" })).toEqual([{ chatId: null, body: "hello", status: null }])
    expect(sourcedSections("<system-message>for the agent</system-message>", { kind: "schedule", scheduleId: "s" })).toEqual([])
    // A report on one chat is about that chat even if its header is unreadable.
    expect(sourcedSections("words", { kind: "report", chatIds: ["abc"] })).toEqual([{ chatId: "abc", body: "words", status: null }])
    expect(sourcedSections("words", { kind: "report", chatIds: ["abc", "def"] })).toEqual([{ chatId: null, body: "words", status: null }])
  })
})

// The headers here are the orchestrator's own, as `buildReport` writes them.
describe("reports that are not a sub-chat's last word", () => {
  const interim = [
    "<system-message>",
    "Sub-chat waiting_on_subchats: [Coordinator](/chat/abc) (chat id abc)",
    'Not its last word. Its turn ended, and it is still waiting on chats under it: "Legwork". What follows is its reply so far. It reports again when its next turn ends.',
    "</system-message>",
    "",
    "Started the legwork.",
  ].join("\n")
  const final = "<system-message>\nSub-chat completed: [Coordinator](/chat/abc) (chat id abc)\n</system-message>\n\nAll done."
  const render = (content: string) => renderToStaticMarkup(<SourcedMessage content={content} source={{ kind: "report", chatIds: ["abc"] }} />)

  test("an interim reply's line says the sub-chat is still working, and the final one after it does not", () => {
    const first = render(interim)
    expect(first).toContain(">A sub-chat replied · still working<")
    // Nothing of the header, or of the reply, reaches the reader.
    expect(first).not.toContain("Started the legwork.")
    expect(first).not.toContain("Not its last word")
    expect(first).not.toContain("Legwork")
    expect(first).not.toContain("chat id")

    const last = render(final)
    expect(last).toContain(">A sub-chat replied<")
    expect(last).not.toContain("still working")
  })

  test("a report from a sub-chat that set itself a schedule draws as any other, with the schedule kept from the reader", () => {
    const html = render([
      "<system-message>",
      "Sub-chat completed: [Deploy](/chat/abc) (chat id abc)",
      'It set itself the schedule "Deploy check", which next runs at 2026-10-06T12:00:00.000Z. The turn each run starts is reported here too.',
      "</system-message>",
      "",
      "Deployed. Checking back in an hour.",
    ].join("\n"))
    expect(html).toContain(">A sub-chat replied<")
    expect(html).not.toContain("Deploy check")
    expect(html).not.toContain("It set itself")
  })
})

describe("a sub-chat adopted by another chat", () => {
  const notice = '<system-message>\nSub-chat adopted: [Audit](/chat/abc) (chat id abc) now reports to the chat "Coordinator" (/chat/xyz), which adopted it. Its result will not arrive here. read_chat and wait_for_chats still reach it.\n</system-message>'

  test("is a line saying so, not a bubble and not a reply", () => {
    const html = renderToStaticMarkup(<SourcedMessage content={notice} source={{ kind: "report", chatIds: ["abc"] }} />)
    // Nothing here knows the two chats, so the line names neither.
    expect(html).toContain("A sub-chat")
    expect(html).toContain(" was adopted by ")
    expect(html).toContain("another chat")
    expect(html).toContain("Its result will not arrive here.")
    expect(html).not.toContain("Message from")
    expect(html).not.toContain("rounded-2xl")
    // No one is quoted, so there is nothing for a line to join.
    expect(html).not.toContain("h-[14px] w-[3px]")
    // The agent's copy of the news stays the agent's.
    expect(html).not.toContain("read_chat")
    expect(html).not.toContain("chat id")
  })

  test("keeps its place among the results it arrived with", () => {
    const html = renderToStaticMarkup(
      <SourcedMessage
        content={[
          "<system-message>\nSub-chat completed: [Joke](/chat/one) (chat id one)\n</system-message>\n\nFirst answer",
          notice,
          "<system-message>\nSub-chat failed: [Deploy](/chat/two) (chat id two)\n</system-message>\n\n---\n\ncredentials expired",
        ].join("\n\n")}
        source={{ kind: "report", chatIds: ["one", "abc", "two"] }}
      />,
    )
    const order = [">A sub-chat replied<", " was adopted by ", ">A sub-chat failed<"].map((text) => html.indexOf(text))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Three lines, and no bubble.
    expect(html).not.toContain("rounded-2xl")
    expect(html).not.toContain("<hr")
  })
})
