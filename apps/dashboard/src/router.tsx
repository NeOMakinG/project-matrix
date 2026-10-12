import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { useState } from "react";
import { CommandPalette, useCommandPaletteHotkey } from "./components/command-palette";
import { rememberProject } from "./components/project-context";
import { Sidebar } from "./components/sidebar";
import { EmptyState } from "./components/ui/states";
import { BoardPage } from "./features/board/board-page";
import { InitPage } from "./features/init/init-page";
import { MonitorPage } from "./features/monitor/monitor-page";
import { OverviewPage } from "./features/overview/overview-page";
import { RunPage } from "./features/runs/run-page";
import { RunsPage } from "./features/runs/runs-page";
import { SettingsPage } from "./features/settings/settings-page";

function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(paletteOpen, setPaletteOpen);
  return (
    <div className="flex min-h-full">
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      <main className="min-w-0 flex-1 px-8 py-8">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  notFoundComponent: () => (
    <EmptyState title="Nothing here" hint="That page doesn't exist. Use ⌘K to jump somewhere." />
  ),
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  beforeLoad: ({ params }) => rememberProject(params.projectId),
});

const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/board",
  component: BoardPage,
});
const runsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs",
  component: RunsPage,
});
const runRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs/$runId",
  component: RunPage,
});
const initRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/init",
  component: InitPage,
});
const knowledgeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/knowledge",
  component: lazyRouteComponent(
    () => import("./features/knowledge/knowledge-page"),
    "KnowledgePage",
  ),
});
const monitorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/monitor",
  component: MonitorPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  projectRoute.addChildren([
    boardRoute,
    runsRoute,
    runRoute,
    initRoute,
    knowledgeRoute,
    monitorRoute,
    settingsRoute,
  ]),
]);

export function makeRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
