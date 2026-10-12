import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { endpoints } from "@/api/endpoints";
import { ApiError, currentCsrfToken, toApiError } from "@/api/http";
import { queries } from "@/api/queries";
import { saveSettings } from "@/features/settings/settings-page";
import { mockDb } from "@/mocks/handlers";
import { renderRoute } from "./render";
import { server } from "./server";

describe("auth", () => {
  it("redirects to sign-in without a session and returns after signing in", async () => {
    mockDb().signedIn = false;
    const user = userEvent.setup();
    const { router, queryClient } = renderRoute("/p/ledgerly/monitor");
    await act(async () => {
      await router.load();
    });
    expect(await screen.findByRole("heading", { name: "Sign in to matrix" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("API key"), "mx_live_demo");
    const returned = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe("onResolved", () => {
        if (router.state.location.pathname === "/p/ledgerly/monitor") {
          unsubscribe();
          resolve();
        }
      });
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {
      await returned;
      await queryClient.ensureQueryData(queries.monitor("ledgerly"));
    });
    expect(await screen.findByText("Duplicate invoice on retry")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/ledgerly/monitor");
  });

  it("removes unauthorized listeners when a rendered router unmounts", async () => {
    const view = renderRoute("/");
    await screen.findByRole("heading", { name: "Factory overview" });
    const navigate = vi.spyOn(view.router, "navigate");
    try {
      view.unmount();
      await toApiError(new Response("", { status: 401 }));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      navigate.mockRestore();
    }
  });
});

describe("screens", () => {
  it("overview shows stats, runs, models and Orca health", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(screen.getByText("$38.40")).toBeInTheDocument();
    expect(screen.getByText("bosgame · orca serve v1.4.2")).toBeInTheDocument();
    expect(screen.getByText("MX-142 merge waiting for your approval")).toBeInTheDocument();
    expect(await screen.findByText("3 of 5 models healthy")).toBeInTheDocument();
  });

  it("board groups ship phases and filters by type", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/board");
    expect(await screen.findByRole("region", { name: "Ship column" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 8 phases" }));
    expect(screen.getByRole("region", { name: "Deploy column" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Bugs/ }));
    const implement = screen.getByRole("region", { name: "Implement column" });
    expect(within(implement).getByText("Rename invoice states")).toBeInTheDocument();
    expect(within(implement).queryByText("Tax rates by country")).not.toBeInTheDocument();
  });

  it("board shows an empty state for a project without tickets", async () => {
    renderRoute("/p/wayline/board");
    expect(await screen.findByText("No tickets yet")).toBeInTheDocument();
  });

  it("run detail only renders safe links and approves the exact commit with CSRF", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/runs/r_8f3a2c");
    expect(await screen.findByRole("heading", { name: /MX-142/ })).toBeInTheDocument();
    const orca = screen.getByRole("link", { name: "Open in Orca" });
    expect(orca).toHaveAttribute("href", "orca://worktree/bosgame/pilot-142");
    expect(orca).toHaveAttribute("rel", "noopener noreferrer");
    const plans = screen.getByRole("link", { name: /plans\.png/ });
    expect(plans).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /checkout\.png/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("approved at 3c1e9a2")).toBeInTheDocument();
    expect(mockDb().decisions).toEqual([{ id: "ap_1", decision: "approved" }]);
  });

  it("run with an unsafe workspace link hides Open in Orca", async () => {
    renderRoute("/p/ledgerly/runs/r_bad");
    expect(await screen.findByRole("heading", { name: /MX-144/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open in Orca" })).not.toBeInTheDocument();
    expect(screen.getByText("No approval is waiting for this run.")).toBeInTheDocument();
  });

  it("run detail shows an error state with retry when the API fails", async () => {
    server.use(
      http.get("*/v1/runs/:id", () =>
        HttpResponse.json({ error: { code: "boom", message: "boom" } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/runs/r_8f3a2c");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this view");
    server.resetHandlers();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: /MX-142/ })).toBeInTheDocument();
  });

  it("new project creates the project, starts a session and asks a full round", async () => {
    const user = userEvent.setup();
    const { router } = renderRoute("/new");
    await user.type(await screen.findByPlaceholderText("ledgerly"), "Bad Name");
    await user.click(screen.getByRole("button", { name: "Create and start the interview" }));
    expect(await screen.findByText("Lowercase letters, digits and dashes")).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText("ledgerly"));
    await user.type(screen.getByPlaceholderText("ledgerly"), "shop");
    await user.click(screen.getByRole("button", { name: "Create and start the interview" }));
    expect(
      await screen.findByRole("heading", { name: "shop · Init interview" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/prj_4/init");
    expect(router.state.location.search).toEqual({ session: "init_1" });
    expect(screen.getByRole("heading", { name: "Product name?" })).toBeInTheDocument();

    // Text questions have no recommendation: submitting flags them.
    await user.click(screen.getByRole("button", { name: /^Confirm \d+ answers?$/ }));
    expect((await screen.findAllByText("This question needs an answer.")).length).toBeGreaterThan(
      0,
    );
    for (const input of screen.getAllByRole("textbox")) {
      if ((input as HTMLInputElement).value === "") await user.type(input, "Answer");
    }
    await user.click(screen.getByRole("button", { name: /^Confirm \d+ answers?$/ }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Product name?" })).not.toBeInTheDocument(),
    );
    expect(Object.keys(mockDb().initSessions.get("init_1")?.answers ?? {})).toContain(
      "business.name",
    );
    expect(screen.getByLabelText("matrix.config.ts preview")).toHaveTextContent("react-vite");
  });

  it("knowledge lists ADRs and rule violations", async () => {
    renderRoute("/p/ledgerly/knowledge");
    expect(await screen.findByText("0011 Money as integer cents")).toBeInTheDocument();
    expect(screen.getByText("src/invoices/total.ts:42")).toBeInTheDocument();
    expect(screen.getByText("1 violation")).toBeInTheDocument();
  });

  it("prod monitor shows incidents and verification", async () => {
    renderRoute("/p/ledgerly/monitor");
    expect(await screen.findByText("Duplicate invoice on retry")).toBeInTheDocument();
    expect(screen.getByText("MX-153 · fixing")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /deploy d-118/ })).toBeInTheDocument();
  });
});

describe("settings", () => {
  it("shows a new key token once and forgets it when the dialog closes", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/settings");
    await user.click(await screen.findByRole("button", { name: "New key" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("Name needs at least 2 characters")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. laptop claude-code"), "orca agents");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText(/mx_live_k10_demo_secret/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/mx_live_k10_demo_secret/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New key" }));
    expect(screen.queryByText(/mx_live_k10_demo_secret/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New API key" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Revoke orca agents" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke orca agents" })).not.toBeInTheDocument(),
    );
  });

  it("refuses to overwrite settings changed elsewhere (If-Match)", async () => {
    await endpoints.session();
    const before = await endpoints.settings("ledgerly");
    mockDb().settingsVersion += 1;
    const draft = {
      autonomy: before.autonomy.map((r) =>
        r.phase === "deploy" ? { ...r, mode: "autonomous" as const } : r,
      ),
      runners: before.runners.map((r, i) => (i === 0 ? { ...r, model: "GLM-5.3" } : r)),
    };
    await expect(saveSettings("ledgerly", before, draft)).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.status === 412,
    );
    expect(mockDb().projects[0]?.autonomy.deploy).toBe("human");
  });

  it("rejects mutations without the CSRF token", async () => {
    const res = await fetch("http://matrix.test/v1/keys", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("session cache isolation", () => {
  it("sign-out calls /auth/logout with CSRF, clears every query and goes to sign-in", async () => {
    const user = userEvent.setup();
    const { router, queryClient } = renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(queryClient.getQueryData(["overview"])).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to matrix" })).toBeInTheDocument();
    expect(mockDb().logouts).toBe(1);
    expect(router.state.location.pathname).toBe("/login");
    expect(queryClient.getQueryData(["overview"])).toBeUndefined();
    expect(queryClient.getQueryData(["keys"])).toBeUndefined();
  });

  it("sign-in drops data cached under a previous identity", async () => {
    mockDb().signedIn = false;
    const user = userEvent.setup();
    const { queryClient } = renderRoute("/login");
    queryClient.setQueryData(["keys"], [{ id: "someone-elses-key" }]);
    await user.type(await screen.findByLabelText("API key"), "mx_live_demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(queryClient.getQueryData(["keys"])).toBeUndefined();
  });

  it("a 401 mid-session clears the cache and asks to sign in again", async () => {
    const { queryClient, router } = renderRoute("/p/ledgerly/board");
    expect(await screen.findByRole("region", { name: "Ship column" })).toBeInTheDocument();
    mockDb().signedIn = false;
    await queryClient.refetchQueries({ queryKey: ["projects", "ledgerly", "board"] });
    expect(await screen.findByRole("heading", { name: "Sign in to matrix" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(queryClient.getQueryData(["projects", "ledgerly", "board"])).toBeUndefined();
  });
});

describe("session robustness", () => {
  it("a failed logout keeps you signed in, drops cached data and offers a retry", async () => {
    server.use(
      http.post("*/auth/logout", () =>
        HttpResponse.json(
          { error: { code: "boom", message: "server unavailable" } },
          { status: 503 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { router, queryClient } = renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    queryClient.setQueryData(["keys"], [{ id: "cached-key" }]);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByText(/Couldn't sign out, you are still signed in/),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(queryClient.getQueryData(["keys"])).toBeUndefined();
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(mockDb().logouts).toBe(0);

    server.resetHandlers();
    await user.click(screen.getByRole("button", { name: "Retry sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to matrix" })).toBeInTheDocument();
    expect(mockDb().logouts).toBe(1);
  });

  it("a slow session lookup from before a new login cannot overwrite the new CSRF token", async () => {
    server.use(
      http.get("*/auth/session", async () => {
        await delay(40);
        return HttpResponse.json({
          csrfToken: "old-token",
          expiresAt: "2026-10-13T00:00:00Z",
          key: null,
        });
      }),
      http.post("*/auth/login", () =>
        HttpResponse.json({ csrfToken: "new-token", expiresAt: "2026-10-13T00:00:00Z", key: null }),
      ),
    );
    const slow = endpoints.session();
    await endpoints.signIn("mx_live_demo");
    expect(currentCsrfToken()).toBe("new-token");
    await expect(slow).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.code === "stale_session",
    );
    expect(currentCsrfToken()).toBe("new-token");
  });

  it("a slow login response is ignored after a newer sign-out", async () => {
    server.use(
      http.post("*/auth/login", async () => {
        await delay(40);
        return HttpResponse.json({
          csrfToken: "late-token",
          expiresAt: "2026-10-13T00:00:00Z",
          key: null,
        });
      }),
    );
    await endpoints.session();
    const late = endpoints.signIn("mx_live_demo");
    await endpoints.signOut();
    await expect(late).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.code === "stale_session",
    );
    expect(currentCsrfToken()).not.toBe("late-token");
  });
});
