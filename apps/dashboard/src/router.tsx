import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ApiError, onUnauthorized } from "./api/http";
import { queries } from "./api/queries";
import { CommandPalette, useCommandPaletteHotkey } from "./components/command-palette";
import { rememberProject } from "./components/project-context";
import { Sidebar } from "./components/sidebar";
import { EmptyState, PageSkeleton } from "./components/ui/states";

function AppShell() {
  const isLogin = useRouterState({ select: (s) => s.location.pathname === "/login" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(paletteOpen && !isLogin, setPaletteOpen);
  if (isLogin) return <Outlet />;
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
  pendingComponent: PageSkeleton,
  beforeLoad: async ({ context, location }) => {
    if (location.pathname === "/login") return;
    try {
      await context.queryClient.ensureQueryData(queries.session());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
      throw error;
    }
  },
  notFoundComponent: () => (
    <EmptyState title="Nothing here" hint="That page doesn't exist. Use ⌘K to jump somewhere." />
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: lazyRouteComponent(() => import("./features/auth/login-page"), "LoginPage"),
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./features/overview/overview-page"), "OverviewPage"),
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  beforeLoad: ({ params }) => rememberProject(params.projectId),
});

const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/board",
  component: lazyRouteComponent(() => import("./features/board/board-page"), "BoardPage"),
});
const runsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs",
  component: lazyRouteComponent(() => import("./features/runs/runs-page"), "RunsPage"),
});
const runRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs/$runId",
  component: lazyRouteComponent(() => import("./features/runs/run-page"), "RunPage"),
});
const initRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/init",
  validateSearch: z.object({
    session: z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .optional(),
  }),
  component: lazyRouteComponent(() => import("./features/init/init-page"), "InitPage"),
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
  component: lazyRouteComponent(() => import("./features/monitor/monitor-page"), "MonitorPage"),
});
const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./features/settings/settings-page"), "SettingsPage"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
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
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
  onUnauthorized(() => {
    const { pathname, href } = router.state.location;
    if (pathname === "/login") return;
    queryClient.removeQueries({ queryKey: queries.session().queryKey });
    void router.navigate({ to: "/login", search: { redirect: href } });
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
