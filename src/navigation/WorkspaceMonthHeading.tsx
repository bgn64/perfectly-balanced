import { formatMonth, shiftMonth } from '../finance/utils.ts'

export function WorkspaceMonthHeading({
  disabled = false,
  eyebrow,
  onMonthChange,
  selectedMonth,
  semanticIdPrefix,
  statusLabel,
  subtitle,
  title,
}: {
  disabled?: boolean
  eyebrow: string
  onMonthChange: (month: string) => void
  selectedMonth: string
  semanticIdPrefix: string
  statusLabel: string
  subtitle: string
  title: string
}) {
  const previousMonth = shiftMonth(selectedMonth, -1)
  const nextMonth = shiftMonth(selectedMonth, 1)

  return (
    <div className="workspace-month-heading">
      <p className="eyebrow">{eyebrow}</p>
      <nav className="workspace-month-rail" aria-label={`${title} month`}>
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
        <span className="workspace-month-rail__current" aria-live="polite">
          <h1>{title}</h1>
          <span className="workspace-month-rail__separator" aria-hidden="true">
            /
          </span>
          <strong>{formatMonth(selectedMonth)}</strong>
        </span>
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
      <p className="subtitle">{subtitle}</p>
    </div>
  )
}