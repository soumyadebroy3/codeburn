/// Rollup of one time window (today / 7 days / 30 days / month / all) used as the canonical
/// input to the menubar payload. Built inside the CLI and also consumed by the day-aggregator
/// when hydrating per-day cache entries.
export type PeriodData = {
  label: string
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  categories: Array<{ name: string; cost: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; calls: number }>
}

export type ProviderCost = {
  name: string
  cost: number
}
import type { OptimizeResult } from './optimize.js'

const TOP_ACTIVITIES_LIMIT = 20
const TOP_MODELS_LIMIT = 20
const TOP_FINDINGS_LIMIT = 10
const HISTORY_DAYS_LIMIT = 365
const SYNTHETIC_MODEL_NAME = '<synthetic>'

export type DailyModelBreakdown = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyHistoryEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: DailyModelBreakdown[]
}

// Schema version for the JSON snapshot consumed by the macOS menubar app and
// the GNOME shell extension. Bump in lockstep with breaking shape changes; the
// menubar/extension SHOULD warn the user and refuse to consume a major-bumped
// payload they can't decode. Minor (additive) shape changes can keep the same
// version as long as old fields stay present.
export const MENUBAR_SCHEMA_VERSION = 1

/**
 * Plan + leverage information surfaced when a subscription plan is configured.
 * Lets the menubar / GNOME / HTML report show "$200 paid · $1,131 of API value
 * · 5.7× leverage" instead of just "$1,131 spend" — which is misleading for
 * subscription users (they pay flat, not per-token).
 */
export type ValuationBlock = {
  /** Flat amount the user pays for this period (monthlyUsd from the configured plan). */
  paidUSD: number
  /** Sum of pay-as-you-go API rates × tokens for this period. The "spend" number we currently show. */
  apiValueUSD: number
  /** apiValueUSD / paidUSD. >= 1 means you're getting more than you pay for. */
  leverage: number
  /** Plan id (e.g. 'claude-max') and display name. Null when no plan is configured. */
  plan: { id: string; displayName: string; monthlyUsd: number } | null
}

export type MenubarPayload = {
  schemaVersion: typeof MENUBAR_SCHEMA_VERSION
  generated: string
  /**
   * Optional. Present when the user has set a plan via `codeburn plan set …`.
   * Older menubar/GNOME builds ignore unknown fields, so this is additive
   * within schema v1.
   */
  valuation?: ValuationBlock
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    topActivities: Array<{
      name: string
      cost: number
      turns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number
      calls: number
    }>
    providers: Record<string, number>
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{
      title: string
      impact: 'high' | 'medium' | 'low'
      savingsUSD: number
    }>
  }
  history: {
    daily: DailyHistoryEntry[]
  }
}

function oneShotRateFor(editTurns: number, oneShotTurns: number): number | null {
  if (editTurns === 0) return null
  return oneShotTurns / editTurns
}

function aggregateOneShotRate(categories: PeriodData['categories']): number | null {
  let edits = 0
  let oneShots = 0
  for (const cat of categories) {
    edits += cat.editTurns
    oneShots += cat.oneShotTurns
  }
  if (edits === 0) return null
  return oneShots / edits
}

function cacheHitPercent(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens
  if (denom === 0) return 0
  return (cacheReadTokens / denom) * 100
}

function buildTopActivities(categories: PeriodData['categories']): MenubarPayload['current']['topActivities'] {
  return categories.slice(0, TOP_ACTIVITIES_LIMIT).map(cat => ({
    name: cat.name,
    cost: cat.cost,
    turns: cat.turns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models']): MenubarPayload['current']['topModels'] {
  return models
    .filter(m => m.name !== SYNTHETIC_MODEL_NAME)
    .slice(0, TOP_MODELS_LIMIT)
    .map(m => ({ name: m.name, cost: m.cost, calls: m.calls }))
}

function buildOptimize(optimize: OptimizeResult | null): MenubarPayload['optimize'] {
  if (!optimize || optimize.findings.length === 0) {
    return { findingCount: 0, savingsUSD: 0, topFindings: [] }
  }
  const { findings, costRate } = optimize
  const totalSavingsUSD = findings.reduce((s, f) => s + f.tokensSaved * costRate, 0)
  const topFindings = findings.slice(0, TOP_FINDINGS_LIMIT).map(f => ({
    title: f.title,
    impact: f.impact,
    savingsUSD: f.tokensSaved * costRate,
  }))
  return {
    findingCount: findings.length,
    savingsUSD: totalSavingsUSD,
    topFindings,
  }
}

function buildProviders(providers: ProviderCost[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const p of providers) {
    if (p.cost < 0) continue
    map[p.name.toLowerCase()] = p.cost
  }
  return map
}

function buildHistory(daily: DailyHistoryEntry[] | undefined): MenubarPayload['history'] {
  if (!daily || daily.length === 0) return { daily: [] }
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const trimmed = sorted.slice(-HISTORY_DAYS_LIMIT)
  return { daily: trimmed }
}

/**
 * Compute the plan/leverage block. Returns undefined when no plan is set;
 * the consumer then renders the legacy "spend" view.
 */
export function computeValuation(
  apiValueUSD: number,
  plan: { id: string; displayName: string; monthlyUsd: number } | null,
): ValuationBlock | undefined {
  if (!plan) return undefined
  const paidUSD = plan.monthlyUsd
  // Leverage is undefined when paid is 0 (nominally a "free" plan); use Infinity-clamp
  // to a large finite value so JSON consumers don't blow up on `Infinity`.
  const leverage = paidUSD > 0 ? apiValueUSD / paidUSD : 999
  return {
    paidUSD,
    apiValueUSD,
    leverage,
    plan: { id: plan.id, displayName: plan.displayName, monthlyUsd: plan.monthlyUsd },
  }
}

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  valuation?: ValuationBlock,
): MenubarPayload {
  return {
    schemaVersion: MENUBAR_SCHEMA_VERSION,
    generated: new Date().toISOString(),
    ...(valuation ? { valuation } : {}),
    current: {
      label: current.label,
      cost: current.cost,
      calls: current.calls,
      sessions: current.sessions,
      oneShotRate: aggregateOneShotRate(current.categories),
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
      providers: buildProviders(providers),
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
  }
}
