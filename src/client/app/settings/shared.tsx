import type { KeyboardEvent, ReactNode } from "react"
import { cn } from "../../lib/utils"
import type { ChatBrowserNotificationPreference } from "../../stores/chatSoundPreferencesStore"

/** Shared row layout + tiny helpers for the settings sections. */

export const ENABLED_DISABLED_OPTIONS = [
  { value: "disabled" as const, label: "Off" },
  { value: "enabled" as const, label: "On" },
]

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return `Edit global app shortcuts stored in ${filePathDisplay}.`
}

export function shouldPreviewChatSoundChange(
  previousValue: string,
  nextValue: string
) {
  return previousValue !== nextValue
}

export function resolveChatBrowserNotificationPreferenceAfterPermission(
  requestedPreference: ChatBrowserNotificationPreference,
  permission: NotificationPermission | "unsupported"
): ChatBrowserNotificationPreference {
  if (requestedPreference === "never") return "never"
  return permission === "granted" ? requestedPreference : "never"
}

export function handleSettingsInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
  if (event.key !== "Enter") return
  commit()
  event.currentTarget.blur()
}

export function SettingsErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  )
}

export function SettingsRow({
  title,
  description,
  children,
  bordered = true,
  alignStart = false,
}: {
  title: string
  description: ReactNode
  children: ReactNode
  bordered?: boolean
  alignStart?: boolean
}) {
  return (
    <div className={bordered ? "border-t border-border" : undefined}>
      <div
        className={cn(
          "flex flex-col gap-4 py-5 md:flex-row md:justify-between md:gap-8",
          alignStart ? "md:items-start" : "md:items-center"
        )}
      >
        <div className="min-w-0 max-w-xl">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>
        </div>
        <div className="flex items-center justify-start md:shrink-0 md:justify-end">{children}</div>
      </div>
    </div>
  )
}
