import type { ReportData } from '../types'
import { formatUSD } from '../format'

type Props = { data: ReportData | null; loading: boolean }

export function TopHeader({ data, loading }: Props): JSX.Element {
  return (
    <header className="hdr">
      <div className="hdr-brand">
        <span className="brand-code">Code</span>
        <span className="brand-burn">Burn</span>
        <span className="brand-tagline">AI Coding Cost Tracker</span>
      </div>
      <div className="hdr-cost">
        {loading && !data ? <span className="dim">…</span> : null}
        {data ? (
          <>
            <span className="cost-label">All</span>
            <span className="cost-value">{formatUSD(data.overview.cost)}</span>
          </>
        ) : null}
      </div>
    </header>
  )
}
