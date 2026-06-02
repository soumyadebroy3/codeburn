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
import { getShortModelName } from './models.js'

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
  /** Flat monthly amount the user pays (monthlyUsd from the configured plan). */
  paidUSD: number
  /** Sum of pay-as-you-go API rates × tokens for the displayed period. */
  apiValueUSD: number
  /**
   * monthlyValue / paidUSD. monthlyValue normalizes apiValueUSD to a 30-day
   * run-rate first, so leverage compares like-for-like against the monthly
   * price regardless of the displayed period. >= 1 means you're getting more
   * than you pay for.
   */
  leverage: number
  /** apiValueUSD scaled to a 30-day run-rate: apiValueUSD × 30 / periodDays. */
  monthlyValue?: number
  /** Number of calendar days the apiValueUSD figure covers. */
  periodDays?: number
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
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheHitPercent: number
    topActivities: Array<{
      name: string
      cost: number
      turns: number
      // Number of edit turns — the denominator behind oneShotRate. Forwarded so
      // the UI can show the sample size (a "100%" over 1 edit is not the same
      // claim as "100%" over 40) instead of implying the rate is over `turns`.
      editTurns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number
      calls: number
    }>
    providers: Record<string, number>
    /// Retry tax — money wasted on edit retries, per model. Feeds the
    /// menubar Optimize tab (upstream PR #349). When the totals are zero
    /// the Optimize pill stays hidden by the Swift side.
    retryTax: {
      totalUSD: number
      retries: number
      editTurns: number
      byModel: Array<{
        name: string
        taxUSD: number
        retries: number
        retriesPerEdit: number | null
      }>
    }
    /// Routing waste — counterfactual savings vs the cheapest reliable
    /// model. Same payload contract as retryTax. Upstream PR #349.
    routingWaste: {
      totalSavingsUSD: number
      baselineModel: string
      baselineCostPerEdit: number
      byModel: Array<{
        name: string
        costPerEdit: number
        editTurns: number
        actualUSD: number
        counterfactualUSD: number
        savingsUSD: number
      }>
    }
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

// Clamp non-finite values (NaN/Infinity from a malformed session file) to 0
// so they never reach JSON.stringify, where they serialize to `null` and break
// the menubar payload contract the Swift/GNOME decoders expect.
function finite(n: number): number {
  return Number.isFinite(n) ? n : 0
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

// Cache hit rate = share of total prompt-input tokens served from cache. The
// denominator includes cache writes: those are prompt tokens processed fresh
// this turn (a miss) that also got stored, so they belong on the miss side.
// Matches the TUI dashboard (dashboard.tsx) and compare-stats so every surface
// reports the same rate for the same workload.
function cacheHitPercent(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number {
  const denom = inputTokens + cacheReadTokens + cacheWriteTokens
  if (denom === 0) return 0
  return (cacheReadTokens / denom) * 100
}

function buildTopActivities(categories: PeriodData['categories']): MenubarPayload['current']['topActivities'] {
  return categories.slice(0, TOP_ACTIVITIES_LIMIT).map(cat => ({
    name: cat.name,
    cost: cat.cost,
    turns: cat.turns,
    editTurns: cat.editTurns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models']): MenubarPayload['current']['topModels'] {
  // Aggregate by display name so raw model ids (e.g. claude-opus-4-8) render as
  // friendly names (Opus 4.8) and version-pinned/dated variants of the same
  // model collapse into one row. Day-level aggregation keys by raw id for
  // accuracy; the friendly mapping happens here, at the display layer, so the
  // menubar/GNOME/Windows UIs don't show bare model slugs.
  const merged = new Map<string, { name: string; cost: number; calls: number }>()
  for (const m of models) {
    if (m.name === SYNTHETIC_MODEL_NAME) continue
    const name = getShortModelName(m.name)
    const acc = merged.get(name) ?? { name, cost: 0, calls: 0 }
    acc.cost += m.cost
    acc.calls += m.calls
    merged.set(name, acc)
  }
  return [...merged.values()]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, TOP_MODELS_LIMIT)
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
  periodDays?: number,
): ValuationBlock | undefined {
  if (!plan) return undefined
  const paidUSD = plan.monthlyUsd
  // A non-positive paid amount (only reachable via a hand-edited config) has no
  // meaningful leverage — skip the block rather than emit a bogus 999x sentinel
  // that renders literally as "999.0× leverage".
  if (!(paidUSD > 0)) return undefined
  // Normalize the period's API value to a 30-day run-rate before comparing to
  // the monthly price. Dividing a single-period value (e.g. today, or 30 days)
  // by the FULL monthly price made leverage look artificially small. periodDays
  // omitted => treat as a full month (no scaling) for backward compatibility.
  const days = periodDays && periodDays > 0 ? periodDays : 30
  const monthlyValue = apiValueUSD * (30 / days)
  const leverage = monthlyValue / paidUSD
  return {
    paidUSD,
    apiValueUSD,
    monthlyValue,
    periodDays: days,
    leverage,
    plan: { id: plan.id, displayName: plan.displayName, monthlyUsd: plan.monthlyUsd },
  }
}

/// Empty defaults for the retry-tax / routing-waste blocks. Used when the
/// caller (currently only the menubar-json status path) hasn't computed
/// model-efficiency yet — keeps the menubar Optimize pill hidden via the
/// `totalUSD > 0 || totalSavingsUSD > 0` check on the Swift side.
const EMPTY_RETRY_TAX: MenubarPayload['current']['retryTax'] = {
  totalUSD: 0,
  retries: 0,
  editTurns: 0,
  byModel: [],
}
const EMPTY_ROUTING_WASTE: MenubarPayload['current']['routingWaste'] = {
  totalSavingsUSD: 0,
  baselineModel: '',
  baselineCostPerEdit: 0,
  byModel: [],
}

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  valuation?: ValuationBlock,
  retryTax?: MenubarPayload['current']['retryTax'],
  routingWaste?: MenubarPayload['current']['routingWaste'],
): MenubarPayload {
  return {
    schemaVersion: MENUBAR_SCHEMA_VERSION,
    generated: new Date().toISOString(),
    ...(valuation ? { valuation } : {}),
    current: {
      label: current.label,
      cost: finite(current.cost),
      calls: finite(current.calls),
      sessions: finite(current.sessions),
      oneShotRate: aggregateOneShotRate(current.categories),
      inputTokens: finite(current.inputTokens),
      outputTokens: finite(current.outputTokens),
      cacheReadTokens: finite(current.cacheReadTokens),
      cacheWriteTokens: finite(current.cacheWriteTokens),
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens, current.cacheWriteTokens),
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
      providers: buildProviders(providers),
      retryTax: retryTax ?? EMPTY_RETRY_TAX,
      routingWaste: routingWaste ?? EMPTY_ROUTING_WASTE,
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
  }
}
