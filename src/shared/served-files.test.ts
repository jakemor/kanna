import { describe, expect, test } from "bun:test"
import { servedFileHeaders, servedFileMode } from "./served-files"

describe("servedFileMode", () => {
  test("images, video, audio and PDF are shown as they are", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "video/mp4", "video/quicktime", "audio/mpeg", "audio/x-m4a", "application/pdf", "IMAGE/PNG", "video/mp4; codecs=avc1"]) {
      expect(servedFileMode(type)).toBe("inline")
    }
  })

  test("text and JSON are shown in a sandbox", () => {
    for (const type of ["text/plain; charset=utf-8", "text/plain", "text/markdown; charset=utf-8", "text/csv", "text/tab-separated-values", "text/css", "text/javascript;charset=utf-8", "application/json; charset=utf-8", "application/ld+json"]) {
      expect(servedFileMode(type)).toBe("sandboxed")
    }
  })

  test("anything that can carry script, or is unknown, is a download", () => {
    for (const type of ["image/svg+xml", "text/html", "text/html;charset=utf-8", "application/xhtml+xml", "application/xml", "text/xml", "application/xslt+xml", "text/xsl", "application/rss+xml", "application/atom+xml", "application/octet-stream", "application/zip", "application/javascript", "image/heic", "", null, undefined]) {
      expect(servedFileMode(type)).toBe("download")
    }
  })
})

describe("servedFileHeaders", () => {
  test("nosniff on everything", () => {
    for (const type of ["image/png", "text/plain", "image/svg+xml"]) {
      expect(servedFileHeaders(type)["X-Content-Type-Options"]).toBe("nosniff")
    }
  })

  test("an image carries no sandbox or disposition, so a tab shows it", () => {
    const headers = servedFileHeaders("image/png")
    expect(headers["Content-Security-Policy"]).toBeUndefined()
    expect(headers["Content-Disposition"]).toBeUndefined()
  })

  test("a PDF carries no sandbox: Chrome's viewer will not load in one", () => {
    expect(servedFileHeaders("application/pdf")["Content-Security-Policy"]).toBeUndefined()
  })

  test("text is sandboxed but still shown", () => {
    const headers = servedFileHeaders("text/plain; charset=utf-8")
    expect(headers["Content-Security-Policy"]).toStartWith("sandbox;")
    expect(headers["Content-Disposition"]).toBeUndefined()
  })

  test("SVG and HTML are sandboxed downloads", () => {
    for (const type of ["image/svg+xml", "text/html;charset=utf-8"]) {
      const headers = servedFileHeaders(type)
      expect(headers["Content-Type"]).toBe(type)
      expect(headers["Content-Security-Policy"]).toStartWith("sandbox;")
      expect(headers["Content-Disposition"]).toBe("attachment")
    }
  })
})
