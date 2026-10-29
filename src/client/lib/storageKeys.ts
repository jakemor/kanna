// Central registry of the raw `kanna:`-prefixed localStorage/sessionStorage keys
// used by the client. Zustand-persisted store names are intentionally not listed
// here — they live next to their `persist(...)` configs in the stores.

/** sessionStorage: current phase of a UI update/restart cycle. */
export const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"

/** sessionStorage: timestamp of the last server-initiated reload request we handled. */
export const UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY = "kanna:last-update-reload-request"

/** localStorage: persisted sidebar width in pixels. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "kanna:sidebar-width"

/** localStorage: "1" while the sidebar is collapsed, so a reload leaves it that way. */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "kanna:sidebar-collapsed"

/** localStorage: last action chosen in the open-external menu. */
export const OPEN_EXTERNAL_SELECT_STORAGE_KEY = "kanna:last-open-external"

/**
 * sessionStorage, + project id: where the diff viewer was (how far into the
 * file, which files were collapsed, previewed, shown whole), so a reload
 * comes back to the same spot. Cleared when the viewer closes.
 */
export const DIFF_REVIEW_STORAGE_KEY_PREFIX = "kanna:diff-review:"

/** localStorage: last app chosen to open a single file from the viewer. */
export const OPEN_FILE_DESTINATION_STORAGE_KEY = "kanna:last-open-file"

/** localStorage: active sidebar view ("recents" | "projects" | "channels") when the recent-chats Labs mode is on. */
export const SIDEBAR_VIEW_STORAGE_KEY = "kanna:sidebar-view"

/**
 * localStorage (legacy): JSON map of project id to when its channel was
 * pinned. Pins are the server's now (`SidebarProjectGroup.pinnedAt`); this is
 * only read once, to carry a browser's own pins over, then removed. See
 * app/useMigrateChannelPins.ts.
 */
export const CHANNEL_PINS_STORAGE_KEY = "kanna:channel-pins"

/** localStorage: JSON list of the chat tabs (`ChatTab[]`), in order. */
export const CHAT_TABS_STORAGE_KEY = "kanna:chat-tabs"

/** localStorage: JSON map of sidebar list to whether its Pinned section is expanded, once you have toggled it. */
export const SIDEBAR_PINNED_EXPANDED_STORAGE_KEY = "kanna:sidebar-pinned-expanded"


/** localStorage: JSON map of project id to the chats viewed in it, most recent first. See lib/lastViewedChats.ts. */
export const LAST_VIEWED_CHATS_STORAGE_KEY = "kanna:last-viewed-chats"

/** localStorage: focus mode is on, so the sidebar shows only the open chat's project. */
export const SIDEBAR_FOCUS_MODE_STORAGE_KEY = "kanna:sidebar-focus-mode"

// Legacy setup-wizard markers. Onboarding progress is now machine-wide state
// in the server's settings file (`setupShown`/`setupCompleted`/`setupDismissed`
// on the app-settings snapshot) so a second browser — local or via the cloud
// tunnel — never re-runs a wizard this machine already finished. These keys are
// only read once, to migrate a pre-upgrade browser, then removed; see
// readLegacySetupFlagsPatch in app/useAppSettingsSync.ts.

/** localStorage (legacy): the setup wizard has been shown at least once. */
export const LEGACY_SETUP_SHOWN_STORAGE_KEY = "kanna:setup-shown"

/** localStorage (legacy): the setup wizard was completed (finished the last step). */
export const LEGACY_SETUP_COMPLETED_STORAGE_KEY = "kanna:setup-completed"

/** localStorage (legacy): the setup wizard was dismissed ("Set up later"). */
export const LEGACY_SETUP_DISMISSED_STORAGE_KEY = "kanna:setup-dismissed"
