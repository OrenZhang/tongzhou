export async function openModels(page) {
  await openSidebar(page, '模型');
}

export async function openSidebar(page, name) {
  const sidebar = page.locator('.sidebar');
  const button = sidebar.getByRole('button', { name, exact: true });
  // Expansion removes its button; resolve the remaining controls after each render.
  while (!(await button.count()) && (await sidebar.locator('[data-nav-expand]').count())) {
    try {
      await sidebar.locator('[data-nav-expand]').first().click({ timeout: 1500 });
    } catch (error) {
      // Navigating to a middle item can expand its group before this click resolves.
      if (!(await button.count())) throw error;
    }
  }
  await button.click();
}
