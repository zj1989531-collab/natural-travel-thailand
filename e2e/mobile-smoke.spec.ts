import { expect, test } from '@playwright/test'

test('mobile home, record form and primary navigation remain usable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('票务盈利簿')).toBeVisible()

  const navigation = page.getByRole('navigation', { name: '主导航' })
  await expect(navigation.getByRole('button')).toHaveCount(6)
  await expect(page.getByRole('button', { name: '新增出票记录' })).toBeVisible()

  await page.getByRole('button', { name: '新增出票记录' }).click()
  await expect(page.getByRole('heading', { name: '新增出票记录' })).toBeVisible()

  await page.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: /月结票/ }).click()
  await expect(page.getByText('69秀')).toBeVisible()

  await page.getByRole('button', { name: /报表/ }).click()
  await expect(page.getByText('报表')).toBeVisible()
})
