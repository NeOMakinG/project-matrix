import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-label font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-canvas hover:bg-accent/90",
        secondary: "border border-border-strong bg-surface text-fg hover:bg-hover",
        ghost: "text-fg-secondary hover:bg-hover hover:text-fg",
        danger: "border border-danger/40 bg-danger-dim text-danger hover:bg-danger/20",
      },
      size: { sm: "h-7 px-2.5", md: "h-8 px-3", lg: "h-9 px-4" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
