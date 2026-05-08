// Mirrors the JSON shape that `codeburn report --format json` emits. The
// macOS Swift app and this Tauri tray both consume the same payload, so any
// change to src/menubar-json.ts on the CLI side flows here too.
export type ProviderCost = { name: string; cost: number }
export type ModelEntry = { name: string; calls: number; cost: number }
export type CategoryEntry = {
  name: string
  turns: number
  cost: number
  editTurns: number
  oneShotTurns: number
}
export type DayEntry = { date: string; cost: number; calls: number }

export type PeriodOverview = {
  cost: number
  calls: number
  sessions: number
  cacheHitPercent: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

export type ReportData = {
  generated: string
  currency: string
  period: string
  periodKey: string
  overview: PeriodOverview
  daily: DayEntry[]
  projects: Array<{
    name: string
    path: string
    cost: number
    calls: number
    sessions: number
  }>
  models: ModelEntry[]
  activities: CategoryEntry[]
}

export type Period = 'today' | 'week' | '30days' | 'month' | 'all'
