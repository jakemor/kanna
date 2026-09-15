import { useMemo, type ReactNode } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core"
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"

const useChatOrder = create(persist<{
  orders: Record<string, string[]>
  save: (key: string, ids: string[]) => void
  reset: (key: string) => void
}>((set) => ({
  orders: {},
  save: (key, ids) => set(state => ({orders:{...state.orders,[key]:ids}})),
  reset: key => set(state => {const orders={...state.orders};delete orders[key];return {orders}}),
}), {name:"kanna-sidebar-chat-order"}))

export function applyChatOrder<T extends {chatId:string}>(items:T[], order?:string[]):T[] {
  if (!order?.length) return items
  const rank=new Map(order.map((id,index)=>[id,index]))
  return [...items].sort((a,b)=>(rank.get(a.chatId)??Infinity)-(rank.get(b.chatId)??Infinity))
}

function SortableRow({id, children}:{id:string;children:ReactNode}) {
  const {attributes,listeners,setNodeRef,setActivatorNodeRef,transform,transition,isDragging}=useSortable({id})
  return <div ref={setNodeRef} className="group/order flex min-w-0 items-center rounded-md" style={{transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1}}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label="Reorder task" title="Drag to reorder; press Space then use arrow keys to reorder with the keyboard" className="shrink-0 touch-none cursor-grab rounded p-0.5 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing" onClick={event=>event.stopPropagation()}><GripVertical size={14}/></button>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
}

export function SortableChatList<T extends {chatId:string}>({items,orderKey,renderItem,limit}:{items:T[];orderKey:string;renderItem:(item:T)=>ReactNode;limit?:number}) {
  const order=useChatOrder(state=>state.orders[orderKey])
  const save=useChatOrder(state=>state.save)
  const reset=useChatOrder(state=>state.reset)
  const ordered=useMemo(()=>applyChatOrder(items,order),[items,order])
  const visible=limit===undefined?ordered:ordered.slice(0,limit)
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates}))
  return <div>
    {order && <button className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground" type="button" onClick={()=>reset(orderKey)}>Reset order</button>}
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({active,over})=>{
      if(!over||active.id===over.id)return
      const ids=ordered.map(item=>item.chatId)
      const from=ids.indexOf(String(active.id)),to=ids.indexOf(String(over.id))
      if(from>=0&&to>=0)save(orderKey,arrayMove(ids,from,to))
    }}><SortableContext items={visible.map(item=>item.chatId)} strategy={verticalListSortingStrategy}>
      {visible.map(item=><SortableRow key={item.chatId} id={item.chatId}>{renderItem(item)}</SortableRow>)}
    </SortableContext></DndContext>
  </div>
}
