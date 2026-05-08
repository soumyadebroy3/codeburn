import chalk from 'chalk'
import type { ProjectSummary } from './types.js'

// Re-exported from currency.ts so existing imports from './format.js' keep working.
// The currency-aware version applies exchange rate and symbol automatically.
// Imported locally too since renderStatusBar below uses it directly.
import { formatCost } from './currency.js'
export { formatCost }

export function formatTokens(n: number): string {
  // Guard against Infinity / NaN / negatives that would otherwise leak into
  // the UI as "Infinity" or "NaN" strings when an upstream calculation glitches.
  if (!Number.isFinite(n)) return '?'
  if (n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}

/// Returns YYYY-MM-DD for the given date in the process-local timezone. Cheaper than shelling
/// out to Intl.DateTimeFormat for every turn in a loop and avoids the UTC drift that bites
/// `Date.toISOString().slice(0,10)` whenever the user runs this between local midnight and
/// UTC midnight.
function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * One-line status output. When `plan` is supplied, the second line shows the
 * plan/leverage context so users on flat subscriptions don't misread the
 * month "spend" number as a bill.
 */
export function renderStatusBar(
  projects: ProjectSummary[],
  plan?: { displayName: string; monthlyUsd: number } | null,
): string {
  const now = new Date()
  const today = localDateString(now)
  const monthStart = `${today.slice(0, 7)}-01`

  let todayCost = 0, todayCalls = 0, monthCost = 0, monthCalls = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        // Bucket by the first assistant call's local date -- the moment the cost was
        // incurred. Bucketing by `turn.timestamp` (the user message time) drops turns
        // that straddle midnight (user asked at 23:58, response arrived at 00:30) and
        // disagrees with parseAllSessions' dateRange filter which is also on assistant
        // time.
        const bucketTs = turn.assistantCalls[0]!.timestamp
        if (!bucketTs) continue
        const day = localDateString(new Date(bucketTs))
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        const turnCalls = turn.assistantCalls.length
        if (day === today) { todayCost += turnCost; todayCalls += turnCalls }
        if (day >= monthStart) { monthCost += turnCost; monthCalls += turnCalls }
      }
    }
  }

  const lines: string[] = ['']
  // When a plan is set, the headline says "API value" instead of bare cost
  // because the user pays the flat plan price, not the metered total.
  const monthLabel = plan ? 'Month value' : 'Month'
  const todayLabel = plan ? 'Today value' : 'Today'
  const todayCallsText = `${todayCalls} calls`
  const monthCallsText = `${monthCalls} calls`
  lines.push(`  ${chalk.bold(todayLabel)}  ${chalk.yellowBright(formatCost(todayCost))}  ${chalk.dim(todayCallsText)}    ${chalk.bold(monthLabel)}  ${chalk.yellowBright(formatCost(monthCost))}  ${chalk.dim(monthCallsText)}`)
  if (plan && plan.monthlyUsd > 0) {
    const leverage = monthCost / plan.monthlyUsd
    const arrow = leverage >= 1 ? '✓' : '⚠'
    const leverageText = `${leverage.toFixed(1)}× leverage`
    const planPriceText = `$${plan.monthlyUsd}`
    const planDisplayText = `${plan.displayName} flat`
    const lowLeverageText = `${leverage.toFixed(1)}×`
    const lowLeverageDetail = `— underutilizing your $${plan.monthlyUsd} ${plan.displayName} plan`
    const verdict = leverage >= 1
      ? `${chalk.greenBright(leverageText)} ${chalk.dim('on your')} ${chalk.bold(planPriceText)} ${chalk.dim(planDisplayText)}`
      : `${chalk.yellowBright(lowLeverageText)} ${chalk.dim(lowLeverageDetail)}`
    lines.push(`  ${chalk.dim(arrow)} ${verdict}`)
  }
  lines.push('')

  return lines.join('\n')
}
