import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function Select({
  value,
  onValueChange,
  options,
  label,
  highlight = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly string[];
  label: string;
  highlight?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          "inline-flex h-7 items-center gap-2 rounded-control border bg-raised px-2.5 font-mono text-caption text-fg hover:bg-hover",
          highlight ? "border-accent" : "border-border-strong",
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3 text-fg-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-control border border-border-strong bg-raised p-1 shadow-xl"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option}
                value={option}
                className="relative flex cursor-pointer select-none items-center rounded py-1.5 pr-2 pl-6 font-mono text-caption text-fg outline-none data-[highlighted]:bg-hover"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-1.5">
                  <Check className="size-3 text-accent" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
