import type { Period } from '../types'

type Props = Readonly<{ period: Period }>

const PERIOD_PHRASE: Record<Period, string> = {
  today: 'today',
  week: 'the last 7 days',
  '30days': 'the last 30 days',
  month: 'this month',
  all: 'any recorded time',
}

// Shown when fetch_report returned successfully but the user has no
// AI-coding usage in the selected window. Beats rendering a wall of
// zero rows that look like a broken UI. Adapted from upstream PR #101's
// EmptyProviderState component, simplified for our single-provider view.
export function EmptyState({ period }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">—</div>
      <div className="empty-state-title">No usage for {PERIOD_PHRASE[period]}</div>
      <div className="empty-state-hint">
        Run a Claude / Codex / Cursor / Copilot session and refresh to see your
        spend land here.
      </div>
    </div>
  )
}
