import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react"
import type { NavigateFunction } from "react-router-dom"
import type { AgentProvider, ChatAttachment, ModelOptions, SidebarData, TranscriptEntry } from "../../shared/types"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { generateUUID } from "../lib/utils"
import {
  composerStateFromSendOptions,
  countMatchingUserPrompts,
  getUserPromptSignature,
  NEW_CHAT_OPTIMISTIC_SCOPE,
  type OptimisticProcessingState,
  type OptimisticUserPrompt,
} from "./kannaStateHelpers"
import type { KannaSocket } from "./socket"

export interface SendContext {
  isProcessing: boolean
  optimisticUserPrompts: OptimisticUserPrompt[]
  serverTranscriptEntries: TranscriptEntry[]
  sidebarProjectGroups: SidebarData["projectGroups"]
  selectedProjectId: string | null
  fallbackLocalProjectPath: string | null
}

// The send pipeline: enqueue while processing, otherwise optimistically append
// the prompt, create/resolve the chat, and reconcile on failure.
export function useSendMessage(params: {
  socket: KannaSocket
  navigate: NavigateFunction
  activeChatId: string | null
  setCommandError: (message: string | null) => void
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>
  setPendingChatId: Dispatch<SetStateAction<string | null>>
  setOptimisticProcessing: Dispatch<SetStateAction<OptimisticProcessingState | null>>
  setOptimisticUserPrompts: Dispatch<SetStateAction<OptimisticUserPrompt[]>>
  sendContext: SendContext
}) {
  const {
    socket,
    navigate,
    activeChatId,
    setCommandError,
    setSelectedProjectId,
    setPendingChatId,
    setOptimisticProcessing,
    setOptimisticUserPrompts,
  } = params

  // Snapshot-derived values read inside handleSend live behind a ref so the
  // callback identity stays stable across streaming updates; otherwise every
  // transcript entry would invalidate the composer's memo barrier. The ref is
  // written in a layout effect (not during render) so it stays pure under
  // concurrent rendering; handleSend only fires from event handlers, which
  // always run after the commit.
  const sendContextRef = useRef(params.sendContext)
  useLayoutEffect(() => {
    sendContextRef.current = params.sendContext
  })

  const handleSend = useCallback(async (
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: ChatAttachment[] }
  ) => {
    const { isProcessing, optimisticUserPrompts, serverTranscriptEntries, sidebarProjectGroups, selectedProjectId, fallbackLocalProjectPath } = sendContextRef.current
    const attachments = options?.attachments ?? []
    if (activeChatId && isProcessing) {
      try {
        await socket.command<{ queuedMessageId: string }>({
          type: "message.enqueue",
          chatId: activeChatId,
          content,
          attachments,
          provider: options?.provider,
          model: options?.model,
          modelOptions: options?.modelOptions,
          planMode: options?.planMode,
        })
        setCommandError(null)
        return
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const optimisticId = generateUUID()
    const signature = getUserPromptSignature(content, attachments)
    const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
    setOptimisticProcessing({
      scopeId: optimisticScopeId,
      ackedAt: null,
    })
    const requiredMatchCount = countMatchingUserPrompts(serverTranscriptEntries, signature)
      + optimisticUserPrompts.filter((prompt) => prompt.scopeId === optimisticScopeId && prompt.signature === signature).length
      + 1

    setOptimisticUserPrompts((current) => [...current, {
      id: optimisticId,
      scopeId: optimisticScopeId,
      signature,
      requiredMatchCount,
      entry: {
        _id: `optimistic:${optimisticId}`,
        kind: "user_prompt",
        content,
        attachments,
        createdAt: Date.now(),
      },
    }])

    try {
      let projectId = selectedProjectId ?? sidebarProjectGroups[0]?.groupKey ?? null
      if (!activeChatId && !projectId && fallbackLocalProjectPath) {
        const project = await socket.command<{ projectId: string }>({
          type: "project.open",
          localPath: fallbackLocalProjectPath,
        })
        projectId = project.projectId
        setSelectedProjectId(projectId)
      }

      if (!activeChatId && !projectId) {
        throw new Error("Open a project first")
      }

      const result = await socket.command<{ chatId?: string }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        provider: options?.provider,
        content,
        attachments,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
      })
      setOptimisticProcessing((current) => {
        if (!current) return current
        const nextScopeId = !activeChatId && result.chatId ? result.chatId : current.scopeId
        return {
          scopeId: nextScopeId,
          ackedAt: performance.now(),
        }
      })

      if (!activeChatId && result.chatId) {
        setOptimisticUserPrompts((current) => current.map((prompt) => (
          prompt.id === optimisticId ? { ...prompt, scopeId: result.chatId! } : prompt
        )))
        const chatPreferences = useChatPreferencesStore.getState()
        chatPreferences.setComposerState(
          result.chatId,
          composerStateFromSendOptions(options) ?? chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
        )
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      }
      setCommandError(null)
    } catch (error) {
      setOptimisticUserPrompts((current) => current.filter((prompt) => prompt.id !== optimisticId))
      setOptimisticProcessing(null)
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [activeChatId, navigate, setCommandError, setOptimisticProcessing, setOptimisticUserPrompts, setPendingChatId, setSelectedProjectId, socket])

  return handleSend
}
