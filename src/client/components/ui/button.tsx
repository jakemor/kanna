import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "touch-manipulation inline-flex items-center justify-center whitespace-nowrap cursor-pointer rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground disabled:bg-primary/50 disabled:text-primary-foreground/90 hover:bg-primary/90",
        juicy: "bg-logo text-primary-foreground disabled:text-primary-foreground/50 hover:bg-logo/90",
        destructive:
          "bg-destructive/80  dark:text-white",
        outline:
          "border disabled:bg-transparent disabled:text-foreground/50 border-inpu disabled:border-input/90 bg-card hover:bg-muted hover:text-accent-foreground",
        secondary:
          "bg-transparent border border-border text-secondary-foreground hover:text-secondary-foreground/60 disabled:text-secondary-foreground/50",
        ghost: "hover:bg-accent dark:hover:bg-card hover:text-accent-foreground text-muted-foreground disabled:text-muted-foreground/50 border border-border/0 hover:border-border",
        link: "text-primary disabled:text-primary/50 underline-offset-4 hover:underline",
        none: "",
      },
      size: {
        default: "h-10 px-4 rounded-full py-2",
        sm: "h-9 rounded-full px-3",
        lg: "h-11 rounded-full px-8",
        icon: "h-9 w-9 rounded-full",
        "icon-sm": "h-5.5 w-5.5 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> { }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
