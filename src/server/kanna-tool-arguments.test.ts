import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { z } from "zod"
import { VISUALIZATION_MAX_BYTES, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"
import { AttachmentItem, attachmentItemSchema, SEND_ATTACHMENTS_TOOL } from "./kanna-display-tools"
import { GENERATE_IMAGES_TOOL } from "./kanna-image-tools"
import { decodeToolArguments, validateToolValueSync } from "./kanna-tool-arguments"
import type { KannaTool } from "./kanna-tool-definition"
import { SHOW_VISUALIZATION_TOOL } from "./kanna-visualization-tool"

/**
 * The tools' argument schemas as zod, verbatim from before they moved to
 * Effect Schema. They are the reference: providers must get the same JSON
 * Schema, and an agent that sends bad arguments the same error text.
 */
const attachmentItem = z.strictObject({
  path: z.string().min(1).optional().describe("Local file path, absolute or relative to the project directory."),
  url: z.string().url().optional().describe("HTTP or HTTPS URL. Provide path or url, not both."),
  kind: z.enum(["image", "video", "file"]).optional().describe("For web URLs without a file extension, specify the media kind. Local files use their detected type."),
})
const ASPECT_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] as const
const reference: Record<string, z.ZodType> = {
  show_visualization: z.strictObject({
    title: z.string().min(1).max(200).describe("Accessible name for the visualization. No title bar is added."),
    html: z.string().min(1).max(VISUALIZATION_MAX_BYTES).optional().describe("Self-contained HTML fragment, including inline CSS and JavaScript. Supply html or path, not both."),
    path: z.string().min(1).optional().describe("HTML file, absolute or relative to the project. Copied into this chat; source edits will not change the saved visualization."),
    height: z.number().int().min(80).max(VISUALIZATION_MAX_HEIGHT).optional().describe("Initial height in CSS pixels, default 360. The frame then fits the content automatically."),
  }),
  send_attachments: z.strictObject({
    attachments: z.array(attachmentItem).min(1).max(24),
  }),
  generate_images: z.strictObject({
    images: z.array(z.strictObject({
      prompt: z.string().min(1).describe("What to draw. Describe the subject, composition, palette, and style. The image model cannot see the conversation."),
      path: z.string().min(1).describe("Where to save the image, absolute or relative to the project directory. Parent directories are created. The extension is corrected to match the returned bytes."),
      aspectRatio: z.enum(ASPECT_RATIOS).optional(),
      referenceImages: z.array(z.string().min(1)).max(14).optional()
        .describe("Images to work from. Each entry is a local path, the filename of a file the user attached to this chat, or an HTTP/HTTPS URL. A path may name an image that an earlier call saved."),
    })).min(1).max(12)
      .describe("One entry per image. All entries generate in parallel, so put a whole batch in one call. An entry cannot reference an image from the same call."),
  }),
}

const tools: KannaTool[] = [SHOW_VISUALIZATION_TOOL, SEND_ATTACHMENTS_TOOL, GENERATE_IMAGES_TOOL]

const inputs: Record<string, unknown[]> = {
  show_visualization: [
    { title: "x", html: "<p>a</p>" }, { title: "x", path: "a.html", height: 420, ticketId: "t", text: "", asksUser: false },
    {}, "nope", null, [], 7, { title: "" }, { title: 5 }, { title: "x".repeat(201) },
    { title: "x", height: 3.5 }, { title: "x", height: -1 }, { title: "x", height: 99999 }, { title: "x", height: 2.5 }, { title: "x", height: "9" },
    { title: "x", height: null }, { title: "x", height: 1e100 }, { title: "x", height: -1e100 },
    { title: "x", extra: 1 }, { title: "x", b: 1, a: 2 }, { title: "", html: "", extra: 1 },
    { title: "x", asksUser: "yes" }, { title: "x", ticketId: null }, { html: 1, path: 2, height: 1.5, asksUser: 0, zz: 1 },
    { title: "x", html: "y".repeat(VISUALIZATION_MAX_BYTES + 1) },
  ],
  send_attachments: [
    { attachments: [{ url: "https://example.com/a.png" }, { path: "a.txt", kind: "file" }] },
    { attachments: [] }, {}, { attachments: [{}] }, { attachments: [{ url: "nope" }] }, { attachments: [{ kind: "doc" }] },
    { attachments: [{ kind: 5 }] }, { attachments: [{ path: "" }] }, { attachments: [{ x: 1 }] },
    { attachments: Array.from({ length: 25 }, () => ({ url: "https://example.com/a" })) },
    { attachments: [{ url: "bad" }, ...Array.from({ length: 24 }, () => ({ path: "" }))] },
    { attachments: "x" }, { attachments: [1, "a"] }, { attachments: [{ url: 5 }], ticketId: 3 },
  ],
  generate_images: [
    { images: [{ prompt: "a", path: "b.png", aspectRatio: "16:9", referenceImages: ["r.png"] }] },
    { images: [] }, { images: [{}] }, { images: [{ prompt: "", path: "" }] }, { images: [{ prompt: "a", path: "b", aspectRatio: "7:7" }] },
    { images: [{ prompt: "a", path: "b", referenceImages: ["", ...Array.from({ length: 14 }, () => "r")] }] },
    { images: [{ prompt: "a", path: "b" }, ...Array.from({ length: 12 }, () => ({}))] },
    { images: [{ prompt: "a", path: "b", extra: true }] }, { images: [{ prompt: "a", path: "b", referenceImages: [1] }] },
  ],
}

/** A schema as it goes over the wire: JSON, which is all a provider sees. */
const wire = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema))

const decodeText = (tool: KannaTool, input: unknown) => {
  const exit = Effect.runSyncExit(tool.decode(input))
  if (Exit.isSuccess(exit)) return { value: exit.value }
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`decode died for ${JSON.stringify(input)}`)
  expect(reason.error._tag).toBe("@kanna/server/kanna-tool-arguments/KannaToolArgumentsError")
  return { error: reason.error.message }
}

describe("Kanna tool arguments", () => {
  for (const tool of tools) {
    test(`${tool.name} gives providers the JSON Schema zod gave`, () => {
      expect(wire(tool.inputSchema)).toStrictEqual(wire(z.toJSONSchema(reference[tool.name]!)))
    })

    test(`${tool.name} reports bad arguments in zod's words`, () => {
      for (const input of inputs[tool.name]!) {
        const expected = reference[tool.name]!.safeParse(input)
        const actual = decodeText(tool, input)
        if (expected.success) expect(actual).toEqual({ value: expected.data })
        else expect(actual).toEqual({ error: expected.error.message })
      }
    })
  }

  test("the attachment item the chat tools embed as zod is the same item", () => {
    const { $schema: _, ...item } = wire(z.toJSONSchema(attachmentItemSchema)) as Record<string, unknown>
    expect(wire(Schema.toJsonSchemaDocument(AttachmentItem, { onExcessProperty: "error" }).schema)).toStrictEqual(item)
    expect(wire(z.toJSONSchema(attachmentItemSchema))).toStrictEqual(wire(z.toJSONSchema(attachmentItem)))
  })

  test("zod handed a URL back trimmed; the decoded URL is untrimmed but parses the same", () => {
    const decoded = decodeText(SEND_ATTACHMENTS_TOOL, { attachments: [{ url: " https://example.com/a.png " }] }) as { value: { attachments: Array<{ url: string }> } }
    expect(new URL(decoded.value.attachments[0]!.url).href).toBe("https://example.com/a.png")
  })

  test("a non-strict schema drops unknown keys, as z.object did", () => {
    const Answer = Schema.Struct({ answers: Schema.Struct({ value: Schema.Array(Schema.String).check(Schema.isMinLength(1)) }) })
    const zodAnswer = z.object({ answers: z.object({ value: z.array(z.string()).min(1) }) })
    const validate = validateToolValueSync(Answer, { strict: false })
    expect(validate({ answers: { value: ["a"], other: 1 }, discarded: false })).toEqual({ answers: { value: ["a"] } })
    for (const input of [{ answers: { value: [] } }, { answers: {} }, null, { answers: { value: [1] } }]) {
      expect(() => validate(input)).toThrow(zodAnswer.safeParse(input).error!.message)
    }
    const strict = Effect.runSyncExit(decodeToolArguments("t", Answer)({ answers: { value: ["a"] }, extra: 1 }))
    expect(Exit.isFailure(strict)).toBe(true)
  })
})
