export type ShareEvent =
  | {
      v: 1
      kind: "share.token_minted"
      tokenId: string
      chatId: string
      expiresAt: number
      createdAt: number
      createdBy: string
    }
  | { v: 1; kind: "share.token_revoked"; tokenId: string; revokedAt: number }

export interface ShareRecord {
  tokenId: string
  chatId: string
  expiresAt: number
  createdAt: number
  createdBy: string
  revoked: boolean
  revokedAt: number | null
}

export type ShareProjection = Map<string, ShareRecord>

export function applyShareEvent(projection: ShareProjection, event: ShareEvent): void {
  if (event.kind === "share.token_minted") {
    projection.set(event.tokenId, {
      tokenId: event.tokenId,
      chatId: event.chatId,
      expiresAt: event.expiresAt,
      createdAt: event.createdAt,
      createdBy: event.createdBy,
      revoked: false,
      revokedAt: null,
    })
    return
  }
  const existing = projection.get(event.tokenId)
  if (!existing) return
  projection.set(event.tokenId, { ...existing, revoked: true, revokedAt: event.revokedAt })
}

export function buildShareProjection(events: Iterable<ShareEvent>): ShareProjection {
  const proj: ShareProjection = new Map()
  for (const e of events) applyShareEvent(proj, e)
  return proj
}

export type ShareStatus =
  | { kind: "ok"; record: ShareRecord }
  | { kind: "not_found" }
  | { kind: "revoked"; record: ShareRecord }
  | { kind: "expired"; record: ShareRecord }

export function classifyShare(projection: ShareProjection, tokenId: string, now: number): ShareStatus {
  const record = projection.get(tokenId)
  if (!record) return { kind: "not_found" }
  if (record.revoked) return { kind: "revoked", record }
  if (record.expiresAt <= now) return { kind: "expired", record }
  return { kind: "ok", record }
}
