import { expect, type Page, test } from "@playwright/test";

const SHOTS = "e2e-real/screenshots";

async function fillRound(page: Page) {
  const round = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: /^Confirm \d+ answers?$/ }) });
  for (const input of await round
    .locator('input[aria-labelledby^="q-"]:not([type=radio]):not([type=checkbox])')
    .all()) {
    if ((await input.inputValue()) === "") {
      await input.fill(
        (await input.getAttribute("type")) === "number" ? "3" : "Freelancers who invoice monthly",
      );
    }
  }
  for (const area of await round.locator('textarea[aria-labelledby^="q-"]').all()) {
    if ((await area.inputValue()) === "")
      await area.fill("Faster invoicing\nFewer unpaid invoices");
  }
  await round.getByRole("button", { name: /^Confirm \d+ answers?$/ }).click();
  // Questions without a recommendation: pick the first option, then resubmit.
  const missing = round.locator("section", {
    has: page.getByText("This question needs an answer."),
  });
  if (await missing.count()) {
    for (const section of await missing.all()) await section.locator("label").first().click();
    await round.getByRole("button", { name: /^Confirm \d+ answers?$/ }).click();
  }
}

test("a short interview against the real server, end to end", async ({ page }) => {
  const token = process.env.MATRIX_E2E_TOKEN ?? "";
  await page.goto("/login");
  await page.getByLabel("API key").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Factory overview" })).toBeVisible();

  await page.getByRole("link", { name: "New project" }).click();
  await page.getByPlaceholder("ledgerly").fill("e2e-shop");
  await page.getByPlaceholder("Invoicing for freelancers").fill("A shop built by the factory e2e");
  await page.getByRole("button", { name: "Create and start the interview" }).click();
  await expect(page.getByRole("heading", { name: /e2e-shop · Init interview/ })).toBeVisible();
  await expect(page).toHaveURL(/\/p\/[^/]+\/init\?session=/);

  // Round 1: recommended answers are preselected, with rationale and alternatives.
  await expect(page.getByText("Recommended").first()).toBeVisible();
  await expect(page.getByLabel("matrix.config.ts preview")).toContainText("defineConfig");
  await page.screenshot({ path: `${SHOTS}/01-round.png`, fullPage: true });

  let rounds = 0;
  while (rounds < 25) {
    if (await page.getByRole("heading", { name: "Autonomy per phase" }).isVisible()) break;
    const before = await page.getByText(/answered so far/).textContent();
    await fillRound(page);
    await expect(page.getByText(/answered so far|Interview complete/)).not.toHaveText(
      before ?? "",
      { timeout: 15_000 },
    );
    rounds += 1;
  }
  expect(rounds).toBeGreaterThan(1);
  await expect(page.getByRole("heading", { name: "Autonomy per phase" })).toBeVisible();
  await expect(page.getByText(/Interview complete · \d+ answers/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-autonomy.png`, fullPage: true });

  await page.getByRole("button", { name: "Save autonomy and continue" }).click();
  await expect(page.getByRole("heading", { name: "Generate the project" })).toBeVisible();

  // Autonomy really reached the server.
  const projectId = page.url().match(/\/p\/([^/]+)\/init/)?.[1] ?? "";
  const project = await page.request.get(`/v1/projects/${projectId}`);
  expect(project.ok()).toBe(true);
  expect(Object.keys((await project.json()).autonomy)).toContain("compound");

  // The server has no finalize endpoint yet: the UI says so instead of pretending.
  await page.getByRole("button", { name: "Generate project" }).click();
  await expect(page.getByRole("alert")).toContainText("POST /v1/init/{id}/finalize is missing");
  await page.screenshot({ path: `${SHOTS}/03-finalize.png`, fullPage: true });

  await page.goto(`/p/${projectId}/board`);
  await expect(page.getByText("No tickets yet")).toBeVisible();
});
