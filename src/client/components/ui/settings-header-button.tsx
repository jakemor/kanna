import type { ButtonHTMLAttributes, ReactNode } from "react"
import { cn } from "../../lib/utils"
import { buttonVariants } from "./button"

type SettingsHeaderButtonVariant = "default" | "outline"

type SettingsHeaderButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  variant?: SettingsHeaderButtonVariant
}

export function SettingsHeaderButton({
  children,
  className,
  icon,
  type = "button",
  variant = "outline",
  ...props
}: SettingsHeaderButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        buttonVariants({ variant, size: "sm" }),
        "h-auto gap-1.5 px-3 py-1.5",
        className
      )}
      {...props}
    >
      {icon}
      {children ? <span>{children}</span> : null}
    </button>
  )
}
