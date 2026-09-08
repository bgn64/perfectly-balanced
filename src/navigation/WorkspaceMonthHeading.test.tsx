import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceMonthHeading } from './WorkspaceMonthHeading.tsx'

describe('WorkspaceMonthHeading', () => {
  it('renders the view and selected month inside accessible navigation controls', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceMonthHeading
        eyebrow="Monthly plan"
        selectedMonth="2026-08"
        semanticIdPrefix="month"
        statusLabel="budget"
        subtitle="Plan income and spending for the selected month."
        title="Budget"
        onMonthChange={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="Budget month"')
    expect(markup).toContain('aria-label="Previous month, July 2026"')
    expect(markup).toContain('aria-label="Next month, September 2026"')
    expect(markup).toContain('data-semantic-id="month-previous"')
    expect(markup).toContain('data-semantic-id="month-next"')
    expect(markup.indexOf('Budget')).toBeLessThan(markup.indexOf('August 2026'))
  })

  it('disables both month actions together', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceMonthHeading
        disabled
        eyebrow="Monthly plan"
        selectedMonth="2026-08"
        semanticIdPrefix="month"
        statusLabel="budget"
        subtitle="Plan income and spending for the selected month."
        title="Budget"
        onMonthChange={() => undefined}
      />,
    )

    expect(markup.match(/disabled=""/g)).toHaveLength(2)
  })
})