import { useStore, setPeriod } from '../store'
import type { Period } from '../types'

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 Days' },
  { key: '30days', label: '30 Days' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All' },
]

export function PeriodSwitcher() {
  const { period } = useStore()
  return (
    <nav className="period-tabs">
      {PERIODS.map(p => (
        <button
          key={p.key}
          className={`period-tab${period === p.key ? ' active' : ''}`}
          onClick={() => { setPeriod(p.key).catch(() => {}) }}
        >
          {p.label}
        </button>
      ))}
    </nav>
  )
}
