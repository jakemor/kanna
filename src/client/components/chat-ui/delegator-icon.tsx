/**
 * The delegator's mark: a compass, for the chat that sets the direction and
 * leaves the travelling to the chats under it. Defined here and nowhere
 * else, so every place it is drawn (the menu item that switches a chat's
 * role, the command palette) changes together. The navbar's button wears it
 * too (`DelegatedListButton`). The iOS app draws the same symbol.
 *
 * Not on a chat's row or tab: with Delegator mode most chats are delegators,
 * so it would mark nearly every one and push out the harness or project
 * icon. Nor on the pane the navbar's button opens, or the title beside that
 * button: on a delegator's page the compass was once drawn four times.
 *
 * Lucide's own, unaltered: drawn at 14px in the menus and 16px in the
 * navbar, at the stroke those places give their other icons.
 *
 * Not the Workflow tool's icon, which is Lucide's `Workflow` and stays so.
 */
export { Compass as DelegatorIcon } from "lucide-react"
