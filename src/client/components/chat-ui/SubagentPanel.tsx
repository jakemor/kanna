import { useEffect, useMemo, useState } from "react"
import { Network } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import type { TranscriptEntry } from "../../../shared/types"
import { formatDuration } from "../messages/ResultMessage"

export function collectSubagents(entries: TranscriptEntry[], active: boolean) {
  const agents = new Map<string, {id:string; name:string; model:string; startedAt:number; endedAt?:number; status:string}>()
  for (const entry of entries) {
    if (entry.parentToolUseId) continue
    if (entry.kind === "tool_call" && entry.tool.toolKind === "subagent_task") {
      const input = entry.tool.input as Record<string, unknown>
      agents.set(entry.tool.toolId, {id:entry.tool.toolId, name:String(input.subagentType || input.description || "Subagents"), model:typeof input.model === "string" ? input.model : "Not reported", startedAt:entry.createdAt, status:active ? "Running" : "Unconfirmed"})
    }
    if (entry.kind === "tool_result") {
      const agent=agents.get(entry.toolId)
      if(agent){agent.endedAt=entry.createdAt;agent.status=entry.isError ? "Failed / interrupted" : "Completed"}
    }
    if (entry.kind === "result" || entry.kind === "interrupted" || (entry.kind === "user_prompt" && !entry.steered)) {
      for(const agent of agents.values())if(!agent.endedAt){agent.endedAt=entry.createdAt;agent.status="Unconfirmed"}
    }
  }
  return [...agents.values()]
}
export function SubagentPanel({entries, active}:{entries:TranscriptEntry[];active:boolean}) {
  const [now,setNow]=useState(Date.now)
  const [open, setOpen] = useState(false)
  const agents=useMemo(() => collectSubagents(entries,active), [entries,active])
  const running=agents.filter(a=>a.status==="Running")
  useEffect(()=>{if(!open || !running.length)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[running.length,open])
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" aria-label={`Subagent activity, ${running.length} running`} className="flex shrink-0 items-center gap-1 rounded-lg p-2 text-muted-foreground hover:bg-muted"><Network size={18}/><span className="text-xs tabular-nums">{running.length}</span></button></PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-[min(400px,calc(100vw-24px))] p-4">
      <div className="mb-3 flex items-center justify-between"><strong>Subagents</strong><span className="text-xs text-muted-foreground">{running.length} running</span></div>
      {!agents.length ? <p className="text-sm text-muted-foreground">No subagent activity in the loaded conversation</p> : <div className="max-h-72 overflow-y-auto space-y-3">{[...agents].sort((a,b)=>Number(b.status==="Running")-Number(a.status==="Running")).map(agent=><div key={agent.id} className="rounded-xl border p-3 text-sm">
        <div className="flex justify-between gap-2"><span className="truncate font-medium">{agent.name}</span><span className="shrink-0 text-xs text-muted-foreground">{agent.status}</span></div>
        <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground"><span>Model: {agent.model}</span><span className="shrink-0 tabular-nums">{agent.status==="Unconfirmed" ? "Duration unknown" : formatDuration(Math.max(0, (agent.endedAt??now)-agent.startedAt))}</span></div>
      </div>)}</div>}
      <p className="mt-3 text-xs text-muted-foreground">Based on loaded task records. Models and unresolved status are not inferred.</p>
    </PopoverContent></Popover>
}
