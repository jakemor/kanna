// Browser regression fixture: exercised by scripts/test-sidebar-order.cjs.
import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { SortableChatList, useChatOrder } from "./SortableChatList"
import { getVisibleSidebarChats } from "../../../app/sidebarNumberJump"
const items = ["recent-a", "recent-b", "old"].map(chatId => ({ chatId }))
function Fixture() {
  const [expanded, setExpanded] = useState(true)
  const [selected, select] = useState("")
  const orders = useChatOrder(s => s.orders)
  const visible = getVisibleSidebarChats([{ groupKey: "test", previewChats: items.slice(0, 2), olderChats: items.slice(2) } as any], new Set(), new Set(expanded ? ["test"] : []), orders)
  return <div onKeyDown={e => { if (/^[1-3]$/.test(e.key)) select(visible[Number(e.key) - 1]?.chat.chatId ?? "") }}>
    <button onClick={() => setExpanded(!expanded)}>Toggle preview</button>
    <SortableChatList items={items} orderKey="project:test" limit={expanded ? undefined : 2} renderItem={item => <div style={{ height: 50 }} data-task={item.chatId}>{item.chatId}</div>} />
    <output>{selected}</output>
  </div>
}
createRoot(document.getElementById("root")!).render(<Fixture />)
