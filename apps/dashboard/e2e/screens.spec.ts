import { expect, type Page, test } from "@playwright/test";

const SHOTS = "e2e/screenshots";

async function settle(page: Page) {
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

test("overview lists runs, models and Orca health", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Factory overview" })).toBeVisible();
  await settle(page);
  await expect(page.getByText("MX-142 Stripe checkout")).toBeVisible();
  await expect(page.getByText("Orca runtime")).toBeVisible();
  await expect(page.getByText("4 of 5 models healthy")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-overview.png`, fullPage: true });
});

test("board shows phases, filters and the ship grouping toggle", async ({ page }) => {
  await page.goto("/p/ledgerly/board");
  await expect(page.getByRole("heading", { name: "ledgerly · Board" })).toBeVisible();
  await settle(page);
  await expect(page.getByRole("region", { name: "Ship column" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-board.png`, fullPage: true });

  await page.getByRole("button", { name: "Show all 8 phases" }).click();
  for (const phase of ["Merge", "Deploy", "Verify"]) {
    await expect(page.getByRole("region", { name: `${phase} column` })).toBeVisible();
  }
  await page.getByRole("button", { name: /^Prod fixes/ }).click();
  await expect(page.getByText("Fix: duplicate invoice on retry")).toBeVisible();
  await expect(page.getByText("Recurring invoices")).toHaveCount(0);
});

test("run detail streams the live log and records a merge decision", async ({ page }) => {
  await page.goto("/p/ledgerly/runs/r_8f3a2c");
  await expect(page.getByRole("heading", { name: /MX-142/ })).toBeVisible();
  await settle(page);
  await expect(page.getByRole("link", { name: "Open in Orca" })).toHaveAttribute(
    "href",
    /^orca:\/\//,
  );
  await expect(page.getByText("Uploading receipts to ticket MX-142")).toBeVisible({
    timeout: 10_000,
  });
  // the mock sends one event twice: the client must show it once
  await expect(page.getByText("curl POST /api/checkout → 200 (412 ms)")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/03-run-detail.png`, fullPage: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("approved at 3c1e9a2")).toBeVisible();
});

test("runs list sorts by column", async ({ page }) => {
  await page.goto("/p/ledgerly/runs");
  await settle(page);
  await expect(page.getByRole("link", { name: "Stripe checkout for annual plans" })).toBeVisible();
  await page.getByRole("button", { name: "Ticket" }).click();
  await expect(page.locator("tbody tr").first()).toContainText("MX-131");
});

test("init interview confirms the recommended answer", async ({ page }) => {
  await page.goto("/p/ledgerly/init");
  await settle(page);
  await page.getByRole("button", { name: "Start interview" }).click();
  await expect(page.getByRole("heading", { name: "New project · Init interview" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /TanStack Query \+ tRPC/ })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}/04-init-interview.png`, fullPage: true });
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "Confirm & next" }).click();
  await expect(
    page.getByRole("heading", { name: "Which form library should the web app use?" }),
  ).toBeVisible();
});

test("knowledge renders the product graph and ADR rules", async ({ page }) => {
  await page.goto("/p/ledgerly/knowledge");
  await settle(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(13);
  await page.getByText("MX-142 Checkout").click();
  await expect(page.getByText("Float arithmetic on money: amount * 1.2")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-knowledge.png`, fullPage: true });
});

test("prod monitor shows incidents and verification", async ({ page }) => {
  await page.goto("/p/ledgerly/monitor");
  await settle(page);
  await expect(page.getByText("#41 Duplicate invoice on retry")).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Error rate before and after deploy d-118/ }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-prod-monitor.png`, fullPage: true });
});

test("settings saves autonomy and creates an API key", async ({ page }) => {
  await page.goto("/p/ledgerly/settings");
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/07-settings.png`, fullPage: true });

  await page.getByRole("combobox", { name: "Autonomy for deploy" }).click();
  await page.getByRole("option", { name: "autonomous", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Autonomy for deploy" })).toHaveText(
    /autonomous/,
  );

  await page.getByRole("button", { name: "New key" }).click();
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("Name needs at least 2 characters")).toBeVisible();
  await page.getByPlaceholder("e.g. laptop claude-code").fill("orca agents");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Copy your key now" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/mx_live_/)).toHaveCount(0);
  await expect(page.getByText("orca agents")).toBeVisible();
});

test("command palette navigates with the keyboard", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Jump to a screen, project or ticket…").fill("prod monitor");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/p\/ledgerly\/monitor$/);
});

test("unknown run shows an error state with retry", async ({ page }) => {
  await page.goto("/p/ledgerly/runs/r_missing");
  await expect(page.getByRole("alert")).toContainText("Couldn't load this view");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("custom radios show a visible keyboard focus ring", async ({ page }) => {
  await page.goto("/p/ledgerly/init");
  await settle(page);
  await page.getByRole("button", { name: "Start interview" }).click();
  const radio = page.getByRole("radio", { name: /TanStack Query \+ tRPC/ });
  await expect(radio).toBeChecked();
  await radio.focus();
  await page.keyboard.press("ArrowDown");
  const label = page.locator("label", {
    has: page.getByRole("radio", { name: /TanStack Query \+ REST/ }),
  });
  await expect(label).toHaveCSS("outline-style", "solid");
});

test("unsafe links from the API are never rendered", async ({ page }) => {
  await page.goto("/p/ledgerly/runs/r_bad");
  await settle(page);
  await expect(page.getByRole("heading", { name: /MX-144/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Orca" })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});
