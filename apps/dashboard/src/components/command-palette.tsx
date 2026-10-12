import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useEffect } from "react";
import { queries } from "@/api/queries";
import { PROJECT_SCREENS } from "./nav";
import { rememberProject, useCurrentProjectId } from "./project-context";

export function useCommandPaletteHotkey(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
}

const itemClass =
  "flex cursor-pointer items-center justify-between rounded px-3 py-2 text-body text-fg-secondary data-[selected=true]:bg-hover data-[selected=true]:text-fg";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const projectId = useCurrentProjectId();
  const projects = useQuery({ ...queries.projects(), enabled: open });
  const tickets = useQuery({ ...queries.board(projectId), enabled: open });

  const go = (fn: () => Promise<void>) => {
    onOpenChange(false);
    void fn();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[18vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-card border border-border-strong bg-surface shadow-2xl"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command label="Command palette" loop>
            <Command.Input
              autoFocus
              placeholder="Jump to a screen, project or ticket…"
              className="h-11 w-full border-border-subtle border-b bg-transparent px-4 text-body text-fg outline-none placeholder:text-fg-muted"
            />
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-body text-fg-muted">
                No match.
              </Command.Empty>
              <Command.Group heading="Navigate" className="text-caption text-fg-muted">
                <Command.Item
                  className={itemClass}
                  onSelect={() => go(() => navigate({ to: "/" }))}
                >
                  Overview
                </Command.Item>
                {PROJECT_SCREENS.map((screen) => (
                  <Command.Item
                    key={screen.to}
                    className={itemClass}
                    onSelect={() => go(() => navigate({ to: screen.to, params: { projectId } }))}
                  >
                    {screen.label}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Projects" className="text-caption text-fg-muted">
                {projects.data?.map((project) => (
                  <Command.Item
                    key={project.id}
                    value={`project ${project.name}`}
                    className={itemClass}
                    onSelect={() =>
                      go(() => {
                        rememberProject(project.id);
                        return navigate({
                          to: "/p/$projectId/board",
                          params: { projectId: project.id },
                        });
                      })
                    }
                  >
                    {project.name}
                    <span className="font-mono text-caption text-fg-muted">
                      {project.workspace}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Tickets" className="text-caption text-fg-muted">
                {tickets.data?.map((ticket) => (
                  <Command.Item
                    key={ticket.id}
                    value={`${ticket.id} ${ticket.title}`}
                    className={itemClass}
                    onSelect={() =>
                      go(() =>
                        ticket.runId
                          ? navigate({
                              to: "/p/$projectId/runs/$runId",
                              params: { projectId, runId: ticket.runId },
                            })
                          : navigate({ to: "/p/$projectId/board", params: { projectId } }),
                      )
                    }
                  >
                    <span className="truncate">{ticket.title}</span>
                    <span className="font-mono text-caption text-fg-muted">{ticket.id}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
