import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Code,
  Info,
  LogOut,
} from "lucide-react"
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { getKeybindingsFilePathDisplay, SDK_CLIENT_APP } from "../../shared/branding"
import { getResolvedKeybindings } from "../lib/keybindings"
import { cn } from "../lib/utils"
import { ChangelogSection, useChangelog } from "./settings/ChangelogSection"
import { GeneralSection } from "./settings/GeneralSection"
import { KeybindingsSection } from "./settings/KeybindingsSection"
import { LabsSection } from "./settings/LabsSection"
import { MacSection } from "./settings/MacSection"
import { ProvidersSection } from "./settings/ProvidersSection"
import { SETTINGS_SECTIONS, visibleSettingsSections } from "./settings/registry"
import { SkillsSection } from "./settings/SkillsSection"
import { SecretsSection } from "./settings/SecretsSection"
import { UsageSection } from "./settings/UsageSection"
import { SidebarExpandControls } from "./SidebarExpandControls"
import { getKeybindingsSubtitle, SETTINGS_INSET_X_CLASS, SettingsActionButton, SettingsNotice, SettingsPlaceholder } from "./settings/shared"
import type { KannaState } from "./useKannaState"

// Sections live under ./settings/; these re-exports keep the historical
// public API of this module intact (tests and older imports).
export {
  ChangelogSection,
  fetchGithubReleases,
  formatPublishedDate,
  getCachedChangelog,
  loadChangelog,
  resetSettingsPageChangelogCache,
  setCachedChangelog,
} from "./settings/ChangelogSection"
export { SkillsSection } from "./settings/SkillsSection"
export {
  getKeybindingsSubtitle,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  shouldPreviewChatSoundChange,
} from "./settings/shared"

// This Mac shows only in Kanna for Mac (registry.isSettingsSectionVisible);
// the answer is a property of the page, so it's read once.
const sidebarItems = visibleSettingsSections()
type SidebarItem = (typeof SETTINGS_SECTIONS)[number]
type SidebarPageId = SidebarItem["id"]

export function resolveSettingsSectionId(sectionId: string | undefined): SidebarPageId | null {
  if (!sectionId) return null
  return sidebarItems.some((item) => item.id === sectionId) ? (sectionId as SidebarPageId) : null
}

/**
 * The "Settings" heading atop the page's own sidebar column. With the app
 * sidebar collapsed, a browser shows the flower and expand button at the
 * window's top-left, which is where this heading sits, so they are drawn in
 * the column above it, as the chat navbar draws them in its row. Pulled out
 * of the column's px-4 py-6 to 12px in and 6.5px down, they sit where the
 * projects page floats them (KannaSidebar): the flower's center on the open
 * sidebar's logo, 24px in and 24.5px down. The Mac app
 * hides them; its pinned toggle is cleared by the column's mac-app padding.
 */
export function SettingsSidebarHeading({
  sidebarCollapsed,
  onExpandSidebar,
}: {
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
}) {
  return (
    <>
      {sidebarCollapsed ? <SidebarExpandControls onExpand={onExpandSidebar} className="-mt-[17.5px] -ml-1" /> : null}
      <div className="px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground">
        Settings
      </div>
    </>
  )
}

/**
 * Scrolls the settings row matching `#rowId` into view and briefly
 * highlights it. Used by the command palette's "jump to setting" entries.
 */
function useSettingsRowHashScroll(hash: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const rowId = hash.startsWith("#") ? hash.slice(1) : hash
    if (!rowId) return

    let cancelled = false
    let attempts = 0
    let timeoutId: number | null = null

    function tryScroll() {
      if (cancelled) return
      const element = document.getElementById(rowId)
      if (!element) {
        attempts += 1
        if (attempts < 20) {
          requestAnimationFrame(tryScroll)
        }
        return
      }

      element.scrollIntoView({ block: "center" })
      element.classList.add("bg-muted", "transition-colors", "duration-700")
      timeoutId = window.setTimeout(() => {
        element.classList.remove("bg-muted")
      }, 900)
    }

    requestAnimationFrame(tryScroll)

    return () => {
      cancelled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [hash, ready])
}

export function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { sectionId } = useParams<{ sectionId: string }>()
  const state = useOutletContext<KannaState>()
  const [signingOut, setSigningOut] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const selectedPage = resolveSettingsSectionId(sectionId) ?? "general"
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? "Unavailable"
  const projectCount = state.localProjects?.projects.length ?? 0
  const appVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const changelog = useChangelog(selectedPage === "changelog" && !isConnecting)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const keybindingsFilePathDisplay = resolvedKeybindings.filePathDisplay || getKeybindingsFilePathDisplay()

  useSettingsRowHashScroll(location.hash, !isConnecting)

  useEffect(() => {
    if (!sectionId) return
    if (resolveSettingsSectionId(sectionId)) return
    navigate("/settings/general", { replace: true })
  }, [navigate, sectionId])

  useEffect(() => {
    let cancelled = false

    void fetch("/auth/status", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) return { enabled: false }
        return await response.json() as { enabled?: boolean }
      })
      .then((payload) => {
        if (cancelled) return
        setAuthEnabled(payload.enabled === true)
      })
      .catch(() => {
        if (cancelled) return
        setAuthEnabled(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const selectedSection = sidebarItems.find((item) => item.id === selectedPage) ?? sidebarItems[0]
  const selectedSectionSubtitle =
    selectedPage === "keybindings"
      ? getKeybindingsSubtitle(keybindingsFilePathDisplay)
      : selectedSection.subtitle
  const showFooter = !isConnecting

  // Picking another section fades its content in, so the swap reads as one
  // page changing rather than a cut. Opening Settings doesn't: that is often
  // ⌘, and a shortcut should land at once.
  const shownSectionRef = useRef(selectedPage)
  const sectionSwitchedRef = useRef(false)
  if (shownSectionRef.current !== selectedPage) {
    shownSectionRef.current = selectedPage
    sectionSwitchedRef.current = true
  }
  const sectionSwitched = sectionSwitchedRef.current

  async function handleSidebarSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      await state.handleSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div data-settings-page className="relative flex h-full flex-1 min-w-0 bg-background">
      {/* The Mac app's title bar across the settings page: it drags the window.
          Only the sidebar's "Settings" heading and the content's md:pt-16
          reach up under it, so it covers nothing clickable. */}
      <div
        data-window-drag
        aria-hidden
        className="hidden mac-app:md:block absolute inset-x-0 top-0 z-10 h-[calc(var(--mac-traffic-lights-center)*2)]"
      />
      <div className="flex min-w-0 flex-1">
        <aside className={`hidden w-[200px] shrink-0 md:block ${showFooter ? "pb-[89px]" : ""}`}>
          {/* In the Mac app the traffic lights and the pinned sidebar toggle sit
              over this column's top when the app sidebar is collapsed. */}
          <div className="flex flex-col gap-1 px-4 py-6 mac-app:md:pt-[43px]">
            <SettingsSidebarHeading
              sidebarCollapsed={state.sidebarCollapsed}
              onExpandSidebar={state.expandSidebar}
            />
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/settings/${item.id}`)}
                className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${
                  item.id === selectedPage
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
              </button>
            ))}
            {authEnabled ? (
              <button
                type="button"
                onClick={() => {
                  void handleSidebarSignOut()
                }}
                disabled={signingOut}
                className="cursor-pointer rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-2.5">
                  <LogOut className="h-4 w-4 shrink-0" />
                  <span>{signingOut ? "Signing out..." : "Sign out"}</span>
                </div>
              </button>
            ) : null}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="border-b border-border py-2 md:hidden h-[63px] pl-1 md:h-auto">
            <div className="overflow-x-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex min-w-max items-center gap-2">
                <div className=" sticky left-0 bg-gradient-to-r from-background via-background/90 to-background/10 pl-2 pr-1 py-1">
                <button
                  type="button"
                  onClick={state.openSidebar}
                  className="flex shrink-0 items-center p-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  aria-label="Back"
                  title="Back"
                >
                  <ArrowLeft className="h-[20px] w-[20px] shrink-0" />
                </button>
                </div>
                {sidebarItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(`/settings/${item.id}`)}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      item.id === selectedPage
                        ? "border-transparent bg-muted font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                ))}
                {authEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSidebarSignOut()
                    }}
                    disabled={signingOut}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50"
                    )}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{signingOut ? "Signing out..." : "Sign out"}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="w-full px-4 pb-32 pt-8 md:px-6 md:pt-16">
            {isConnecting ? (
              <SettingsPlaceholder loading className="mx-auto max-w-4xl">Loading machine settings…</SettingsPlaceholder>
            ) : (
              <div
                key={selectedPage}
                className={cn(
                  "@container mx-auto max-w-4xl",
                  sectionSwitched && "transition-opacity duration-150 ease-snappy starting:opacity-0",
                )}
              >
                <div className={cn("pb-6", SETTINGS_INSET_X_CLASS)}>
                  <div className="flex items-center justify-between gap-4 min-h-[34px]">
                    <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                      {selectedSection.label}
                    </div>
                    {selectedPage === "keybindings" ? (
                      <SettingsActionButton
                        onClick={() => {
                          void state.handleOpenExternalPath("open_editor", keybindingsFilePathDisplay)
                        }}
                        icon={<Code />}
                      >
                        Open in {state.editorLabel}
                      </SettingsActionButton>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedSectionSubtitle}
                  </div>
                </div>

                {selectedPage === "general" ? (
                  <GeneralSection state={state} appVersion={appVersion} />
                ) : selectedPage === "mac" ? (
                  <MacSection />
                ) : selectedPage === "providers" ? (
                  <ProvidersSection state={state} />
                ) : selectedPage === "keybindings" ? (
                  <KeybindingsSection state={state} />
                ) : selectedPage === "skills" ? (
                  <SkillsSection state={state} />
                ) : selectedPage === "secrets" ? (
                  <SecretsSection state={state} />
                ) : selectedPage === "usage" ? (
                  <UsageSection state={state} />
                ) : selectedPage === "labs" ? (
                  <LabsSection state={state} appVersion={appVersion} />
                ) : (
                  <ChangelogSection
                    status={changelog.status}
                    releases={changelog.releases}
                    error={changelog.error}
                    onRetry={changelog.retry}
                    updateSnapshot={state.updateSnapshot}
                    currentVersion={appVersion}
                    onInstallUpdate={() => {
                      void state.handleInstallUpdate()
                    }}
                    onCheckForUpdates={() => {
                      void state.handleCheckForUpdates({ force: true })
                    }}
                  />
                )}
              </div>
            )}

            {state.commandError ? (
              <SettingsNotice className="mx-auto mt-6 flex max-w-4xl items-start gap-3">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{state.commandError}</span>
              </SettingsNotice>
            ) : null}
          </div>

        </div>
      </div>

      {showFooter ? (
        <div className="absolute bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="px-6 py-[14.25px]">
            <div className="grid gap-3 text-xs text-muted-foreground grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Machine</div>
                <div className="text-foreground/80">{machineName}</div>
              </div>
              <div className="hidden md:block">
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Connection</div>
                <div className="text-foreground/80">{state.connectionStatus}</div>
              </div>
              <div className="hidden md:block">
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Projects Indexed</div>
                <div className="text-foreground/80">{projectCount}</div>
              </div>
              <div>
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">App Version</div>
                <div className="text-foreground/80">{appVersion}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
