import type { ReportData } from '../types'
import { formatUSD } from '../format'

type Props = { data: ReportData | null }

// Lightweight version of the Swift PlanSection — just the headline numbers
// plus a single progress bar. Capacity-estimator + 5h-window + 7-day-Sonnet
// detail will be added in a later phase once the Rust port of
// CapacityEstimator.swift lands.
export function PlanSection({ data }: Props) {
  if (!data) return null
  const { overview } = data
  return (
    <section className="panel plan">
      <div className="panel-row">
        <span className="panel-label">Calls</span>
        <span className="panel-value">{overview.calls}</span>
      </div>
      <div className="panel-row">
        <span className="panel-label">Sessions</span>
        <span className="panel-value">{overview.sessions}</span>
      </div>
      <div className="panel-row">
        <span className="panel-label">Cache hit</span>
        <span className="panel-value">{overview.cacheHitPercent.toFixed(1)}%</span>
      </div>
      <div className="panel-row">
        <span className="panel-label">Cost</span>
        <span className="panel-value accent">{formatUSD(overview.cost)}</span>
      </div>
    </section>
  )
}
