import { Flower, PanelLeft } from "lucide-react"
import { Button } from "../components/ui/button"
import { cn } from "../lib/utils"

/**
 * The flower and expand button a browser shows top-left while the sidebar is
 * collapsed on the projects and settings pages. They fade in as the sidebar
 * slides away. The Mac app hides them: it pins its own toggle beside the
 * traffic lights (KannaSidebar).
 */
export function SidebarExpandControls({ onExpand, className }: { onExpand: () => void; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1 mac-app:hidden transition-opacity duration-200 ease-out starting:opacity-0", className)}>
      <Flower className="size-6 text-logo" />
      <Button
        variant="ghost"
        size="icon"
        onClick={onExpand}
        title="Expand sidebar"
        className="hover:!border-border/0 hover:!bg-transparent"
      >
        <PanelLeft className="h-5 w-5" />
      </Button>
    </div>
  )
}
