import { formatMonth, shiftMonth } from '../finance/utils.ts'

export function WorkspaceMonthHeading({
  disabled = false,
  onMonthChange,
  selectedMonth,
  semanticIdPrefix,
  statusLabel,
  title,
}: {
  disabled?: boolean
  onMonthChange: (month: string) => void
  selectedMonth: string
  semanticIdPrefix: string
  statusLabel: string
  title: string
}) {
  const previousMonth = shiftMonth(selectedMonth, -1)
  const nextMonth = shiftMonth(selectedMonth, 1)

  return (
    <div className="workspace-month-heading">
      <div className="workspace-month-toolbar">
        <h1 aria-live="polite">{formatMonth(selectedMonth)}</h1>
        <nav className="workspace-period-actions" aria-label={`${title} month`}>
          <button
            aria-label={`Previous month, ${formatMonth(previousMonth)}`}
            data-semantic-id={`${semanticIdPrefix}-previous`}
            data-semantic-kind="month-navigation"
            data-semantic-region="workspace"
            data-status-action="previous month"
            data-status-label={`${statusLabel} / previous month`}
            disabled={disabled}
            title="Previous month"
            type="button"
            onClick={() => onMonthChange(previousMonth)}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            aria-label={`Next month, ${formatMonth(nextMonth)}`}
            data-semantic-id={`${semanticIdPrefix}-next`}
            data-semantic-kind="month-navigation"
            data-semantic-region="workspace"
            data-status-action="next month"
            data-status-label={`${statusLabel} / next month`}
            disabled={disabled}
            title="Next month"
            type="button"
            onClick={() => onMonthChange(nextMonth)}
          >
            <span aria-hidden="true">→</span>
          </button>
        </nav>
      </div>
    </div>
  )
}