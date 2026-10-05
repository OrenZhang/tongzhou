export async function chooseOption(page, label, value) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const option = page.locator('.choice-panel [role="menuitemradio"]');
  const index = await option.evaluateAll(
    (items, wanted) => items.findIndex((item) => item.dataset.value === wanted),
    value,
  );
  if (index < 0) throw new Error(`Missing option ${label}: ${value}`);
  await option.nth(index).click();
}
