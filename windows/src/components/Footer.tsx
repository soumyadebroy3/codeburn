import { fetchReport } from '../store'
import type { ReportData } from '../types'

type Props = { data: ReportData | null }

export function Footer({ data }: Props): JSX.Element {
  return (
    <footer className="ftr">
      <span className="ftr-currency">{data?.currency ?? 'USD'}</span>
      <button className="ftr-btn" title="Refresh" onClick={() => { fetchReport().catch(() => {}) }}>
        ↻
      </button>
      <span className="ftr-version">v{__APP_VERSION__}</span>
    </footer>
  )
}

declare const __APP_VERSION__: string
