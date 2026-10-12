import type { Tone } from "@/api/schemas";
import { cn } from "@/lib/cn";

const toneClass: Record<Tone, string> = {
  green: "bg-accent-dim text-accent",
  blue: "bg-info-dim text-info",
  amber: "bg-warn-dim text-warn",
  red: "bg-danger-dim text-danger",
  violet: "bg-violet-dim text-violet",
  neutral: "bg-raised text-fg-secondary",
};

const dotClass: Record<Tone, string> = {
  green: "bg-accent",
  blue: "bg-info",
  amber: "bg-warn",
  red: "bg-danger",
  violet: "bg-violet",
  neutral: "bg-fg-muted",
};

export function Pill({
  tone,
  children,
  className,
  dot = true,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-label",
        toneClass[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dotClass[tone])} /> : null}
      {children}
    </span>
  );
}
