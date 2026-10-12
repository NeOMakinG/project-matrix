import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const queries = {
  overview: () => queryOptions({ queryKey: ["overview"], queryFn: api.overview }),
  gateway: () =>
    queryOptions({ queryKey: ["gateway"], queryFn: api.gateway, refetchInterval: 30_000 }),
  projects: () => queryOptions({ queryKey: ["projects"], queryFn: api.projects }),
  project: (id: string) =>
    queryOptions({ queryKey: ["projects", id], queryFn: () => api.project(id) }),
  tickets: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "tickets"],
      queryFn: () => api.tickets(projectId),
    }),
  runs: (projectId: string) =>
    queryOptions({ queryKey: ["projects", projectId, "runs"], queryFn: () => api.runs(projectId) }),
  run: (runId: string) =>
    queryOptions({ queryKey: ["runs", runId], queryFn: () => api.run(runId) }),
  knowledge: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "knowledge"],
      queryFn: () => api.knowledge(projectId),
    }),
  initSession: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "init"],
      queryFn: () => api.initSession(projectId),
    }),
  monitor: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "monitor"],
      queryFn: () => api.monitor(projectId),
      refetchInterval: 60_000,
    }),
  settings: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "settings"],
      queryFn: () => api.settings(projectId),
    }),
};
