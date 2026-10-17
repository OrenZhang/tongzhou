export async function openModels(page) {
  await openSidebar(page, '模型');
}

export async function openSidebar(page, name) {
  await page
    .getByRole('navigation', { name: '管理与工具', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}
