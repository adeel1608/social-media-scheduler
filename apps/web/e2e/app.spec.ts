import { expect, test } from "@playwright/test";

test("overview renders at laptop resolution without horizontal clipping", async ({
  page,
}) => {
  await page.goto("/analytics");
  await expect(
    page.getByRole("heading", { name: "Good morning, Adeel" }),
  ).toBeVisible();
  await expect(page.getByText("Performance at a glance")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});

test("composer provides platform metadata and a completed preview", async ({
  page,
}) => {
  await page.goto("/composer");
  await expect(
    page.getByRole("heading", { name: "Create a post" }),
  ).toBeVisible();
  await expect(page.getByText("LIVE PREVIEW")).toBeVisible();
  await page.getByRole("button", { name: /TikTok/ }).click();
  await expect(page.getByText("Commercial content")).toBeVisible();
  await expect(
    page.getByText(/public visibility stays blocked/i),
  ).toBeVisible();
});

test("large queue uses virtualization and remains searchable", async ({
  page,
}) => {
  await page.goto("/queue");
  await expect(page.getByText("2,487", { exact: true }).first()).toBeVisible();
  const queue = page.getByTestId("virtual-queue");
  await expect(queue).toBeVisible();
  expect(await queue.locator(".queue-row").count()).toBeLessThan(20);
  await page.getByLabel("Search queue").fill("layout rule");
  await expect(
    page.getByText("The 5-minute layout rule").first(),
  ).toBeVisible();
});

test("failed items explain retention and require explicit retry", async ({
  page,
}) => {
  await page.goto("/failed");
  await expect(page.getByText("Failed source media is retained")).toBeVisible();
  const retry = page.getByRole("button", { name: "Manual retry" }).first();
  await retry.click();
  await expect(
    page.getByText("Manual retry queued with a new idempotency key."),
  ).toBeVisible();
});

test("legal policies are public, complete, and contactable", async ({
  page,
}) => {
  for (const [path, heading] of [
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Use"],
    ["/data-deletion", "Data Deletion Instructions"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText(/customizable template/i)).toHaveCount(0);
  }

  await page.goto("/privacy");
  const contact = page.locator('a[href^="mailto:"]').first();
  await expect(contact).toBeVisible();
  await expect(contact).toHaveAttribute("aria-label", /^Email .+ at .+@.+$/);
  await expect(contact).toHaveAttribute("href", /^mailto:.+@.+$/);
});

test("keyboard focus remains visible on nested queue controls", async ({
  page,
}) => {
  await page.goto("/queue");
  const search = page.getByLabel("Search queue");
  await search.focus();
  await expect(search.locator("..")).toHaveCSS("outline-style", "solid");

  const platform = page.getByLabel("Filter by platform");
  await platform.focus();
  await expect(platform.locator("..")).toHaveCSS("outline-style", "solid");
});
