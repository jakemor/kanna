export type ShareMode = false | "quick" | {
  kind: "token"
  token: string
}

export function isShareEnabled(share: ShareMode): share is Exclude<ShareMode, false> {
  return share !== false
}

export function isTokenShareMode(share: ShareMode): share is { kind: "token"; token: string } {
  return typeof share === "object" && share !== null && share.kind === "token"
}
