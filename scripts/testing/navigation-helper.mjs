export async function openModels(page) {
  await openSidebar(page, '模型');
}

export async function openCanvas(page, id) {
  if (await page.locator('.studio-home').isVisible()) {
    await page.locator(`.studio-home-list button[data-canvas-id="${id}"]`).click();
  } else {
    await page.getByLabel(/^(选择画布|Select canvas)$/).selectOption(id);
  }
  await page.locator('.canvas-toolbar').waitFor();
}

export async function openSidebar(page, name) {
  await page
    .getByRole('navigation', { name: '管理与工具', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}
