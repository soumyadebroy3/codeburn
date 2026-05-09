import type { ReportData, Period } from '../types'
import { formatUSD } from '../format'

type Props = Readonly<{ data: ReportData | null; period: Period }>

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  week: '7 Days',
  '30days': '30 Days',
  month: 'This Month',
  all: 'All Time',
}

// Big-number cost display, adapted from upstream PR #101's HeroSection.
// On Today, suffix with the human weekday + date so the user sees the
// relative date without doing the math. On other periods, just the
// period label is enough context.
export function HeroSection({ data, period }: Props) {
  const todaySuffix = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const caption = period === 'today'
    ? `${PERIOD_LABEL[period]} · ${todaySuffix}`
    : PERIOD_LABEL[period]

  const cost = data?.overview.cost ?? 0
  const calls = data?.overview.calls ?? 0
  const sessions = data?.overview.sessions ?? 0

  return (
    <section className="hero">
      <div className="hero-label">
        <span className="hero-dot" /> {caption}
      </div>
      <div className="hero-amount">{formatUSD(cost)}</div>
      <div className="hero-meta">
        <span>{calls.toLocaleString()} calls</span>
        <span>{sessions} sessions</span>
      </div>
    </section>
  )
}
