export const ANALYTICS_ENDPOINT = "https://kanna.sh/api/t"

export const ANALYTICS_STATIC_EVENT_NAMES = [
  "app_launch",
  "project_opened",
  "project_removed",
  "chat_created",
  "chat_deleted",
  "message_sent",
  "update_checked",
  "update_installed",
  "update_failed",
  "analytics_enabled",
  "analytics_disabled",
] as const

export const ANALYTICS_STATIC_PROPERTY_NAMES = [
  "current_version",
  "environment",
  "latest_version",
  "custom_port_enabled",
  "no_open_enabled",
  "password_enabled",
  "strict_port_enabled",
  "remote_enabled",
  "host_enabled",
  "share_quick_enabled",
  "share_token_enabled",
] as const
