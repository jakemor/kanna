/**
 * How the server hands out a file from a project or its uploads, by the
 * Content-Type it is served with.
 *
 * Those files are a stranger's as often as the user's: a cloned repo's, an
 * agent's, an attachment someone sent. Opened as a page of its own, an SVG
 * or HTML file would run its script on the app's origin, and that origin can
 * open the socket that runs shell commands. So only types with nothing to
 * run are shown as they are. `<img>`, `<video>` and `fetch` read every mode
 * alike: the headers below only change what a tab or a frame does.
 *
 * The client asks the same question to decide whether "Open in new tab" has
 * anything to show (`opensInBrowser`).
 */
export type ServedFileMode =
  /** Shown as it is: an image that is not SVG, video, audio, a PDF. */
  | "inline"
  /** Text and JSON: shown, in a sandbox that could run nothing if it tried. */
  | "sandboxed"
  /** Everything else, SVG and HTML among it: saved, never shown. */
  | "download"

const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/
// XML is markup a browser renders, XHTML script included, whatever it is called.
const MARKUP = /html|xml|xsl/
const TEXT = /^(text\/[\w.+-]+|application\/([\w.-]+\+)?json)$/

export function servedFileMode(contentType: string | null | undefined): ServedFileMode {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase()
  if (INLINE.test(type)) return "inline"
  if (TEXT.test(type) && !MARKUP.test(type)) return "sandboxed"
  return "download"
}

/** `style-src` for the browser's own plain-text and JSON views. */
const SANDBOX_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

export function servedFileHeaders(contentType: string): Record<string, string> {
  const mode = servedFileMode(contentType)
  return {
    "Content-Type": contentType,
    // Without it a browser may decide a text file is HTML after all.
    "X-Content-Type-Options": "nosniff",
    // A PDF gets no sandbox: Chrome's viewer will not load in one, and a
    // PDF's script runs in the viewer, not in this origin.
    ...(mode === "inline" ? {} : { "Content-Security-Policy": SANDBOX_POLICY }),
    ...(mode === "download" ? { "Content-Disposition": "attachment" } : {}),
  }
}
