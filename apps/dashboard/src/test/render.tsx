import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { makeRouter } from "@/router";

const clients = new Set<QueryClient>();

export async function clearRenderedRoutes() {
  await Promise.all([...clients].map((client) => client.cancelQueries()));
  for (const client of clients) client.clear();
  clients.clear();
}

export function renderRoute(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  clients.add(queryClient);
  const router = makeRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
