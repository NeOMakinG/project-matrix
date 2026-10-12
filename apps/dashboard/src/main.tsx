import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeRouter } from "./router";

/**
 * Mocks only with an explicit opt-in in dev. `import.meta.env.DEV` is false in
 * production builds, so this branch and the MSW import are removed entirely.
 */
async function enableMocks(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === "1") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledFrame: "bypass", quiet: true });
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});
const router = makeRouter(queryClient);

void enableMocks().then(() => {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
