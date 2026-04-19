import { useCallback, useEffect, useRef, useState } from "react"
import type {
  BranchActionFailure,
  BranchActionSuccess,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCreateBranchResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  ChatSyncResult,
  DiffCommitMode,
  DiffCommitResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
} from "../../../shared/types"
import { useAppDialog } from "../../components/ui/app-dialog"
import type { KannaState } from "../useKannaState"
import {
  DIFF_REFRESH_INTERVAL_MS,
  EMPTY_DIFF_SNAPSHOT,
  getIgnoreFolderEntryFromDiffPath,
  resolveDiffFilePath,
  serializeBranchSelection,
} from "./utils"

export { EMPTY_DIFF_SNAPSHOT }

interface UseChatPageSidebarActionsArgs {
  state: KannaState
  projectId: string | null
  showRightSidebar: boolean
}

export function useChatPageSidebarActions({
  state,
  projectId,
  showRightSidebar,
}: UseChatPageSidebarActionsArgs) {
  const dialog = useAppDialog()
  const [diffRenderMode, setDiffRenderMode] = useState<"unified" | "split">("unified")
  const [wrapDiffLines, setWrapDiffLines] = useState(false)
  const terminalDiffRefreshTimeoutRef = useRef<number | null>(null)
  const wasProcessingRef = useRef(false)
  const lastProjectGitRefreshProjectIdRef = useRef<string | null>(null)
  const activeChatIdRef = useRef<string | null>(state.activeChatId)
  const projectPathRef = useRef<string | null>(state.runtime?.localPath ?? state.navbarLocalPath ?? null)

  useEffect(() => {
    activeChatIdRef.current = state.activeChatId
  }, [state.activeChatId])

  useEffect(() => {
    projectPathRef.current = state.runtime?.localPath ?? state.navbarLocalPath ?? null
  }, [state.navbarLocalPath, state.runtime?.localPath])

  const refreshProjectGitSnapshot = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [state.socket])

  const refreshDiffs = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId || !showRightSidebar) {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [showRightSidebar, state.socket])

  const scheduleTerminalDiffRefresh = useCallback(() => {
    if (!activeChatIdRef.current || !showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
    }
    terminalDiffRefreshTimeoutRef.current = window.setTimeout(() => {
      terminalDiffRefreshTimeoutRef.current = null
      refreshDiffs()
    }, 1_000)
  }, [refreshDiffs, showRightSidebar])

  const handleOpenDiffFile = useCallback((filePath: string) => {
    const projectPath = projectPathRef.current
    const resolvedPath = resolveDiffFilePath(projectPath, filePath)
    void state.handleOpenLocalLink({ path: resolvedPath })
  }, [state.handleOpenLocalLink])

  const handleCopyDiffFilePath = useCallback((filePath: string) => {
    const projectPath = projectPathRef.current
    void state.handleCopyPath(resolveDiffFilePath(projectPath, filePath))
  }, [state.handleCopyPath])

  const handleCopyDiffRelativePath = useCallback((filePath: string) => {
    void state.handleCopyPath(filePath)
  }, [state.handleCopyPath])

  const handleLoadDiffPatch = useCallback(async (filePath: string) => {
    if (!projectId) {
      throw new Error("Project not found")
    }
    const result = await state.socket.command<{ patch: string }>({
      type: "project.readDiffPatch",
      projectId,
      path: filePath,
    })
    return result.patch
  }, [projectId, state.socket])

  const handleDiscardDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: "Discard Changes",
        description: `Discard changes for "${filePath}"? This cannot be undone.`,
        confirmLabel: "Discard",
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.discardDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: "Discard failed",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: "OK",
        })
      }
    })()
  }, [dialog, state.socket])

  const handleIgnoreDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: "Ignore File",
        description: `Add "${filePath}" to .gitignore?`,
        confirmLabel: "Ignore",
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.ignoreDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: "Ignore failed",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: "OK",
        })
      }
    })()
  }, [dialog, state.socket])

  const handleIgnoreDiffFolder = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    const initialValue = getIgnoreFolderEntryFromDiffPath(filePath)
    if (!initialValue) return

    void (async () => {
      const ignorePath = await dialog.prompt({
        title: "Ignore Folder",
        description: "Edit the folder pattern to add to .gitignore.",
        initialValue,
        confirmLabel: "Ignore",
      })
      if (!ignorePath) return

      try {
        await state.socket.command({
          type: "chat.ignoreDiffFile",
          chatId,
          path: ignorePath,
        })
      } catch (error) {
        await dialog.alert({
          title: "Ignore failed",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: "OK",
        })
      }
    })()
  }, [dialog, state.socket])

  const handleOpenDiffInFinder = useCallback((filePath: string) => {
    void state.handleOpenExternalPath("open_finder", filePath)
  }, [state.handleOpenExternalPath])

  const handleCommitDiffs = useCallback(async (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }
    try {
      const result = await state.socket.command<DiffCommitResult>({
        type: "chat.commitDiffs",
        chatId,
        paths: args.paths,
        summary: args.summary,
        description: args.description,
        mode: args.mode,
      })
      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: result.localCommitCreated
            ? `${result.message}\n\nA local commit was created, but the push did not complete.${result.detail ? `\n\n${result.detail}` : ""}`
            : `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Commit failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket])

  const handleSyncBranch = useCallback(async (action: "fetch" | "pull" | "push" | "publish") => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<ChatSyncResult>({
        type: "chat.syncBranch",
        chatId,
        action,
      })
      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Git sync failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket])

  const handleGenerateCommitMessage = useCallback(async (args: { paths: string[] }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return { subject: "", body: "" }
    }

    const result = await state.socket.command<{ subject: string; body: string }>({
      type: "chat.generateCommitMessage",
      chatId,
      paths: args.paths,
    })

    return {
      subject: result.subject,
      body: result.body,
    }
  }, [state.socket])

  const handleInitializeGit = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.initGit",
        chatId,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Initialize git failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket])

  const handleGetGitHubPublishInfo = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        ghInstalled: false,
        authenticated: false,
        owners: [],
        suggestedRepoName: "my-repo",
      } satisfies GitHubPublishInfo
    }

    return await state.socket.command<GitHubPublishInfo>({
      type: "chat.getGitHubPublishInfo",
      chatId,
    })
  }, [state.socket])

  const handleCheckGitHubRepoAvailability = useCallback(async (args: { owner: string; name: string }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        available: false,
        message: "No active chat.",
      } satisfies GitHubRepoAvailabilityResult
    }

    return await state.socket.command<GitHubRepoAvailabilityResult>({
      type: "chat.checkGitHubRepoAvailability",
      chatId,
      owner: args.owner,
      name: args.name,
    })
  }, [state.socket])

  const handleSetupGitHub = useCallback(async (args: {
    owner: string
    name: string
    visibility: "public" | "private"
    description: string
  }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.publishToGitHub",
        chatId,
        owner: args.owner,
        name: args.name,
        visibility: args.visibility,
        description: args.description.trim() || undefined,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Publish failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket])

  const handleListBranches = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        recent: [],
        local: [],
        remote: [],
        pullRequests: [],
        pullRequestsStatus: "unavailable",
      } satisfies ChatBranchListResult
    }

    return await state.socket.command<ChatBranchListResult>({
      type: "chat.listBranches",
      chatId,
    })
  }, [state.socket])

  const handleCheckoutBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    let bringChanges = false
    if ((state.chatDiffSnapshot?.files.length ?? 0) > 0) {
      const confirmed = await dialog.confirm({
        title: "Bring Changes?",
        description: `You have uncommitted changes. Bring them to ${branch.name}?`,
        confirmLabel: "Bring Changes",
        cancelLabel: "Stay Here",
      })
      if (!confirmed) {
        return
      }
      bringChanges = true
    }

    try {
      const result = await state.socket.command<ChatCheckoutBranchResult>({
        type: "chat.checkoutBranch",
        chatId,
        branch: serializeBranchSelection(branch),
        bringChanges,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok && !result.cancelled) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, refreshDiffs, state.chatDiffSnapshot?.files.length, state.socket])

  const handlePreviewMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        currentBranchName: undefined,
        targetBranchName: branch.name,
        targetDisplayName: branch.displayName,
        status: "error",
        commitCount: 0,
        hasConflicts: false,
        message: "Merge preview unavailable.",
      } satisfies ChatMergePreviewResult
    }

    return await state.socket.command<ChatMergePreviewResult>({
      type: "chat.previewMergeBranch",
      chatId,
      branch: serializeBranchSelection(branch),
    })
  }, [state.socket])

  const handleMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<ChatMergeBranchResult>({
        type: "chat.mergeBranch",
        chatId,
        branch: serializeBranchSelection(branch),
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Merge failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket])

  const handleCreateBranch = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    const name = await dialog.prompt({
      title: "New Branch",
      description: "Enter a branch name.",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    })
    if (!name) {
      return
    }

    const branchList = await handleListBranches()
    const currentBranchName = branchList.currentBranchName
    const defaultBranchName = branchList.defaultBranchName

    let baseBranchName = defaultBranchName
    if (defaultBranchName && currentBranchName && defaultBranchName !== currentBranchName) {
      const createFromCurrent = await dialog.confirm({
        title: "Branch Base",
        description: `Create "${name}" from ${currentBranchName} instead of ${defaultBranchName}?`,
        confirmLabel: `From ${currentBranchName}`,
        cancelLabel: `From ${defaultBranchName}`,
      })
      baseBranchName = createFromCurrent ? currentBranchName : defaultBranchName
    }

    try {
      const result = await state.socket.command<ChatCreateBranchResult>({
        type: "chat.createBranch",
        chatId,
        name,
        baseBranchName,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Create branch failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, handleListBranches, refreshDiffs, state.socket])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    const intervalId = window.setInterval(() => {
      refreshDiffs()
    }, DIFF_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    refreshDiffs()
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !state.activeChatId) {
      return
    }
    if (lastProjectGitRefreshProjectIdRef.current === projectId) {
      return
    }
    lastProjectGitRefreshProjectIdRef.current = projectId
    refreshProjectGitSnapshot()
  }, [projectId, refreshProjectGitSnapshot, state.activeChatId])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    function handleDiffRefresh() {
      if (document.visibilityState !== "visible") return
      refreshDiffs()
    }

    window.addEventListener("focus", handleDiffRefresh)
    document.addEventListener("visibilitychange", handleDiffRefresh)

    return () => {
      window.removeEventListener("focus", handleDiffRefresh)
      document.removeEventListener("visibilitychange", handleDiffRefresh)
    }
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (showRightSidebar && wasProcessingRef.current && !state.isProcessing) {
      refreshDiffs()
    }
    wasProcessingRef.current = state.isProcessing
  }, [refreshDiffs, showRightSidebar, state.isProcessing])

  useEffect(() => {
    return () => {
      if (terminalDiffRefreshTimeoutRef.current !== null) {
        window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      terminalDiffRefreshTimeoutRef.current = null
    }
  }, [projectId, showRightSidebar])

  return {
    diffRenderMode,
    wrapDiffLines,
    setDiffRenderMode,
    setWrapDiffLines,
    scheduleTerminalDiffRefresh,
    handleOpenDiffFile,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleOpenDiffInFinder,
    handleCommitDiffs,
    handleSyncBranch,
    handleGenerateCommitMessage,
    handleInitializeGit,
    handleGetGitHubPublishInfo,
    handleCheckGitHubRepoAvailability,
    handleSetupGitHub,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  }
}
