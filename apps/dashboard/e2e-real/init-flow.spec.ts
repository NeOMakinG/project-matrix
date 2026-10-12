import { expect, type Page, test } from "@playwright/test";

const SHOTS = "../../docs/qa/pr26/screenshots";
test.skip(
  !process.env.MATRIX_E2E_BASE_URL ||
    !process.env.MATRIX_E2E_TOKEN ||
    process.env.MATRIX_E2E_HOST_LEASE !== "pr26",
  "Requires an existing real same-origin server, isolated credential, and exclusive QA lease. No local backend is started.",
);

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
  const projectName = `pr26-qa-${Date.now().toString(36)}`;
  await page.getByPlaceholder("ledgerly").fill(projectName);
  await page.getByPlaceholder("Invoicing for freelancers").fill("A shop built by the factory e2e");
  await page.getByRole("button", { name: "Create and start the interview" }).click();
  await expect(
    page.getByRole("heading", { name: `${projectName} · Init interview` }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/p\/[^/]+\/init\?session=/);

  // Round 1: recommended answers are preselected, with rationale and alternatives.
  await expect(page.getByText("Recommended").first()).toBeVisible();
  await expect(page.getByLabel("matrix.config.ts preview")).toContainText("defineConfig");
  await page.screenshot({ path: `${SHOTS}/01-round.png`, fullPage: true });

  let rounds = 0;
  let recovered = false;
  while (rounds < 25) {
    if (await page.getByRole("heading", { name: "Autonomy per phase" }).isVisible()) break;
    const before = await page.getByText(/answered so far/).textContent();
    const database = page.locator('section[aria-labelledby="q-backend.database"]');
    const orm = page.locator('section[aria-labelledby="q-backend.orm"]');
    const injectContradiction =
      !recovered && (await database.count()) > 0 && (await orm.count()) > 0;
    if (injectContradiction) {
      await database
        .locator("label")
        .filter({ has: page.locator('input[value="none"]') })
        .click();
      await orm
        .locator("label")
        .filter({ has: page.locator('input[value="drizzle"]') })
        .click();
    }
    await fillRound(page);
    await expect(page.getByText(/answered so far|Interview complete/)).not.toHaveText(
      before ?? "",
      { timeout: 15_000 },
    );
    if (injectContradiction) {
      await expect(page.getByText("An ORM was chosen without a database.")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/01b-contradiction.png`, fullPage: true });
      await page.getByRole("button", { name: /^Edit answer: ORM/ }).click();
      await page
        .locator('section[aria-labelledby="q-backend.orm"]')
        .locator("label")
        .filter({ has: page.locator('input[value="none"]') })
        .click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("heading", { name: "Change answers" })).not.toBeVisible();
      await expect(page.getByText("An ORM was chosen without a database.")).not.toBeVisible();
      await page.screenshot({ path: `${SHOTS}/01c-recovered.png`, fullPage: true });
      recovered = true;
    }
    rounds += 1;
  }
  expect(rounds).toBeGreaterThan(1);
  expect(recovered).toBe(true);
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

  await page.getByRole("button", { name: "Generate project" }).click();
  await expect(page.getByText("Project generated. Artifacts:")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-finalize.png`, fullPage: true });

  await page.getByRole("link", { name: "Open project board" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/board`));
  await expect(page.getByText("No tickets yet")).not.toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-board.png`, fullPage: true });
});
