import { expect, test } from '@playwright/test'

for (const persistent of [false, true]) {
  test(`future JWT rejection ${persistent ? 'stays visible without looping' : 'recovers through a session refresh'}`, async ({ page }) => {
    let refreshes = 0
    let transactionReads = 0
    page.on('request', (request) => {
      if (request.url().includes('/auth/v1/token?grant_type=refresh_token')) refreshes += 1
    })
    await page.route('**/rest/v1/**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fulfill({ status: 403, json: { message: 'Test fixture is read-only' } })
        return
      }
      const table = new URL(route.request().url()).pathname.split('/').at(-1)
      if (table === 'transactions') {
        transactionReads += 1
        if (persistent || transactionReads === 1) {
          await route.fulfill({ status: 401, json: { code: 'PGRST301', message: 'JWT issued at future' } })
          return
        }
      }
      await route.fulfill({ json: [] })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in locally' }).click()
    if (persistent) {
      await expect(page.getByRole('alert')).toContainText('JWT issued at future')
    } else {
      await expect(page.getByRole('button', { name: /Create empty/ })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    expect(refreshes).toBe(1)
    expect(transactionReads).toBeGreaterThanOrEqual(2)
    expect(transactionReads).toBeLessThanOrEqual(4)
  })
}