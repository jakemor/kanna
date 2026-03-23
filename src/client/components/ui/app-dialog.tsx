import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Button } from "./button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./dialog"

interface ConfirmDialogOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: "default" | "destructive" | "secondary"
}

interface PromptDialogOptions {
  title: string
  description?: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  cancelLabel?: string
}

interface AppDialogContextValue {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  prompt: (options: PromptDialogOptions) => Promise<string | null>
}

type DialogState =
  | {
      kind: "confirm"
      options: ConfirmDialogOptions
      resolve: (value: boolean) => void
    }
  | {
      kind: "prompt"
      options: PromptDialogOptions
      resolve: (value: string | null) => void
    }

const AppDialogContext = createContext<AppDialogContextValue | null>(null)

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [dialogState, setDialogState] = useState<DialogState | null>(null)
  const [inputValue, setInputValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialogState?.kind !== "prompt") return
    setInputValue(dialogState.options.initialValue ?? "")
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [dialogState])

  const closeDialog = useCallback(() => {
    setDialogState(null)
    setInputValue("")
  }, [])

  const resolveCancel = useCallback(() => {
    if (!dialogState) return
    if (dialogState.kind === "confirm") {
      dialogState.resolve(false)
    } else {
      dialogState.resolve(null)
    }
    closeDialog()
  }, [closeDialog, dialogState])

  const resolveConfirm = useCallback(() => {
    if (!dialogState) return
    if (dialogState.kind === "confirm") {
      dialogState.resolve(true)
    } else {
      dialogState.resolve(inputValue.trim() || null)
    }
    closeDialog()
  }, [closeDialog, dialogState, inputValue])

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialogState({ kind: "confirm", options, resolve })
    })
  }, [])

  const prompt = useCallback((options: PromptDialogOptions) => {
    return new Promise<string | null>((resolve) => {
      setDialogState({ kind: "prompt", options, resolve })
    })
  }, [])

  const value = useMemo<AppDialogContextValue>(() => ({ confirm, prompt }), [confirm, prompt])

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      <Dialog
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (open || !dialogState) return
          resolveCancel()
        }}
      >
        <DialogContent
          size="sm"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || !dialogState || dialogState.kind !== "confirm") return
            event.preventDefault()
            resolveConfirm()
          }}
        >
          {dialogState ? (
            <>
              <DialogBody className="space-y-4">
                <DialogTitle>{dialogState.options.title}</DialogTitle>
                {dialogState.options.description ? (
                  <DialogDescription>{dialogState.options.description}</DialogDescription>
                ) : null}
                {dialogState.kind === "prompt" ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        resolveConfirm()
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background outline-none"
                    placeholder={dialogState.options.placeholder}
                  />
                ) : null}
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resolveCancel}
                >
                  {dialogState.options.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  variant={dialogState.kind === "confirm" ? (dialogState.options.confirmVariant ?? "default") : "secondary"}
                  size="sm"
                  onClick={resolveConfirm}
                  disabled={dialogState.kind === "prompt" && !inputValue.trim()}
                >
                  {dialogState.options.confirmLabel ?? "Confirm"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </AppDialogContext.Provider>
  )
}

export function useAppDialog() {
  const context = useContext(AppDialogContext)
  if (!context) {
    throw new Error("useAppDialog must be used within AppDialogProvider")
  }
  return context
}
