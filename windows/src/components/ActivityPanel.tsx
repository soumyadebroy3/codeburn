import type { ReportData } from '../types'
import { formatUSD } from '../format'

type Props = { data: ReportData | null }

export function ActivityPanel({ data }: Props) {
  if (!data || data.activities.length === 0) return null
  const top = data.activities.slice(0, 8)
  const max = Math.max(...top.map(a => a.cost), 1)
  return (
    <section className="panel">
      <header className="panel-header">
        <span>Activity</span>
        <div className="panel-header-cols">
          <span>Cost</span><span>Turns</span><span>1-shot</span>
        </div>
      </header>
      {top.map(a => {
        const oneShot = a.editTurns > 0
          ? `${Math.round((a.oneShotTurns / a.editTurns) * 100)}%`
          : '—'
        return (
          <div key={a.name} className="activity-row">
            <div className="activity-bar" style={{ width: `${(a.cost / max) * 100}%` }} />
            <span className="activity-name">{a.name}</span>
            <span className="activity-cost">{formatUSD(a.cost)}</span>
            <span className="activity-turns">{a.turns}</span>
            <span className="activity-oneshot">{oneShot}</span>
          </div>
        )
      })}
    </section>
  )
}
