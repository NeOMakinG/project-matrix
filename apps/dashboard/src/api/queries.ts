import { queryOptions } from "@tanstack/react-query";
import { endpoints } from "./endpoints";

export const queries = {
  session: () => queryOptions({ queryKey: ["session"], queryFn: endpoints.session, retry: false }),
  overview: () => queryOptions({ queryKey: ["overview"], queryFn: endpoints.overview }),
  gateway: () =>
    queryOptions({ queryKey: ["gateway"], queryFn: endpoints.gateway, refetchInterval: 30_000 }),
  projects: () => queryOptions({ queryKey: ["projects"], queryFn: endpoints.projects }),
  project: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId],
      queryFn: () => endpoints.project(projectId),
    }),
  board: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "board"],
      queryFn: () => endpoints.board(projectId),
    }),
  runs: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "runs"],
      queryFn: () => endpoints.runs(projectId),
    }),
  run: (runId: string) =>
    queryOptions({ queryKey: ["runs", runId], queryFn: () => endpoints.run(runId) }),
  knowledge: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "knowledge"],
      queryFn: () => endpoints.knowledge(projectId),
    }),
  init: (sessionId: string) =>
    queryOptions({ queryKey: ["init", sessionId], queryFn: () => endpoints.init(sessionId) }),
  monitor: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "monitor"],
      queryFn: () => endpoints.monitor(projectId),
      refetchInterval: 60_000,
    }),
  settings: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "settings"],
      queryFn: () => endpoints.settings(projectId),
    }),
  keys: () => queryOptions({ queryKey: ["keys"], queryFn: endpoints.keys }),
  integrations: () => queryOptions({ queryKey: ["integrations"], queryFn: endpoints.integrations }),
};
