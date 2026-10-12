import { cn } from "@/lib/cn";

export function Card({ className, children, ...rest }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-card border border-border-subtle bg-surface", className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  meta,
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-center justify-between gap-4 px-4 pt-4 pb-3", className)}>
      <h2 className="text-title font-semibold text-fg">{title}</h2>
      {typeof meta === "string" ? (
        <div className="font-mono text-caption text-fg-muted">{meta}</div>
      ) : (
        meta
      )}
    </header>
  );
}

export function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="px-4 py-4">
      <div className="text-caption text-fg-secondary">{label}</div>
      <div className="mt-2 font-mono text-stat font-medium text-fg">{value}</div>
      <div className="mt-1 text-caption text-fg-muted">{note}</div>
    </Card>
  );
}
