import { describe, expect, test } from "bun:test"
import { attachmentOpenAction, opensInBrowser, pdfPreviewUrl, servedInline } from "./attachmentOpenAction"

const upload = (name: string, mimeType: string, size: number | null = 1_000) => ({ url: `/api/projects/p1/uploads/${encodeURIComponent(name)}/content`, name, mimeType, size })
const sent = (name: string, mimeType: string) => ({ url: `/api/chats/c1/media/${encodeURIComponent(name)}`, name, mimeType, size: 1_000 })
const remote = (name: string, mimeType: string) => ({ url: `https://example.com/${name}`, name, mimeType, size: null })

describe("opensInBrowser", () => {
  test("an upload the browser shows opens in a tab", () => {
    expect(opensInBrowser(upload("report.pdf", "application/pdf"))).toBe(true)
    expect(opensInBrowser(upload("logo.svg", "image/svg+xml"))).toBe(true)
    expect(opensInBrowser(upload("clip.mp4", "video/mp4"))).toBe(true)
    expect(opensInBrowser(upload("song.mp3", "audio/mpeg"))).toBe(true)
    expect(opensInBrowser(upload("notes.txt", "text/plain; charset=utf-8"))).toBe(true)
    expect(opensInBrowser(upload("data.json", "application/json"))).toBe(true)
  })

  test("an upload the browser saves downloads", () => {
    expect(opensInBrowser(upload("design-eng-review.zip", "application/zip"))).toBe(false)
    expect(opensInBrowser(upload("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe(false)
    expect(opensInBrowser(upload("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe(false)
    expect(opensInBrowser(upload("tool", "application/octet-stream"))).toBe(false)
    expect(opensInBrowser(upload("photo.heic", "image/heic"))).toBe(false)
  })

  test("goes by the name the server types an upload by", () => {
    // Served as text/plain, whatever was sniffed: shows.
    expect(opensInBrowser(upload("page.html", "application/octet-stream"))).toBe(true)
    expect(opensInBrowser(upload("main.py", "text/x-python"))).toBe(true)
    // Served as text/csv, which Chrome saves.
    expect(opensInBrowser(upload("rows.csv", "text/plain"))).toBe(false)
    expect(opensInBrowser(upload("rows.tsv", "text/tab-separated-values"))).toBe(false)
  })

  test("a file an agent sent downloads unless it's one of the types the server shows", () => {
    expect(opensInBrowser(sent("shot.png", "image/png"))).toBe(true)
    expect(opensInBrowser(sent("clip.webm", "video/webm"))).toBe(true)
    expect(opensInBrowser(sent("report.pdf", "application/pdf"))).toBe(true)
    expect(opensInBrowser(sent("logo.svg", "image/svg+xml"))).toBe(false)
    expect(opensInBrowser(sent("notes.txt", "text/plain"))).toBe(false)
    expect(opensInBrowser(sent("bundle.zip", "application/zip"))).toBe(false)
  })

  test("another site's file is judged by its type", () => {
    expect(opensInBrowser(remote("a.pdf", "application/pdf"))).toBe(true)
    expect(opensInBrowser(remote("a.zip", "application/zip"))).toBe(false)
  })
})

describe("attachmentOpenAction", () => {
  test("the viewer for what it can show", () => {
    expect(attachmentOpenAction(upload("shot.png", "image/png"))).toBe("preview")
    expect(attachmentOpenAction(sent("logo.svg", "image/svg+xml"))).toBe("preview")
    expect(attachmentOpenAction(sent("clip.mov", "video/quicktime"))).toBe("preview")
    expect(attachmentOpenAction(upload("report.pdf", "application/pdf"))).toBe("preview")
    expect(attachmentOpenAction(sent("demo-report.pdf", "application/pdf"))).toBe("preview")
    expect(attachmentOpenAction(upload("README.md", "text/markdown"))).toBe("preview")
    expect(attachmentOpenAction(sent("notes.txt", "text/plain"))).toBe("preview")
    expect(attachmentOpenAction(upload("data.json", "application/json"))).toBe("preview")
    expect(attachmentOpenAction(upload("rows.csv", "text/csv"))).toBe("preview")
    expect(attachmentOpenAction(upload("main.ts", "application/octet-stream"))).toBe("preview")
  })

  test("a new tab for what only the browser shows", () => {
    expect(attachmentOpenAction(upload("song.mp3", "audio/mpeg"))).toBe("tab")
    expect(attachmentOpenAction(upload("big.json", "application/json", 10_000_000))).toBe("tab")
    expect(attachmentOpenAction(remote("paper.pdf", "application/pdf"))).toBe("tab")
    expect(attachmentOpenAction(remote("notes.txt", "text/plain"))).toBe("tab")
  })

  // The server lists a zip it stores (src/server/zip-preview.ts); another site's has no listing.
  test("the viewer for a zip this server has", () => {
    expect(attachmentOpenAction(sent("demo-project.zip", "application/zip"))).toBe("preview")
    expect(attachmentOpenAction(upload("design-eng-review.zip", "application/x-zip-compressed"))).toBe("preview")
    expect(attachmentOpenAction(upload("bundle.zip", "application/octet-stream"))).toBe("preview")
    expect(attachmentOpenAction(remote("a.zip", "application/zip"))).toBe("download")
    expect(attachmentOpenAction({ url: "blob:http://localhost/1", name: "a.zip", mimeType: "application/zip", size: 1 })).toBe("download")
  })

  test("a download for the rest", () => {
    expect(attachmentOpenAction(sent("demo-project.tar.gz", "application/gzip"))).toBe("download")
    expect(attachmentOpenAction(upload("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("download")
    expect(attachmentOpenAction(upload("photo.heic", "image/heic"))).toBe("download")
    expect(attachmentOpenAction(upload("movie.mkv", "video/x-matroska"))).toBe("download")
    expect(attachmentOpenAction(sent("song.mp3", "audio/mpeg"))).toBe("download")
    expect(attachmentOpenAction(upload("tool", "application/octet-stream"))).toBe("download")
  })
})

describe("servedInline", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries)

  // The PDF frame mounts only on this answer: an iframe on a download URL saves the file each time it mounts.
  test("a PDF served as an attachment is not inline", () => {
    expect(servedInline(headers({ "content-type": "application/pdf", "content-disposition": "attachment" }), "application/pdf")).toBe(false)
    expect(servedInline(headers({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="a.pdf"' }), "application/pdf")).toBe(false)
  })

  test("a PDF with no disposition, or an inline one, is", () => {
    expect(servedInline(headers({ "content-type": "application/pdf" }), "application/pdf")).toBe(true)
    expect(servedInline(headers({ "content-type": "application/pdf; charset=binary", "content-disposition": "inline" }), "application/pdf")).toBe(true)
  })

  test("another type is not, whatever its disposition", () => {
    expect(servedInline(headers({ "content-type": "application/octet-stream" }), "application/pdf")).toBe(false)
  })
})

describe("pdfPreviewUrl", () => {
  // An agent's PDF fetched before the media route served PDFs inline is cached as a download under its plain address for a year.
  test("an agent's PDF is shown from an address no old cached download holds", () => {
    expect(pdfPreviewUrl("/api/chats/c1/media/a.pdf")).toBe("/api/chats/c1/media/a.pdf?inline=1")
  })

  test("an upload, which was never served as a download, keeps its address", () => {
    expect(pdfPreviewUrl("/api/projects/p1/uploads/a.pdf/content")).toBe("/api/projects/p1/uploads/a.pdf/content")
  })
})
