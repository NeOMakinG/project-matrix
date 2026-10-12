import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { endpoints } from "@/api/endpoints";
import { ApiError } from "@/api/http";
import { saveSettings } from "@/features/settings/settings-page";
import { mockDb } from "@/mocks/handlers";
import { renderRoute } from "./render";
import { server } from "./server";

describe("auth", () => {
  it("redirects to sign-in without a session and returns after signing in", async () => {
    mockDb().signedIn = false;
    const user = userEvent.setup();
    const { router } = renderRoute("/p/ledgerly/monitor");
    expect(await screen.findByRole("heading", { name: "Sign in to matrix" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("API key"), "mx_live_demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("#41 Duplicate invoice on retry")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/ledgerly/monitor");
  });
});

describe("screens", () => {
  it("overview shows stats, runs, models and Orca health", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(screen.getByText("$38.40")).toBeInTheDocument();
    expect(screen.getByText("1 waiting (MX-139 merge)")).toBeInTheDocument();
    expect(await screen.findByText("4 of 5 models healthy")).toBeInTheDocument();
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
    expect(mockDb().approvals).toEqual([
      { runId: "r_8f3a2c", decision: "approve", commitSha: "3c1e9a2f6b" },
    ]);
  });

  it("run with an unsafe workspace link hides Open in Orca", async () => {
    renderRoute("/p/ledgerly/runs/r_bad");
    expect(await screen.findByRole("heading", { name: /MX-144/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open in Orca" })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing to approve yet: the run has no commit.")).toBeInTheDocument();
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

  it("init interview starts a session and walks questions", async () => {
    const user = userEvent.setup();
    const { router } = renderRoute("/p/ledgerly/init");
    await user.click(await screen.findByRole("button", { name: "Start interview" }));
    expect(await screen.findByRole("radio", { name: /TanStack Query \+ tRPC/ })).toBeChecked();
    expect(router.state.location.search).toEqual({ session: "init_1" });
    await user.click(screen.getByRole("button", { name: "Confirm & next" }));
    expect(
      await screen.findByRole("heading", { name: "Which form library should the web app use?" }),
    ).toBeInTheDocument();
  });

  it("knowledge lists ADRs and rule violations", async () => {
    renderRoute("/p/ledgerly/knowledge");
    expect(await screen.findByText("0011 Money as integer cents")).toBeInTheDocument();
    expect(screen.getByText("src/invoices/total.ts:42")).toBeInTheDocument();
    expect(screen.getByText("1 violation")).toBeInTheDocument();
  });

  it("prod monitor shows incidents and verification", async () => {
    renderRoute("/p/ledgerly/monitor");
    expect(await screen.findByText("#41 Duplicate invoice on retry")).toBeInTheDocument();
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
