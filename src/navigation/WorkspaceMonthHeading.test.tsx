import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceMonthHeading } from './WorkspaceMonthHeading.tsx'

describe('WorkspaceMonthHeading', () => {
  it('renders only the selected month with accessible navigation controls', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceMonthHeading
        selectedMonth="2026-08"
        semanticIdPrefix="month"
        statusLabel="budget"
        title="Budget"
        onMonthChange={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="Budget month"')
    expect(markup).toContain('aria-label="Previous month, July 2026"')
    expect(markup).toContain('aria-label="Next month, September 2026"')
    expect(markup).toContain('data-semantic-id="month-previous"')
    expect(markup).toContain('data-semantic-id="month-next"')
    expect(markup).toContain('<h1 aria-live="polite">August 2026</h1>')
    expect(markup).not.toContain('Monthly plan')
    expect(markup).not.toContain('Plan income and spending')
  })

  it('disables both month actions together', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceMonthHeading
        disabled
        selectedMonth="2026-08"
        semanticIdPrefix="month"
        statusLabel="budget"
        title="Budget"
        onMonthChange={() => undefined}
      />,
    )

    expect(markup.match(/disabled=""/g)).toHaveLength(2)
  })
})