import { createContext, useContext, type ReactNode } from "react"
import type { StandaloneTranscriptAttachmentMode } from "../../../shared/types"

export interface TranscriptRenderOptions {
  readonly: boolean
  localLinkMode: "open" | "text"
  attachmentMode: "live" | StandaloneTranscriptAttachmentMode
  projectId: string | null
}

const DEFAULT_RENDER_OPTIONS: TranscriptRenderOptions = {
  readonly: false,
  localLinkMode: "open",
  attachmentMode: "live",
  projectId: null,
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
