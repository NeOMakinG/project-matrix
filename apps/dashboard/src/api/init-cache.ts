import type { QueryClient } from "@tanstack/react-query";
import { endpoints } from "./endpoints";
import { ApiError, currentSessionGeneration } from "./http";

const generations = new WeakMap<QueryClient, Map<string, number>>();

export function initGeneration(client: QueryClient, sessionId: string): number {
  return generations.get(client)?.get(sessionId) ?? 0;
}

function advanceGeneration(client: QueryClient, sessionId: string): number {
  let sessions = generations.get(client);
  if (!sessions) {
    sessions = new Map();
    generations.set(client, sessions);
  }
  const generation = initGeneration(client, sessionId) + 1;
  sessions.set(sessionId, generation);
  return generation;
}

export async function reviseInitAnswer(
  client: QueryClient,
  sessionId: string,
  questionId: string,
  value: string | number | boolean | string[],
) {
  const queryKey = ["init", sessionId];
  const identity = currentSessionGeneration();
  let generation = advanceGeneration(client, sessionId);
  const ensureCurrent = () => {
    if (identity !== currentSessionGeneration() || generation !== initGeneration(client, sessionId))
      throw new ApiError(
        409,
        "stale_init",
        "Interview or identity changed; discarded old response",
      );
  };
  await client.cancelQueries({ queryKey, exact: true });
  ensureCurrent();
  const response = await endpoints.reviseAnswer(sessionId, questionId, value);
  ensureCurrent();
  generation = advanceGeneration(client, sessionId);
  await client.cancelQueries({ queryKey, exact: true });
  ensureCurrent();
  client.setQueryData(queryKey, { session: response.session, progress: response.progress });
  return response;
}
