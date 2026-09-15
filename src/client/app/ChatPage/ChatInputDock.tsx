import { memo, type RefObject } from "react"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { KannaState } from "../useKannaState"
import type { AgentProvider, ChatSkillsSnapshot } from "../../../shared/types"

interface ChatInputDockProps {
  inputRef: RefObject<HTMLDivElement | null>
  onLayoutChange: () => void
  chatInputRef: RefObject<ChatInputHandle | null>
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>
  activeChatId: string | null
  previousPrompt: string | null
  hasSelectedProject: boolean
  runtimeStatus: string | null
  canCancel: boolean
  projectId: string | null
  projectPath: string | null
  projectRepoLabel: string | null
  activeProvider: AgentProvider | null
  availableProviders: KannaState["availableProviders"]
  subagentEntries?: import("../../../shared/types").TranscriptEntry[]
  contextWindowSnapshot: ContextWindowSnapshot | null
  onSubmit: KannaState["handleSend"]
  onCancel: () => void
  onEditModels: () => void
  onListSkills?: (provider: AgentProvider) => Promise<ChatSkillsSnapshot>
}

export const ChatInputDock = memo(function ChatInputDock({
  inputRef,
  onLayoutChange,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  previousPrompt,
  hasSelectedProject,
  runtimeStatus,
  canCancel,
  projectId,
  projectPath,
  projectRepoLabel,
  activeProvider,
  availableProviders,
  contextWindowSnapshot,
  subagentEntries,
  onSubmit,
  onCancel,
  onEditModels,
  onListSkills,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="relative pointer-events-auto" ref={inputRef}>
        {/* The wash is its own layer, ending at the transcript's scrollbar
            gutter so it stops dimming the scrollbar (which paints below any
            later positioned sibling and can't be raised with z-index). It has
            to be a layer rather than a background on this wrapper: the wrapper
            stays full width so the composer inside it remains centred on the
            card, not on the card minus the gutter. */}
        <div className="absolute inset-y-0 left-0 right-[var(--transcript-scrollbar-w,0px)] bg-gradient-to-t from-background via-background to-background/10 md:to-background/0 pointer-events-none" />
        <div className="relative">
          <ChatInput
            ref={chatInputRef}
            inputElementRef={chatInputElementRef}
            onLayoutChange={onLayoutChange}
            key={activeChatId ?? "new-chat"}
            onSubmit={onSubmit}
            onCancel={onCancel}
            disabled={!hasSelectedProject}
            canCancel={canCancel}
            chatId={activeChatId}
            projectId={projectId}
            projectPath={projectPath}
            projectRepoLabel={projectRepoLabel}
            activeProvider={activeProvider}
            availableProviders={availableProviders}
            contextWindowSnapshot={contextWindowSnapshot}
            subagentEntries={subagentEntries}
            previousPrompt={previousPrompt}
            onEditModels={onEditModels}
            onListSkills={onListSkills}
          />
        </div>
      </div>
    </div>
  )
})
