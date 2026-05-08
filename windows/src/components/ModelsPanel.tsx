import type { ReportData } from '../types'
import { formatUSD } from '../format'

type Props = { data: ReportData | null }

export function ModelsPanel({ data }: Props) {
  if (!data || data.models.length === 0) return null
  const top = data.models.slice(0, 6)
  const max = Math.max(...top.map(m => m.cost), 1)
  return (
    <section className="panel">
      <header className="panel-header">
        <span>Models</span>
        <div className="panel-header-cols"><span>Cost</span><span>Calls</span></div>
      </header>
      {top.map(m => (
        <div key={m.name} className="activity-row">
          <div className="activity-bar" style={{ width: `${(m.cost / max) * 100}%` }} />
          <span className="activity-name">{m.name}</span>
          <span className="activity-cost">{formatUSD(m.cost)}</span>
          <span className="activity-turns">{m.calls}</span>
        </div>
      ))}
    </section>
  )
}
