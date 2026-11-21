/**
 * The one way Kanna turns a message into a one-line preview.
 *
 * Hover cards show messages at two or three clamped lines, and the raw text is
 * written for a renderer that isn't there: a prompt that opens with a heading
 * spends its first line on `##`, a reply full of `**bold**` reads as asterisk
 * soup, and a fenced block contributes a line of backticks. What the reader
 * wants from a preview is the sentence, so this returns the sentence.
 *
 * Two jobs, in this order — unwrap the markup, then flatten the lines. They are
 * one function because doing either alone gives a wrong answer: flattening
 * first glues list markers into the middle of the text where the line-start
 * rules can no longer see them.
 *
 * Deliberately *not* a markdown parser. It is a lossy pass over the constructs
 * that actually show up at the head of a message, tuned to never mangle prose:
 * where a rule would risk eating real text — `snake_case` names, a bare `*`,
 * an XML-ish tag an agent wrote on purpose — it leaves the text alone. Being a
 * little under-stripped is invisible; eating a word is not.
 */

/** Fence lines (``` or ~~~), dropped so their contents read as ordinary text. */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,}).*$/gm

/** `code` → code. Handles doubled backticks around text containing one. */
const INLINE_CODE = /`+([^`]+)`+/g

/** `![alt](src)` → alt, before links, so the leading `!` doesn't survive. */
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g

/** `[text](href)` → text, and `[text][ref]` → text. */
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g

/** `<https://example.com>` → https://example.com. Only ever a bare URL. */
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g

/** `## Heading` → Heading. */
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm

/** `> quoted` → quoted, including nested `>>`. */
const BLOCKQUOTE = /^[ \t]{0,3}(?:>[ \t]?)+/gm

/** `---`, `***`, `___` on their own line — structure with no text in it. */
const THEMATIC_BREAK = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm

/** `- `, `* `, `1. `, `2) ` at the head of a line. */
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm

/** The `[ ]` / `[x]` a task list leaves behind once its marker is gone. */
const TASK_BOX = /^\[[ xX]\][ \t]*/gm

/** `~~struck~~` → struck. */
const STRIKETHROUGH = /~~([^~]+)~~/g

/**
 * `**bold**` / `*italic*` → the text inside.
 *
 * Requires a non-space just inside each delimiter so a lone `*` used as a
 * bullet or a multiplication sign is left alone.
 */
const ASTERISK_EMPHASIS = /(\*{1,3})(?=\S)([\s\S]*?\S)\1/g

/**
 * `_italic_` → italic. Single underscores only, at a word boundary, and never
 * wrapping text that itself starts or ends with one.
 *
 * This is the rule that has to be careful, and the one place the pass
 * deliberately does less than a renderer would. `retry_count_ms` is handled by
 * the word boundary — CommonMark agrees that intraword underscores don't
 * emphasise. `__init__` is not: it is character-for-character a bold span, and
 * no rule can tell a dunder from `__bold__`. So doubles are left alone
 * entirely. In a tool whose messages are full of code, rendering `__really__`
 * with its underscores showing is a cosmetic blemish; turning `__init__` into
 * `init` quietly changes what the message says. `**bold**` is the form that
 * actually shows up anyway, and it's handled above.
 */
const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu

/** A `<system-message>` block and the blank space after it. */
const SYSTEM_MESSAGE_BLOCK = /<system-message>[\s\S]*?<\/system-message>\s*/g

/**
 * Text one agent wrote for another (a message, a schedule, a report, a chat's
 * title), with any `<system-message>` tag in it spelled out.
 *
 * The tag is Kanna's own voice to an agent, and `stripSystemMessages` takes
 * those blocks out of what a person is shown. Left as written, an agent could
 * wrap instructions in one: the chat that received them read them as Kanna's,
 * and the user looking at the message saw none of it. Spelled out, the text
 * is shown as it is, and to the agent it is only text.
 */
export function defuseSystemMessages(text: string): string {
  return /<\/?system-message>/i.test(text) ? text.replace(/<(\/?)(system-message)>/gi, "&lt;$1$2&gt;") : text
}

/**
 * Take the `<system-message>` blocks out of a message, leaving what a person
 * should read.
 *
 * Those blocks are how Kanna says something to an agent inside a message: who
 * a sub-chat's report is about, with its chat id. The agent needs them and
 * the user does not, so they are stored with the message and left out
 * wherever it is shown: the bubble, the queue, and every preview.
 */
export function stripSystemMessages(text: string): string {
  return text.includes("<system-message>") ? text.replace(SYSTEM_MESSAGE_BLOCK, "").trim() : text
}

/** Every run of whitespace, newlines included, becomes one space. */
const WHITESPACE_RUN = /\s+/g

/**
 * Strip markdown from a message and flatten it to a single line.
 *
 * Safe on text that contains no markdown at all, which is most prompts — it
 * comes back with its whitespace collapsed and nothing else changed.
 */
export function toMessagePreview(text: string): string {
  return stripSystemMessages(text)
    .replace(FENCE_LINE, "\n")
    .replace(INLINE_CODE, "$1")
    .replace(IMAGE, "$1")
    .replace(INLINE_LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(AUTOLINK, "$1")
    .replace(THEMATIC_BREAK, "")
    .replace(HEADING, "")
    .replace(BLOCKQUOTE, "")
    .replace(LIST_MARKER, "")
    .replace(TASK_BOX, "")
    .replace(STRIKETHROUGH, "$1")
    .replace(ASTERISK_EMPHASIS, "$2")
    .replace(UNDERSCORE_EMPHASIS, "$1")
    .replace(WHITESPACE_RUN, " ")
    .trim()
}
