import { createContext, useContext, type ReactNode } from "react"
import type { StandaloneTranscriptAttachmentMode } from "../../../shared/types"

export interface TranscriptRenderOptions {
  readonly: boolean
  localLinkMode: "open" | "text"
  sourceOrigin: string | null
  attachmentMode: "live" | StandaloneTranscriptAttachmentMode
  /**
   * Fetch an entry's raw provider payload on demand, or null when the host has
   * it inline.
   *
   * Live snapshots strip `debugRaw` (it duplicates `content` and dominated the
   * payload), so the raw JSON view pulls it through this when opened. Export
   * bundles still carry it inline and leave this null.
   */
  loadEntryDebugRaw: ((entryId: string) => Promise<string | null>) | null
}

const DEFAULT_RENDER_OPTIONS: TranscriptRenderOptions = {
  readonly: false,
  localLinkMode: "open",
  sourceOrigin: null,
  attachmentMode: "live",
  loadEntryDebugRaw: null,
}

const TranscriptRenderOptionsContext = createContext<TranscriptRenderOptions>(DEFAULT_RENDER_OPTIONS)

export function TranscriptRenderOptionsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: Partial<TranscriptRenderOptions>
}) {
  return (
    <TranscriptRenderOptionsContext.Provider
      value={{
        ...DEFAULT_RENDER_OPTIONS,
        ...value,
      }}
    >
      {children}
    </TranscriptRenderOptionsContext.Provider>
  )
}

export function useTranscriptRenderOptions() {
  return useContext(TranscriptRenderOptionsContext)
}
