export async function openModels(page) {
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '打开模型', exact: true }).click();
}
