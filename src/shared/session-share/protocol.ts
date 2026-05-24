import type { MintRequest, MintResponse, RevokeRequest, ShareError, ShareSummary } from "./types"

export const SHARE_CMD_MINT = "share.mint" as const
export const SHARE_CMD_REVOKE = "share.revoke" as const
export const SHARE_CMD_LIST = "share.list" as const

export type ShareClientCommand =
  | { type: typeof SHARE_CMD_MINT; payload: MintRequest }
  | { type: typeof SHARE_CMD_REVOKE; payload: RevokeRequest }
  | { type: typeof SHARE_CMD_LIST; payload: { chatId: string } }

export type ShareCommandResult =
  | { ok: true; kind: "mint"; data: MintResponse }
  | { ok: true; kind: "revoke"; data: { tokenId: string } }
  | { ok: true; kind: "list"; data: { shares: ShareSummary[] } }
  | { ok: false; error: ShareError }
