export async function openModels(page) {
  await openSidebar(page, '模型');
}

export async function openSidebar(page, name) {
  const sidebar = page.locator('.sidebar');
  const button = sidebar.getByRole('button', { name, exact: true });
  if (!(await button.count())) {
    for (const expand of await sidebar.locator('[data-nav-expand]').all()) await expand.click();
  }
  await button.click();
}
