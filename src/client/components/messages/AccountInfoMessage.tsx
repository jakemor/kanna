import { useState } from "react"
import { ChevronRight } from "lucide-react"
import type { ProcessedAccountInfoMessage } from "./types"
import { MetaCodeBlock, MetaRow, VerticalLineContainer } from "./shared"
import { cn } from "../../lib/utils"

interface Props {
  message: ProcessedAccountInfoMessage
}

const TOKEN_SOURCE_LABEL: Record<string, string> = {
  "kanna-oauth-pool": "Pool token",
  "claude-pro": "Claude Pro",
  "claude-max": "Claude Max",
}

function describeSource(tokenSource?: string, apiKeySource?: string): string | null {
  if (tokenSource) return TOKEN_SOURCE_LABEL[tokenSource] ?? tokenSource
  if (apiKeySource) return `API key (${apiKeySource})`
  return null
}

export function AccountInfoMessage({ message }: Props) {
  const { organization, tokenSource, apiKeySource, subscriptionType, email } = message.accountInfo
  const primaryKey = organization ?? email ?? "Unknown account"
  const sourceLabel = describeSource(tokenSource, apiKeySource)
  const [expanded, setExpanded] = useState(false)

  return (
    <MetaRow>
      <div className="flex w-full flex-col">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="group/account flex w-full items-center gap-2.5 text-left transition-opacity hover:opacity-80 focus-visible:opacity-100"
        >
          <span className="text-[12px] font-medium text-muted-foreground">
            Account
          </span>
          <span className="h-3 w-px bg-border/60" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium leading-snug text-foreground">
            {primaryKey}
          </span>
          {sourceLabel ? (
            <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground sm:inline">
              {sourceLabel}
            </span>
          ) : null}
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-90"
            )}
            aria-hidden
          />
        </button>
        {sourceLabel ? (
          <span className="mt-0.5 text-[11px] text-muted-foreground sm:hidden">
            {sourceLabel}
          </span>
        ) : null}
        {expanded ? (
          <VerticalLineContainer className="mt-3 mb-2 text-xs">
            <div className="flex flex-col gap-3">
              <MetaCodeBlock label="OAuth key" copyText={primaryKey}>
                <code className="block text-xs whitespace-pre-wrap break-all">{primaryKey}</code>
              </MetaCodeBlock>
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5">
                {sourceLabel ? (
                  <>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="text-foreground/90">{sourceLabel}</dd>
                  </>
                ) : null}
                {subscriptionType ? (
                  <>
                    <dt className="text-muted-foreground">Plan</dt>
                    <dd className="text-foreground/90">{subscriptionType}</dd>
                  </>
                ) : null}
                {email ? (
                  <>
                    <dt className="text-muted-foreground">Email</dt>
                    <dd className="font-mono break-all text-foreground/90">{email}</dd>
                  </>
                ) : null}
                {organization && organization !== primaryKey ? (
                  <>
                    <dt className="text-muted-foreground">Organization</dt>
                    <dd className="text-foreground/90">{organization}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </VerticalLineContainer>
        ) : null}
      </div>
    </MetaRow>
  )
}
