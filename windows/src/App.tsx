import { HeroSection } from './components/HeroSection'
import { PeriodSwitcher } from './components/PeriodSwitcher'
import { ActivityPanel } from './components/ActivityPanel'
import { ModelsPanel } from './components/ModelsPanel'
import { EmptyState } from './components/EmptyState'
import { Footer } from './components/Footer'
import { useStore, useAutoRefresh } from './store'

export default function App() {
  useAutoRefresh()
  const { data, loading, error, period } = useStore()

  if (error) {
    return (
      <div className="app error">
        <div className="error-title">Could not reach codeburn CLI</div>
        <div className="error-detail">{error}</div>
        <div className="error-hint">
          Install the CLI first: <code>npm i -g @soumyadebroy3/codeburn</code>
        </div>
      </div>
    )
  }

  // First-fetch (no data yet AND loading): full-popover spinner. Subsequent
  // fetches keep the previous data visible and show a subtle indicator.
  const isInitialFetch = !data && loading
  // After fetch returns: data exists but might be empty (no sessions in
  // this period). Render an EmptyState rather than a wall of zero rows.
  const hasNoUsage = !!data && data.overview.calls === 0 && data.overview.sessions === 0

  return (
    <div className="app">
      <HeroSection data={data} period={period} />
      <PeriodSwitcher />
      {isInitialFetch ? (
        <div className="loading-state">
          <div className="loading-spinner" />
          <div className="loading-text">Parsing your AI sessions…</div>
          <div className="loading-hint">First load can take a few seconds.</div>
        </div>
      ) : hasNoUsage ? (
        <EmptyState period={period} />
      ) : (
        <>
          <ActivityPanel data={data} />
          <ModelsPanel data={data} />
        </>
      )}
      <Footer data={data} />
    </div>
  )
}
