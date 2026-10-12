import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import { queries } from "@/api/queries";
import { PROJECT_SCREENS } from "./nav";
import { useCurrentProjectId } from "./project-context";
import { Pill } from "./ui/pill";

const navClass =
  "group flex h-8 items-center gap-2.5 rounded-control px-2.5 text-body text-fg-secondary hover:bg-hover hover:text-fg data-[status=active]:bg-hover data-[status=active]:text-fg";
const iconClass = "size-4 text-fg-muted group-data-[status=active]:text-accent";

export function gatewayTone(healthy: number, total: number): "green" | "amber" | "red" {
  if (healthy === 0) return "red";
  return healthy / total >= 0.75 ? "green" : "amber";
}

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const projectId = useCurrentProjectId();
  const gateway = useQuery(queries.gateway());
  return (
    <div className="w-60 shrink-0 border-border-subtle border-r bg-surface">
      <aside className="sticky top-0 flex h-screen flex-col px-4 py-5">
        <div className="flex items-center gap-2 px-1">
          <span aria-hidden className="size-4 rounded bg-accent" />
          <span className="text-title font-semibold">matrix</span>
          <span className="font-mono text-caption text-fg-muted">v0.1</span>
        </div>

        <button
          type="button"
          onClick={onOpenPalette}
          className="mt-5 flex h-9 items-center justify-between rounded-control border border-border-strong bg-canvas px-3 text-body text-fg hover:bg-hover"
        >
          <span className="truncate">{projectId}</span>
          <kbd className="font-mono text-caption text-fg-muted">⌘K</kbd>
        </button>

        <nav aria-label="Main" className="mt-5 flex flex-col gap-1">
          <Link to="/" activeOptions={{ exact: true }} className={navClass}>
            <LayoutDashboard className={iconClass} />
            Overview
          </Link>
          {PROJECT_SCREENS.map(({ label, to, icon: Icon }) => (
            <Link key={to} to={to} params={{ projectId }} className={navClass}>
              <Icon className={iconClass} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto rounded-control border border-border-subtle bg-raised px-3 py-3">
          <div className="font-mono text-caption text-fg-muted">
            Gateway · {gateway.data?.address ?? "…"}
          </div>
          {gateway.data ? (
            <Pill tone={gatewayTone(gateway.data.healthy, gateway.data.total)} className="mt-2">
              {gateway.data.healthy} of {gateway.data.total} models healthy
            </Pill>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
