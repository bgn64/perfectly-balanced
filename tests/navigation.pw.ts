import { expect, test } from '@playwright/test'

const now = new Date()
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
const categories = [{ id: 'dining', name: 'Dining' }, { id: 'groceries', name: 'Groceries' }]
const transactions = ['Cedar Cafe', 'Local Market'].map((merchant, index) => ({
  id: `transaction-${index}`, source_transaction_id: `source-${index}`,
  plaid_item_id: null, plaid_account_id: null,
  transaction_date: `${month}-01`, effective_transaction_date: `${month}-01`,
  transaction_date_override: null, merchant_name: merchant, transaction_name: merchant,
  amount: index === 0 ? -42 : -75, currency_code: 'USD',
  is_pending: false, is_ignored: false, category: null,
  account_name: 'Local Checking', imported_at: `${month}-01T12:00:00Z`,
}))

test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 403, json: { message: 'Test fixture is read-only' } })
      return
    }
    const table = new URL(route.request().url()).pathname.split('/').at(-1)
    const data = table === 'transactions' ? transactions
      : table === 'categories' ? categories
      : table === 'budgets' ? [{ id: 'budget', month: `${month}-01` }]
      : table === 'budget_category_activity' ? [{
        allocation_id: 'allocation', category_id: 'dining', category_name: 'Dining',
        subsection_id: null, subsection_name: null, position: 0,
        direction: 'spending', budgeted_amount: 100, actual_amount: -42,
      }]
      : table === 'transaction_category_splits' ? [{
        id: 'split', transaction_id: 'transaction-0', category_id: 'dining', amount: -42,
      }] : []
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in locally' }).click()
  await expect(page.locator('[data-semantic-id="nav-transactions"]')).toBeVisible()
})

test('hover preserves focus and click/Enter open details with correct restoration', async ({ page }, testInfo) => {
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  const row = page.locator('[data-semantic-id="transaction-row-transaction-0"]')
  const neighbor = page.locator('[data-semantic-id="transaction-row-transaction-1"]')
  await row.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await neighbor.hover()
  await expect(row).toBeFocused()
  await expect(row).toHaveCSS('outline-style', 'solid')
  expect(await row.evaluate(element => getComputedStyle(element).backgroundColor))
    .not.toBe(await neighbor.evaluate(element => getComputedStyle(element).backgroundColor))
  await page.screenshot({ path: testInfo.outputPath('focus-and-hover.png') })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Cedar Cafe')
  await page.keyboard.press('Escape')
  await expect(row).toBeFocused()
  const opener = neighbor.locator('.transaction-row-simple__select')
  await opener.click()
  await expect(page.getByRole('dialog')).toContainText('Local Market')
  await page.getByRole('button', { name: 'Close transaction details' }).click()
  await expect(opener).toBeFocused()
})

test('row shortcuts cannot act on remembered selection from the toolbar', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => {
    if (request.url().includes('/rest/v1/') && request.method() !== 'GET') writes.push(request.url())
  })
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await page.locator('[data-semantic-id="transaction-row-transaction-0"]').focus()
  await page.getByRole('button', { name: 'Settings', exact: true }).focus()
  await page.keyboard.press('c')
  await page.keyboard.press('t')
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(writes).toEqual([])
})

test('category action does not open details and option hover retains input focus', async ({ page }) => {
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await page.locator('[data-semantic-id="transaction-row-transaction-0"] .category-chip').click()
  await expect(page.locator('.transaction-detail-dialog')).toHaveCount(0)
  const input = page.getByRole('combobox').first()
  await expect(input).toBeFocused()
  const option = page.getByRole('option').filter({ hasText: 'Groceries' }).first()
  await option.hover()
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('aria-activedescendant', await option.getAttribute('id') as string)
  await page.keyboard.press('Escape')
})

test('report dialog traps Tab and restores its opener', async ({ page }) => {
  await page.locator('[data-semantic-id="nav-insights"]').click()
  const opener = page.locator('.reports-v2-slice-row').first()
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const controls = dialog.locator('button, [tabindex="0"]')
  await controls.last().focus()
  await page.keyboard.press('Tab')
  await expect(controls.first()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(controls.last()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
})

test('financial data rows share geometry and focus treatment', async ({ page }) => {
  const rowStyle = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    return {
      borderBottomWidth: style.borderBottomWidth,
      minHeight: style.minHeight,
      paddingBottom: style.paddingBottom,
      paddingTop: style.paddingTop,
    }
  }

  const budgetRow = page.locator('.budget-row.data-row').first()
  await expect(budgetRow).toBeVisible()
  const budgetStyle = await budgetRow.evaluate(rowStyle)

  await page.locator('[data-semantic-id="nav-transactions"]').click()
  const transactionRow = page.locator('.transaction-row-simple.data-row').first()
  await expect(transactionRow).toBeVisible()
  await expect(transactionRow.evaluate(rowStyle)).resolves.toEqual(budgetStyle)

  await page.locator('[data-semantic-id="nav-insights"]').click()
  await page.locator('.reports-v2-slice-row').first().click()
  const dialog = page.getByRole('dialog')
  let reportRow = dialog.locator('.reports-v2-transaction-row.data-row').first()
  if (await reportRow.count() === 0) {
    await dialog.locator('.reports-v2-slice-row').first().click()
    reportRow = page.getByRole('dialog').locator('.reports-v2-transaction-row.data-row').first()
  }
  await expect(reportRow).toBeVisible()
  await expect(reportRow.evaluate(rowStyle)).resolves.toEqual(budgetStyle)

  await reportRow.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(reportRow).toBeFocused()
  await expect(reportRow).toHaveCSS('outline-style', 'solid')
})

test('keyboard navigation keeps visible focus in both themes and sizes', async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.locator('[data-semantic-id="nav-settings"]').click()
    for (const theme of ['Dark', 'Light']) {
      await page.getByRole('button', { name: theme, exact: true }).click()
      await page.locator('[data-semantic-id="nav-transactions"]').focus()
      await page.keyboard.press('l')
      await expect.poll(() => page.evaluate(() => ({
        focus: document.activeElement?.matches(':focus-visible'),
        outline: getComputedStyle(document.activeElement!).outlineStyle,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }))).toEqual({ focus: true, outline: 'solid', overflow: false })
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`) })
    }
  }
})

test('hover preserves typed text and focus, and blur clears the shell target', async ({ page }) => {
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await page.locator('[data-semantic-id="transaction-row-transaction-0"] .category-chip').click()
  const input = page.getByRole('combobox').first()
  await input.fill('Gro')
  await page.locator('[data-semantic-id="nav-settings"]').hover()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Gro')
  await page.keyboard.press('Escape')
  const settings = page.locator('[data-semantic-id="nav-settings"]')
  await settings.focus()
  await expect(settings).toHaveClass(/is-focused/)
  await settings.evaluate(element => element.blur())
  await expect(settings).not.toHaveClass(/is-focused/)
})

test('report dialog uses a safe fallback when the opener disappears', async ({ page }) => {
  await page.locator('[data-semantic-id="nav-insights"]').click()
  const opener = page.locator('.reports-v2-slice-row').first()
  await opener.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await opener.evaluate(element => element.remove())
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-semantic-id="nav-insights"]')).toBeFocused()
})

test('workspace controls persist across navigation but reset with the authenticated shell', async ({ page }) => {
  const initialUrl = page.url()
  const initialLocalStorageKeys = await page.evaluate(() => Object.keys(localStorage).sort())

  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await page.locator('[data-semantic-id="transactions-time"]').click()
  await page.locator('[data-semantic-id="transaction-time-last-3-months"]').click()
  await page.locator('[data-semantic-id="transactions-filter"]').click()
  await page.locator('[data-semantic-id="transaction-filter-option-uncategorized"]').click()
  await page.locator('[data-semantic-id="transaction-filter-apply"]').click()
  await page.locator('[data-semantic-id="transactions-sort"]').click()
  await page.locator('[data-semantic-id="transaction-sort-merchant"]').click()

  await page.locator('[data-semantic-id="nav-insights"]').click()
  await page.locator('[data-semantic-id="report-mode-planned"]').click()
  await page.locator('[data-semantic-id="nav-budgets"]').click()
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await expect(page.locator('[data-semantic-id="transactions-time"]')).toContainText('Last 3 months')
  await expect(page.locator('[data-semantic-id="transactions-filter"]')).toContainText('Filter 1')
  await expect(page.locator('[data-semantic-id="transactions-sort"]')).toContainText('Merchant A-Z')

  await page.locator('[data-semantic-id="transactions-filter"]').click()
  await page.locator('[data-semantic-id="transaction-filter-option-included"]').click()
  await page.locator('[data-semantic-id="nav-budgets"]').evaluate(element => element.click())
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await page.locator('[data-semantic-id="transactions-filter"]').click()
  await expect(page.locator('[data-semantic-id="transaction-filter-option-included"]')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('[data-semantic-id="transaction-filter-option-uncategorized"]')).toHaveAttribute('aria-checked', 'true')
  await page.locator('[data-semantic-id="transaction-filter-cancel"]').click()

  await page.locator('[data-semantic-id="nav-insights"]').click()
  await expect(page.locator('[data-semantic-id="report-mode-planned"]')).toHaveAttribute('aria-pressed', 'true')
  expect(page.url()).toBe(initialUrl)
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(initialLocalStorageKeys)
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([])

  await page.reload()
  await expect(page.locator('[data-semantic-id="nav-transactions"]')).toBeVisible()
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await expect(page.locator('[data-semantic-id="transactions-time"]')).toContainText('Current month')
  await expect(page.locator('[data-semantic-id="transactions-filter"]')).toContainText('None')
  await expect(page.locator('[data-semantic-id="transactions-sort"]')).toContainText('Newest first')
  await page.locator('[data-semantic-id="nav-insights"]').click()
  await expect(page.locator('[data-semantic-id="report-mode-all"]')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('[data-semantic-id="report-mode-categorized"]').click()
  await page.locator('[data-semantic-id="nav-settings"]').click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in locally' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in locally' }).click()
  await page.locator('[data-semantic-id="nav-insights"]').click()
  await expect(page.locator('[data-semantic-id="report-mode-all"]')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('[data-semantic-id="nav-transactions"]').click()
  await expect(page.locator('[data-semantic-id="transactions-sort"]')).toContainText('Newest first')
})