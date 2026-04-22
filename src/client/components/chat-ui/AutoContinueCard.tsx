import { useMemo, useState } from "react"
import type { AutoContinueSchedule } from "../../../shared/types"
import { formatLocal, parseLocal } from "../../lib/autoContinueTime"
import { Button } from "../ui/button"
import { Input } from "../ui/input"

export interface AutoContinueCardProps {
  schedule: AutoContinueSchedule
  onAccept: (scheduledAtMs: number) => void
  onReschedule: (scheduledAtMs: number) => void
  onCancel: () => void
}

export function AutoContinueCard({ schedule, onAccept, onReschedule, onCancel }: AutoContinueCardProps) {
  const [draft, setDraft] = useState<string>(() => formatLocal(
    schedule.scheduledAt ?? schedule.resetAt,
    schedule.tz,
  ))
  const [editing, setEditing] = useState(false)

  const parsed = useMemo(() => parseLocal(draft, schedule.tz), [draft, schedule.tz])
  const isFuture = parsed !== null && parsed > Date.now()
  const inputInvalid = parsed === null ? "Use format dd/mm/yyyy hh:mm" :
    !isFuture ? "Time must be in the future" : null

  if (schedule.state === "fired") {
    const at = formatLocal(schedule.scheduledAt ?? schedule.resetAt, schedule.tz)
    return <div className="rounded border px-3 py-2 text-sm">Auto-continued at {at}</div>
  }

  if (schedule.state === "cancelled") {
    return <div className="rounded border px-3 py-2 text-sm opacity-70">Auto-continue cancelled</div>
  }

  if (schedule.state === "proposed") {
    const passed = schedule.resetAt <= Date.now()
    return (
      <div className="rounded border px-3 py-2 text-sm space-y-2">
        <div className="font-medium">Rate limit hit — schedule auto-continue?</div>
        {passed && <div className="text-amber-500">Reset time has passed — accept to continue now.</div>}
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="dd/mm/yyyy hh:mm"
        />
        {inputInvalid && <div className="text-xs text-red-500">{inputInvalid}</div>}
        <div className="flex gap-2">
          <Button disabled={!isFuture} onClick={() => parsed !== null && onAccept(parsed)}>Schedule</Button>
          <Button variant="ghost" onClick={onCancel}>Dismiss</Button>
        </div>
      </div>
    )
  }

  // scheduled
  const displayAt = formatLocal(schedule.scheduledAt ?? schedule.resetAt, schedule.tz)
  if (!editing) {
    const tzLabel = schedule.tz === "system" ? "local" : schedule.tz
    return (
      <div className="rounded border px-3 py-2 text-sm flex items-center justify-between gap-2">
        <div>Auto-continue at {displayAt} ({tzLabel})</div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>Change time</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border px-3 py-2 text-sm space-y-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="dd/mm/yyyy hh:mm"
      />
      {inputInvalid && <div className="text-xs text-red-500">{inputInvalid}</div>}
      <div className="flex gap-2">
        <Button disabled={!isFuture} onClick={() => { if (parsed !== null) { onReschedule(parsed); setEditing(false) } }}>Save</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>Back</Button>
      </div>
    </div>
  )
}
