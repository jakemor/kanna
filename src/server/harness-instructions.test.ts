import { describe, expect, test } from "bun:test"
import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAgentTrailer } from "./attribution"
import { buildKannaSystemInstructions, buildKannaSystemMessage, KANNA_DELEGATOR_INSTRUCTIONS, KANNA_ORCHESTRATION_INSTRUCTIONS, KANNA_VISUALIZATION_INSTRUCTIONS } from "./harness-instructions"
import { KANNA_TOOL_DESCRIPTION_LIMIT, KANNA_TOOL_NAMES, kannaToolSpecs } from "./kanna-tools"
import { SHOW_VISUALIZATION_TOOL } from "./kanna-visualization-tool"
import { KANNA_VISUALIZATION_CONTRACT, KANNA_VISUALIZATION_SKILL_INSTRUCTIONS } from "./visualization-instructions"
import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"

const AGENT_ID = "claude/claude-opus-5"

describe("buildKannaSystemInstructions", () => {
  test("carries the attribution and the chat-link rules", () => {
    const instructions = buildKannaSystemInstructions(AGENT_ID)
    expect(instructions).toContain(buildKannaAgentTrailer(AGENT_ID))
    expect(instructions).toContain(KANNA_CHAT_LINK_INSTRUCTIONS)
  })

  test("explains the chat tools only to a harness that has them", () => {
    expect(buildKannaSystemInstructions(AGENT_ID)).toContain(KANNA_ORCHESTRATION_INSTRUCTIONS)
    expect(buildKannaSystemInstructions(AGENT_ID, { tools: false })).not.toContain("create_chat")
    expect(buildKannaSystemMessage(AGENT_ID, { tools: false })).not.toContain("create_chat")
  })

  test("tells a delegator to hand work on, and no other chat", () => {
    for (const build of [buildKannaSystemInstructions, buildKannaSystemMessage]) {
      expect(build(AGENT_ID, { delegator: true })).toContain(KANNA_DELEGATOR_INSTRUCTIONS)
      // Every chat with the tools is told of the `delegator` choice on
      // create_chat, but only a delegator is told it is one.
      expect(build(AGENT_ID)).not.toContain("# This chat is a delegator")
      expect(build(AGENT_ID, { delegator: false })).not.toContain("# This chat is a delegator")
      // It hands work on with the chat tools, so a harness without them is not told to.
      expect(build(AGENT_ID, { delegator: true, tools: false })).not.toContain("delegator")
    }
    // Once, after the tools it is written in terms of.
    const told = buildKannaSystemInstructions(AGENT_ID, { delegator: true })
    expect(told.split(KANNA_DELEGATOR_INSTRUCTIONS)).toHaveLength(2)
    expect(told.indexOf(KANNA_DELEGATOR_INSTRUCTIONS)).toBeGreaterThan(told.indexOf(KANNA_ORCHESTRATION_INSTRUCTIONS))
    expect(buildKannaSystemInstructions(AGENT_ID, { delegator: true }).length - buildKannaSystemInstructions(AGENT_ID).length)
      .toBe(KANNA_DELEGATOR_INSTRUCTIONS.length + 2)
  })

  test("every chat with the tools is told one chat is one piece of work, and to fork for new work", () => {
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).toContain("Each chat is one piece of work, and its title (required on `create_chat`, `fork_chat` and `send_message`) says what.")
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).toContain("prefer a fork to retitling a chat")
    // The tool requires the choice, so the instructions say what each side means.
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).toContain("`create_chat` needs a choice of `delegator: false` for a chat that does the work itself")
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).toContain("`delegator: true` for one that coordinates sub-chats of its own")
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).toContain("So does `set_schedule` with `newChat`.")
    expect(KANNA_ORCHESTRATION_INSTRUCTIONS).not.toMatch(/ticket|checkpoint/i)
  })

  test("a delegator keeps each chat one timeline of one piece of work, and reuses a chat by forking it", () => {
    const told = KANNA_DELEGATOR_INSTRUCTIONS
    expect(told).toContain("Each chat under this one is a self-contained timeline of one piece of work, and its title says what that work is.")
    expect(told).toContain("The chat list is the user's record of what was worked on")
    expect(told).toContain("New work goes to a new chat: `create_chat`, titled for that work, with `delegator: false` unless it should run chats of its own.")
    expect(told).toContain("To reuse a chat's context for new work, fork it: `fork_chat`, titled for the new work.")
    expect(told).toContain("Never point an existing chat at different work.")
    expect(told).toContain("Follow-ups on a chat's own work go to it with `send_message`, passing its current title")
    expect(told).toContain("If you find yourself retitling a chat because its work changed, fork it instead.")
    expect(told).not.toMatch(/ticket|checkpoint/i)
    // Every delegator turn pays for it.
    expect(told.length).toBeLessThan(2_200)
  })

  test("what a delegator is told covers the rest, with tools that exist", () => {
    const told = KANNA_DELEGATOR_INSTRUCTIONS
    expect(told).toContain("almost always hand it to another chat")
    expect(told).toContain("has this chat as its parent")
    expect(told).toContain("`adopt: true` on `send_message`")
    expect(told).toContain("Several unrelated tasks in one message go to several chats.")
    expect(told).toContain("Tell the user which chat each task went to, and link it.")
    expect(told).toContain("Do not redo")
    expect(told).toContain("Almost always give each automation its own chat: a sub-chat from `create_chat`")
    expect(told).toContain("with `set_schedule`'s `chatId` pointed at it")
    expect(told).toContain("Schedule into this chat only if the user asks")
    const named = [...told.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!)
    expect(named).toEqual(expect.arrayContaining(["create_chat", "fork_chat", "send_message", "list_chats", "get_context"]))
    for (const name of named) expect(KANNA_TOOL_NAMES as readonly string[]).toContain(name)
  })

  test("names only tools that exist", () => {
    const named = [...KANNA_ORCHESTRATION_INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) {
      if (name === "kanna" || name.startsWith("mcp__")) continue
      expect(KANNA_TOOL_NAMES).toContain(name)
    }
  })
})

describe("buildKannaSystemMessage", () => {
  test("wraps the instructions for the no-append-hook providers", () => {
    const message = buildKannaSystemMessage(AGENT_ID)
    expect(message.startsWith("<system-message>")).toBe(true)
    expect(message.endsWith("</system-message>")).toBe(true)
    expect(message).toContain(buildKannaSystemInstructions(AGENT_ID))
  })
})


test("visualization instructions reach tool-enabled harnesses and prefer native inline results", () => {
  const instructions = buildKannaSystemInstructions(AGENT_ID)
  expect(instructions).toContain(KANNA_VISUALIZATION_INSTRUCTIONS)
  expect(instructions).toContain("# Kanna visualizations")
  expect(instructions).toContain(KANNA_VISUALIZATION_SKILL_INSTRUCTIONS)
  expect(instructions).toContain(KANNA_VISUALIZATION_CONTRACT)
  expect(instructions).toContain("show_chart tool is retired")
  expect(buildKannaSystemMessage(AGENT_ID)).toContain(KANNA_VISUALIZATION_INSTRUCTIONS)
  expect(buildKannaSystemInstructions(AGENT_ID, { tools: false })).not.toContain("show_visualization")
})

test("the tool is reached for by situation, for a diagram and a prototype as much as a chart", () => {
  const instructions = buildKannaSystemInstructions(AGENT_ID)
  const description = SHOW_VISUALIZATION_TOOL.description
  // Both say when, and what it takes the place of, before any rule for drawing.
  for (const text of [instructions, description]) {
    expect(text).toContain("how something works")
    expect(text).toContain("could look like")
    expect(text).toMatch(/ASCII art/)
    expect(text).toMatch(/Mermaid/)
    expect(text).toMatch(/a diagram/)
    expect(text).toMatch(/a prototype/)
    expect(text).toMatch(/a chart or (a )?table/)
  }
  expect(instructions).toContain("Not a PNG or screenshot sent with send_attachments")
  expect(description.startsWith("Show something inline in the conversation")).toBe(true)
  expect(description.indexOf("a diagram")).toBeLessThan(description.indexOf("- Inline all CSS"))
  expect(description).toContain('under "Kanna visualizations"')
  expect(description).not.toContain(KANNA_VISUALIZATION_SKILL_INSTRUCTIONS)

  // The contract is by kind, so a prototype is not held to a chart's rules.
  const section = (heading: string) => {
    const from = KANNA_VISUALIZATION_CONTRACT.indexOf(`## ${heading}`)
    const next = KANNA_VISUALIZATION_CONTRACT.indexOf("\n## ", from + 1)
    expect(from).toBeGreaterThanOrEqual(0)
    return KANNA_VISUALIZATION_CONTRACT.slice(from, next === -1 ? undefined : next)
  }
  const every = section("Every kind"), charts = section("Charts and tables"), diagrams = section("Diagrams"), prototypes = section("Prototypes")
  for (const chartRule of ["One chart per visualization", "kanna-tooltip", "Axis ticks", "window.kanna.download", "Do not build a dashboard because the data allows one", "small multiples", "Never a readout in a fixed line of text", "keyboard focus on the marks"]) {
    expect(charts).toContain(chartRule)
    expect(every).not.toContain(chartRule)
    expect(prototypes).not.toContain(chartRule)
  }
  // A header is a chart's and a diagram's. A prototype has none: the stage is the design.
  expect(charts).toContain('an h3 title that names what is shown and a p class="text-muted" subtitle')
  expect(diagrams).toContain("an h3 title")
  expect(prototypes).toContain("No title or subtitle")
  expect(prototypes).not.toContain("<h3>")
  expect(description).toContain("A prototype has no heading")
  // Diagrams have guidance of their own.
  for (const rule of ["inline SVG", "no library", "320px", "arrowheads", "--border", `${VISUALIZATION_MAX_HEIGHT}px`, "visible at rest"]) expect(diagrams).toContain(rule)
  // And a prototype says when to step through directions and when to lay them side by side.
  expect(prototypes).toContain("kanna-segmented picker")
  // The version picker is centred, and the example a model copies does it.
  expect(prototypes).toContain("centred in that row and not pushed to one side")
  expect(prototypes).toContain('<div class="kanna-picker"><div class="kanna-segmented" role="radiogroup"')
  expect(prototypes).toContain("(kanna-tabs) go in the same wrapper, centred too")
  expect(description).toContain("version picker is centred")
  // A chart's settings are not: they sit under a left-aligned header.
  expect(charts).not.toContain("kanna-picker")
  expect(every).not.toContain("kanna-picker")
  expect(prototypes).toContain("side by side")
  expect(prototypes).toContain("wait for that choice")
  expect(prototypes).toContain('<section id="stage" style="height:40px">')
})

test("what holds for every kind is in the description and the session instructions alike", () => {
  const instructions = buildKannaSystemInstructions(AGENT_ID)
  const description = SHOW_VISUALIZATION_TOOL.description
  // The corner the prompt keeps clear is the expand button's own, with a margin.
  const { size, inset, clear } = VISUALIZATION_EXPAND_BUTTON
  expect(clear).toBeGreaterThan(size + inset)
  for (const text of [instructions, description]) {
    expect(text).toContain(`Keep the top-right ${clear}px by ${clear}px clear`)
    expect(text).toContain("kanna-segmented")
    expect(text).toContain("kanna-tabs")
    expect(text).toContain("16px")
    expect(text).toContain(`up to ${VISUALIZATION_MAX_HEIGHT}px`)
    expect(text).toContain("iOS")
    expect(text).toContain("One subject per visualization")
    // Stated in both, strictly: nothing a reader does may move the conversation.
    expect(text).toContain("must never change after")
    expect(text).toContain("tallest state")
  }
  // The rest is only in the session instructions, which no harness cuts short.
  expect(instructions).toContain(`${size}px expand button`)
  expect(instructions).toContain("No interaction may grow or shrink it")
  expect(instructions).toContain("kanna:themechange")
  expect(instructions).toContain("touch-action: none")
  expect(instructions).not.toContain("<select aria-label")
  // Two to four options are a segmented control, five to eight a tabs row,
  // more a dropdown, and both say so.
  for (const text of [instructions, description]) {
    expect(text).toMatch(/2 to 4 short options|Two to four short options/)
    expect(text).toMatch(/for 5 to 8 or for whole views|Five to eight short options, or views to switch between, are a kanna-tabs row/)
    expect(text).toContain("kanna-select")
  }
  // The host centres the selection; the model writes no script for the row.
  expect(instructions).toContain("scrolls the selected tab to the centre")
  expect(instructions).toContain("so write no script or CSS of your own for them")
  expect(instructions).toContain("More than eight, or labels longer than about twenty characters, are a kanna-select dropdown")
  expect(instructions).toContain('<select class="kanna-select" aria-label="State">')
  expect(instructions).not.toContain("more than about six options")
  // Its examples hold three, as a model copying one should.
  const examples = [...KANNA_VISUALIZATION_CONTRACT.matchAll(/<div class="kanna-segmented"[^>]*>(.*?)<\/div>/g)]
  expect(examples.length).toBeGreaterThanOrEqual(2)
  for (const [, options] of examples) expect(options!.match(/<button/g)!.length).toBe(3)
})

// Claude Code cuts an MCP tool's description at this length and ends it
// "[truncated]". An 8,000-character description reached Claude as its first
// quarter, and an agent went and read the rest out of the installed bundle.
test("no tool's description is longer than the shortest a harness keeps", () => {
  expect(KANNA_TOOL_DESCRIPTION_LIMIT).toBe(2048)
  for (const tool of kannaToolSpecs()) {
    expect(`${tool.name}: ${tool.description.length}`).toBe(`${tool.name}: ${Math.min(tool.description.length, KANNA_TOOL_DESCRIPTION_LIMIT)}`)
  }
})
