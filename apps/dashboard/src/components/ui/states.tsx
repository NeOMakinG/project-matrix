import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-control bg-raised", className)} />;
}

export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-8 w-72" />
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-card border border-danger/30 bg-danger-dim/40 p-6"
    >
      <div className="flex items-center gap-2 text-heading text-danger">
        <AlertTriangle className="size-4" />
        Couldn't load this view
      </div>
      <p className="font-mono text-caption text-fg-secondary">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-border-subtle border-dashed p-10 text-center">
      <Inbox className="size-5 text-fg-muted" />
      <div className="text-heading text-fg">{title}</div>
      <p className="max-w-sm text-body text-fg-secondary">{hint}</p>
    </div>
  );
}

export function QueryView<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <PageSkeleton />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
