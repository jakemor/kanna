// Central registry of the raw `kanna:`-prefixed localStorage/sessionStorage keys
// used by the client. Zustand-persisted store names are intentionally not listed
// here — they live next to their `persist(...)` configs in the stores.

/** sessionStorage: current phase of a UI update/restart cycle. */
export const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"

/** sessionStorage: timestamp of the last server-initiated reload request we handled. */
export const UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY = "kanna:last-update-reload-request"

/** localStorage: last app version the user has seen (release notes banner). */
export const VERSION_SEEN_STORAGE_KEY = "kanna:last-seen-version"

/** localStorage: persisted sidebar width in pixels. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "kanna:sidebar-width"

/** localStorage: last action chosen in the open-external menu. */
export const OPEN_EXTERNAL_SELECT_STORAGE_KEY = "kanna:last-open-external"
