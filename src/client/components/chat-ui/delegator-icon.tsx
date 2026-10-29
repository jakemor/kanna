/**
 * The delegator's mark: a compass, for the chat that sets the direction and
 * leaves the travelling to the chats under it. Defined here and nowhere
 * else, so every place a delegator is marked (its row, its tab, the delegate
 * control, the menu items, the command palette) changes together. The
 * navbar's button wears it too (`DelegatedListButton`). The iOS app draws
 * the same symbol.
 *
 * Each place says it once. The pane the navbar's button opens is not
 * marked, nor is the title beside that button: on a delegator's page the
 * compass was drawn four times.
 *
 * Lucide's own, unaltered: drawn at 14px in the delegate control and the
 * menus and 16px in a row and the navbar, at the stroke those places give
 * their other icons.
 *
 * Not the Workflow tool's icon, which is Lucide's `Workflow` and stays so.
 */
export { Compass as DelegatorIcon } from "lucide-react"
