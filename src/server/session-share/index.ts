import type {
  ChatSnapshot,
  MintRequest,
  MintResponse,
  RevokeRequest,
  ShareError,
  ShareSummary,
} from "../../shared/session-share/types"
import {
  applyShareEvent,
  buildShareProjection,
  classifyShare,
  type ShareEvent,
  type ShareProjection,
} from "./share-projection"
import type { SnapshotStore } from "./snapshot-store.adapter"
import { generateShareToken } from "./token"

export interface ShareEventSink {
  appendShareEvent(event: ShareEvent): Promise<void>
  getShareEvents(): ShareEvent[]
}

export interface SessionShareDeps {
  events: ShareEventSink
  snapshotStore: SnapshotStore
  buildSnapshot: (chatId: string) => ChatSnapshot
  getTunnelBaseUrl: () => string | null
  getDefaultTtlHours: () => number
  now?: () => number
  owner: () => string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ShareError }

const HARD_SIZE_CAP = 50 * 1024 * 1024

export class SessionShareService {
  private projection: ShareProjection
  private readonly deps: SessionShareDeps
  private readonly now: () => number

  constructor(deps: SessionShareDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.projection = buildShareProjection(deps.events.getShareEvents())
  }

  async mintToken(req: MintRequest): Promise<Result<MintResponse>> {
    const base = this.deps.getTunnelBaseUrl()
    if (!base) return { ok: false, error: { kind: "no_tunnel" } }

    let snapshot: ChatSnapshot
    try {
      snapshot = this.deps.buildSnapshot(req.chatId)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.startsWith("chat_not_found:")) {
        return { ok: false, error: { kind: "chat_not_found", chatId: req.chatId } }
      }
      throw err
    }

    const bodyBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
    if (bodyBytes > HARD_SIZE_CAP) {
      return { ok: false, error: { kind: "snapshot_too_large", sizeBytes: bodyBytes } }
    }

    const tokenId = generateShareToken()
    const ttlHours = req.ttlHours ?? this.deps.getDefaultTtlHours()
    const createdAt = this.now()
    const expiresAt = createdAt + ttlHours * 3600 * 1000

    try {
      await this.deps.snapshotStore.writeSnapshot(tokenId, snapshot)
    } catch (err) {
      return { ok: false, error: { kind: "snapshot_write_failed", message: (err as Error).message } }
    }

    const event: ShareEvent = {
      v: 1,
      kind: "share.token_minted",
      tokenId,
      chatId: req.chatId,
      expiresAt,
      createdAt,
      createdBy: this.deps.owner(),
    }
    await this.deps.events.appendShareEvent(event)
    applyShareEvent(this.projection, event)

    const summary: ShareSummary = {
      tokenId,
      chatId: req.chatId,
      url: `${base.replace(/\/$/, "")}/share/${tokenId}`,
      expiresAt,
      createdAt,
      revoked: false,
    }
    return { ok: true, data: { summary } }
  }

  async revokeToken(req: RevokeRequest): Promise<Result<{ tokenId: string }>> {
    const record = this.projection.get(req.tokenId)
    if (!record) return { ok: false, error: { kind: "not_found" } }
    const event: ShareEvent = {
      v: 1,
      kind: "share.token_revoked",
      tokenId: req.tokenId,
      revokedAt: this.now(),
    }
    await this.deps.events.appendShareEvent(event)
    applyShareEvent(this.projection, event)
    await this.deps.snapshotStore.deleteSnapshot(req.tokenId)
    return { ok: true, data: { tokenId: req.tokenId } }
  }

  async getShare(
    tokenId: string,
    now: number = this.now(),
  ): Promise<Result<{ snapshot: ChatSnapshot }>> {
    const status = classifyShare(this.projection, tokenId, now)
    if (status.kind === "not_found") return { ok: false, error: { kind: "not_found" } }
    if (status.kind === "revoked") return { ok: false, error: { kind: "revoked" } }
    if (status.kind === "expired")
      return { ok: false, error: { kind: "expired", expiredAt: status.record.expiresAt } }
    const snapshot = await this.deps.snapshotStore.readSnapshot(tokenId)
    if (!snapshot)
      return { ok: false, error: { kind: "snapshot_read_failed", message: "snapshot missing" } }
    return { ok: true, data: { snapshot } }
  }

  listSharesForChat(chatId: string): ShareSummary[] {
    const base = this.deps.getTunnelBaseUrl() ?? ""
    const out: ShareSummary[] = []
    for (const record of this.projection.values()) {
      if (record.chatId !== chatId) continue
      out.push({
        tokenId: record.tokenId,
        chatId: record.chatId,
        url: base ? `${base.replace(/\/$/, "")}/share/${record.tokenId}` : "",
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
        revoked: record.revoked,
      })
    }
    return out
  }

  async runSweep(now: number = this.now()): Promise<number> {
    let removed = 0
    for (const record of this.projection.values()) {
      if (record.revoked) continue
      if (record.expiresAt > now) continue
      await this.deps.snapshotStore.deleteSnapshot(record.tokenId)
      removed++
    }
    return removed
  }
}
