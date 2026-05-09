import { fetchReport } from '../store'
import type { ReportData } from '../types'

type Props = Readonly<{ data: ReportData | null }>

export function Footer({ data }: Props) {
  return (
    <footer className="ftr">
      <span className="ftr-currency">{data?.currency ?? 'USD'}</span>
      <button className="ftr-btn" title="Refresh" onClick={() => { fetchReport().catch(() => {}) }}>
        ↻
      </button>
      <span className="ftr-version">v{APP_VERSION}</span>
    </footer>
  )
}

// __APP_VERSION__ is replaced at build time by Vite (see vite.config.ts's
// `define` block which reads it from src-tauri/tauri.conf.json). Guard
// against undefined so a misconfigured build doesn't crash the popover —
// blank-popover-on-render-error was the v2.2.5 regression this came from.
declare const __APP_VERSION__: string | undefined
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
