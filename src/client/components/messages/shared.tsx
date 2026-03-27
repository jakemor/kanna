import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"
import { Button } from "../ui/button"
import {
  ArrowDownToLine,
  CheckLine,
  ChevronRight,
  ListTodo,
  Map,
  MessageCircleQuestion,
  Pencil,
  Search,
  Sparkles,
  SquareX,
  Terminal,
  ToyBrick,
  type LucideIcon,
  File,
  FilePen,
  FilePlusCorner,
  Copy,
  Check,
} from "lucide-react"
import { cn } from "../../lib/utils"
import { parseLocalFileLink } from "../../lib/pathUtils"

type OpenLocalLinkTarget = { path: string; line?: number; column?: number }
type OpenLocalLinkHandler = (target: OpenLocalLinkTarget) => void

const defaultOpenLocalLink: OpenLocalLinkHandler = () => {}

const OpenLocalLinkContext = createContext<OpenLocalLinkHandler>(defaultOpenLocalLink)

export function OpenLocalLinkProvider({
  children,
  onOpenLocalLink,
}: {
  children: ReactNode
  onOpenLocalLink?: OpenLocalLinkHandler
}) {
  return (
    <OpenLocalLinkContext.Provider value={onOpenLocalLink ?? defaultOpenLocalLink}>
      {children}
    </OpenLocalLinkContext.Provider>
  )
}

// Tool icon mapping - shared between ToolCallMessage and SystemMessage
export const toolIcons: Record<string, LucideIcon> = {
  Task: ListTodo,
  TaskOutput: ListTodo,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
  ExitPlanMode: Map,
  Read: File,
  Edit: FilePen,
  Write: FilePlusCorner,
  NotebookEdit: Pencil,
  WebFetch: ArrowDownToLine,
  TodoWrite: CheckLine,
  WebSearch: Search,
  KillShell: SquareX,
  AskUserQuestion: MessageCircleQuestion,
  Skill: Sparkles,
  EnterPlanMode: Map,
}

export const defaultToolIcon: LucideIcon = ToyBrick

// Get icon for a tool.
export function getToolIcon(toolName: string): LucideIcon {
  if (toolIcons[toolName]) {
    return toolIcons[toolName]
  }
  return defaultToolIcon
}

// Container for meta-style messages (system, tool, result)
export function MetaRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-3 justify-start items-center", className)}>
      {children}
    </div>
  )
}

// Content row with consistent text styling
export function MetaContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      {children}
    </div>
  )
}

// Separator pipe
export function MetaSeparator() {
  return <span className="text-muted-foreground">|</span>
}

// Bold label text
export function MetaLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-medium text-foreground/80", className)}>{children}</span>
}

// Muted text
export function MetaText({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

// Expandable row with chevron
interface ExpandableRowProps {
  children: ReactNode
  expandedContent: ReactNode
  defaultExpanded?: boolean
}

export function ExpandableRow({ children, expandedContent, defaultExpanded = false }: ExpandableRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className="flex flex-col w-full">

      <button
        onClick={() => setExpanded(!expanded)}
        className={`group/expandable-row cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-sm ${!expanded ? "hover:opacity-60 transition-opacity" : ""}`}
      >
        <div className="grid grid-cols-[auto_1fr] items-center gap-1.5">
          {children}
        </div>
        <ChevronRight
          className={`h-4.5 w-4.5 text-muted-icon translate-y-[0.5px] transition-all duration-200 opacity-0 group-hover/expandable-row:opacity-100 ${expanded ? "rotate-90 opacity-100" : ""}`}
        />
      </button>
      {expanded && expandedContent}
    </div>
  )
}

// Code block for expanded content
export function MetaCodeBlock({ label, children, copyText }: { label: ReactNode; children: ReactNode; copyText?: string }) {
  const [copied, setCopied] = useState(false)
  const textContent = copyText ?? extractText(children)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(textContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [textContent])

  return (
    <div>
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="relative group/codeblock">
        <pre className="my-1 text-xs font-mono whitespace-no-wrap break-all bg-muted border border-border  rounded-lg p-2 max-h-64 overflow-auto w-full">
          {children}
        </pre>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "absolute top-[4px] right-[4px] z-10 h-6.5 w-6.5 rounded-sm text-muted-foreground opacity-0 group-hover/codeblock:opacity-100 transition-opacity",
            !copied && "hover:text-foreground",
            copied && "hover:!bg-transparent hover:!border-transparent"
          )}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

// Pill/badge for tags
export function MetaPill({ children, icon: Icon, className }: { children: ReactNode; icon?: LucideIcon; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-1 bg-muted border border-border  rounded-full", className)}>
      {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
      {children}
    </span>
  )
}

// Container with vertical line on the left
export function VerticalLineContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[auto_1fr] gap-2 min-w-0", className)}>
      <div className=" min-w-5 flex flex-col relative items-center justify-center">
        <div className="min-h-full w-[1px] bg-muted-foreground/20" />
      </div>
      <div className="-ml-[1px] min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

// Helper function to extract text content from ReactNode
function extractText(node: ReactNode): string {
  if (typeof node === "string") {
    return node
  }
  if (typeof node === "number") {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("")
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as { children?: ReactNode }
    return extractText(props.children)
  }
  return ""
}

type MarkdownChildNode = ReturnType<typeof Children.toArray>[number]

function withChildClassName(node: MarkdownChildNode, className: string): MarkdownChildNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node
  }

  return cloneElement(node, {
    className: cn(node.props.className, className),
  })
}

// Markdown component overrides
export const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="text-[20px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-[18px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h4>
  ),
  h5: ({ children }: { children?: ReactNode }) => (
    <h5 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h5>
  ),
  h6: ({ children }: { children?: ReactNode }) => (
    <h6 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h6>
  ),

  pre: ({ children, ...props }: ComponentPropsWithoutRef<"pre">) => {
    const [copied, setCopied] = useState(false)
    const textContent = extractText(children)

    const handleCopy = async () => {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="relative overflow-x-auto max-w-full min-w-0 no-code-highlight group/pre">
        <pre className="min-w-0 rounded-xl py-2.5 px-3.5 [.no-pre-highlight_&]:bg-background" {...props}>{children}</pre>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "absolute top-[35px] -translate-y-[50%] -translate-x-[1px] rounded-md right-1.5 h-8 w-8 text-muted-foreground opacity-0 group-hover/pre:opacity-100 transition-opacity",
            !copied && "hover:text-foreground",
            copied && "hover:!bg-transparent hover:!border-transparent"
          )}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    )
  },

  code: ({ children, className, ...props }: ComponentPropsWithoutRef<"code">) => {
    const isInline = !className
    if (isInline) {
      return <code className="break-all px-1 bg-border/60 dark:[.no-pre-highlight_&]:bg-background dark:[.text-pretty_&]:bg-neutral [.no-code-highlight_&]:!bg-transparent py-0.5 rounded text-sm whitespace-wrap" {...props}>{children}</code>
    }
    return (
      <code className="block text-xs whitespace-pre" {...props}>
        {children}
      </code>
    )
  },

  table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="border border-border  rounded-xl overflow-x-auto">
      <table className="table-auto min-w-full divide-y divide-border bg-background" {...props}>{children}</table>
    </div>
  ),

  tbody: ({ children, ...props }: ComponentPropsWithoutRef<"tbody">) => (
    <tbody className="divide-y divide-border" {...props}>{children}</tbody>
  ),

  th: ({ children, ...props }: ComponentPropsWithoutRef<"th">) => (
    <th className="text-left text-xs uppercase text-muted-foreground tracking-wider p-2 pl-0 first:pl-3 bg-muted dark:bg-card [&_*]:font-semibold" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<"td">) => (
    <td className="text-left    p-2 pl-0 first:pl-3 [&_*]:font-normal " {...props}>{children}</td>
  ),

  p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
    <p className="break-words mt-5 mb-3 first:mt-0 last:mb-0" {...props}>{children}</p>
  ),

  blockquote: ({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) => (
    (() => {
      const childNodes = Children.toArray(children)

      const firstChild = childNodes[0]
      if (firstChild !== undefined) {
        childNodes[0] = withChildClassName(firstChild, "mt-0")
      }

      const lastIndex = childNodes.length - 1
      const lastChild = childNodes[lastIndex]
      if (lastChild !== undefined) {
        childNodes[lastIndex] = withChildClassName(lastChild, "mb-0")
      }

      return (
        <blockquote
          className="my-2 mt-5 mb-3 first:mt-0 last:mb-0 border-l-2 border-border/80 pl-2 text-muted-foreground"
          {...props}
        >
          {childNodes}
        </blockquote>
      )
    })()
  ),

  a: ({ children, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40 "
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
}

export function createMarkdownComponents(options?: {
  onOpenLocalLink?: OpenLocalLinkHandler
}) {
  return {
    ...markdownComponents,
    a: ({ children, href, onClick, ...props }: ComponentPropsWithoutRef<"a">) => {
      const onOpenLocalLink = options?.onOpenLocalLink ?? useContext(OpenLocalLinkContext)
      const parsedLocalLink = parseLocalFileLink(href)

      return (
        <a
          className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40 "
          href={href}
          target={parsedLocalLink ? undefined : "_blank"}
          rel={parsedLocalLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event)
            if (event.defaultPrevented || !parsedLocalLink || onOpenLocalLink === defaultOpenLocalLink) return
            event.preventDefault()
            onOpenLocalLink(parsedLocalLink)
          }}
          {...props}
        >
          {children}
        </a>
      )
    },
  }
}

export const markdownWithHeadingsComponents = {
  ...markdownComponents,
}
