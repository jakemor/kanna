import type { ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientSocket } from "./platform/http-host"

export interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  includeAppSettings?: boolean
  includeUsageLimits?: boolean
  includeProviderAuth?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

export function shouldIncludeTopic(topic: SubscriptionTopic, filter?: SnapshotBroadcastFilter) {
  if (!filter) return true
  if (topic.type === "sidebar") return Boolean(filter.includeSidebar)
  if (topic.type === "local-projects") return Boolean(filter.includeLocalProjects)
  if (topic.type === "update") return Boolean(filter.includeUpdate)
  if (topic.type === "keybindings") return Boolean(filter.includeKeybindings)
  if (topic.type === "app-settings") return Boolean(filter.includeAppSettings)
  if (topic.type === "usage-limits") return Boolean(filter.includeUsageLimits)
  if (topic.type === "provider-auth") return Boolean(filter.includeProviderAuth)
  if (topic.type === "chat") return filter.chatIds?.has(topic.chatId) ?? false
  if (topic.type === "project-git") return filter.projectIds?.has(topic.projectId) ?? false
  if (topic.type === "terminal") return filter.terminalIds?.has(topic.terminalId) ?? false
  return true
}

const COMPRESS_FRAME_MIN_BYTES = 1024

function sendFrame<Data>(socket: ClientSocket<Data>, payload: string) {
  socket.send(payload, payload.length >= COMPRESS_FRAME_MIN_BYTES)
}

export function sendEnvelope<Data>(socket: ClientSocket<Data>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  sendFrame(socket, payload)
  return payload.length
}

export function sendSerializedSnapshot<Data>(socket: ClientSocket<Data>, id: string, snapshotJson: string) {
  sendFrame(socket, `{"v":${PROTOCOL_VERSION},"type":"snapshot","id":${JSON.stringify(id)},"snapshot":${snapshotJson}}`)
}
