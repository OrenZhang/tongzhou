export async function chooseOption(page, label, value) {
  if (label === '当前连接' || label === '当前模型') await openModelMenu(page);
  await page.getByRole('button', { name: label, exact: true }).click();
  const option = page.locator('.choice-panel [role="menuitemradio"]');
  const index = await option.evaluateAll(
    (items, wanted) => items.findIndex((item) => item.dataset.value === wanted),
    value,
  );
  if (index < 0) throw new Error(`Missing option ${label}: ${value}`);
  await option.nth(index).click();
}
export async function openModelMenu(page) {
  const menu = page.locator('.composer-model-menu');
  if ((await menu.count()) && !((await menu.getAttribute('open')) === ''))
    await page.getByLabel('选择模型与连接').click();
}
