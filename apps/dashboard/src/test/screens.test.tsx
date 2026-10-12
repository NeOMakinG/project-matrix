import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderRoute } from "./render";
import { server } from "./server";

describe("screens", () => {
  it("overview shows stats, runs, models and Orca health", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Factory overview" })).toBeInTheDocument();
    expect(screen.getByText("$38.40")).toBeInTheDocument();
    expect(screen.getByText("MX-142 Stripe checkout")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(screen.getByText("1 waiting (MX-139 merge)")).toBeInTheDocument();
    expect(await screen.findByText("4 of 5 models healthy")).toBeInTheDocument();
  });

  it("board toggles ship grouping and filters by type", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/board");
    expect(await screen.findByRole("region", { name: "Ship column" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 8 phases" }));
    expect(screen.getByRole("region", { name: "Deploy column" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ship column" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Bugs/ }));
    const implement = screen.getByRole("region", { name: "Implement column" });
    expect(within(implement).getByText("Rename invoice states")).toBeInTheDocument();
    expect(within(implement).queryByText("Tax rates by country")).not.toBeInTheDocument();
  });

  it("board shows an empty state for a project without tickets", async () => {
    renderRoute("/p/wayline/board");
    expect(await screen.findByText("No tickets yet")).toBeInTheDocument();
  });

  it("run detail approves the merge and links to Orca", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/runs/r_8f3a2c");
    expect(await screen.findByRole("heading", { name: /MX-142/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Orca" })).toHaveAttribute(
      "href",
      "orca://worktree/bosgame/pilot-142",
    );
    expect(
      screen.getByText("Retry path re-creates the Stripe session without an idempotency key"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Approve & merge/ }));
    expect(await screen.findByText("approved · merges after QA")).toBeInTheDocument();
  });

  it("run detail shows an error state with retry when the API fails", async () => {
    server.use(
      http.get("*/api/runs/:runId", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
    );
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/runs/r_8f3a2c");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this view");
    server.resetHandlers();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: /MX-142/ })).toBeInTheDocument();
  });

  it("init interview submits the recommended answer", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/init");
    expect(await screen.findByRole("radio", { name: /TanStack Query \+ tRPC/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^SWR/ }));
    await user.click(screen.getByRole("button", { name: "Confirm & next" }));
    expect(await screen.findByText("answer saved")).toBeInTheDocument();
    expect(screen.getByText("SWR", { selector: "dd" })).toBeInTheDocument();
  });

  it("knowledge lists ADRs and rule violations", async () => {
    renderRoute("/p/ledgerly/knowledge");
    expect(await screen.findByText("0011 Money as integer cents")).toBeInTheDocument();
    expect(screen.getByText("src/invoices/total.ts:42")).toBeInTheDocument();
    expect(screen.getByText("1 violation")).toBeInTheDocument();
  });

  it("prod monitor shows incidents and verification rows", async () => {
    renderRoute("/p/ledgerly/monitor");
    expect(await screen.findByText("#41 Duplicate invoice on retry")).toBeInTheDocument();
    expect(screen.getByText("fixability 0.86")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /deploy d-118/ })).toBeInTheDocument();
  });

  it("settings validates and creates an API key, then revokes it", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ledgerly/settings");
    await user.click(await screen.findByRole("button", { name: "New key" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("Name needs at least 2 characters")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. laptop claude-code"), "orca agents");
    await user.type(screen.getByPlaceholderText("20"), "12");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByRole("heading", { name: "Copy your key now" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("orca agents")).toBeInTheDocument();
    expect(screen.getByText(/budget \$12\/day/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke orca agents" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke orca agents" })).not.toBeInTheDocument(),
    );
  });
});
