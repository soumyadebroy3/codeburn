import { TopHeader } from './components/TopHeader'
import { PeriodSwitcher } from './components/PeriodSwitcher'
import { PlanSection } from './components/PlanSection'
import { ActivityPanel } from './components/ActivityPanel'
import { ModelsPanel } from './components/ModelsPanel'
import { Footer } from './components/Footer'
import { useStore, useAutoRefresh } from './store'

export default function App() {
  useAutoRefresh()
  const { data, loading, error } = useStore()

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

  return (
    <div className="app">
      <TopHeader data={data} loading={loading} />
      <PeriodSwitcher />
      <PlanSection data={data} />
      <ActivityPanel data={data} />
      <ModelsPanel data={data} />
      <Footer data={data} />
    </div>
  )
}
