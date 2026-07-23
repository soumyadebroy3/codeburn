// Shared period-aggregation + menubar-payload building, extracted from main.ts
// so non-CLI consumers (the device-sharing host/server) can build the same
// MenubarPayload for a date range without importing the CLI entrypoint (which
// runs program.parse() on import). buildMenubarPayloadForRange is the fork's
// stand-in for upstream's usage-aggregator.ts equivalent. (#532/#567)
import { parseAllSessions } from './parser.js'
import { type PeriodData, type ProviderCost, type MenubarPayload, type WebEnrichment, buildMenubarPayload } from './menubar-json.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { codexCredits } from './codex-credits.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { getShortModelName } from './models.js'
import { buildTimeline } from './usage-timeline.js'

const SYNTHETIC_MODEL = '<synthetic>'
const WEB_TOP_LIMIT = 20
const WEB_PROJECT_LIMIT = 10
const WEB_MODEL_EFFICIENCY_LIMIT = 15

/**
 * The extra per-`current` breakdowns the web dashboard renders, aggregated from
 * the fully-parsed sessions. Kept out of buildPeriodData/buildMenubarPayload so
 * the menubar hot path and the device-sharing egress surface stay lean — these
 * are attached only on the web path (buildMenubarPayloadForRange enrich:true).
 * Every value is raw USD, matching the rest of the payload (the SPA formats it).
 */
export function buildWebEnrichment(projects: ProjectSummary[]): WebEnrichment {
  const sessions = projects.flatMap(p => p.sessions)

  const toolCalls: Record<string, number> = Object.create(null)
  const mcpCalls: Record<string, number> = Object.create(null)
  const skillAgg: Record<string, { turns: number; cost: number }> = Object.create(null)
  let agentSpawnCalls = 0
  let agentSpawnCost = 0

  for (const sess of sessions) {
    for (const [tool, d] of Object.entries(sess.toolBreakdown)) toolCalls[tool] = (toolCalls[tool] ?? 0) + d.calls
    for (const [server, d] of Object.entries(sess.mcpBreakdown)) mcpCalls[server] = (mcpCalls[server] ?? 0) + d.calls
    for (const [skill, d] of Object.entries(sess.skillBreakdown)) {
      if (!skillAgg[skill]) skillAgg[skill] = { turns: 0, cost: 0 }
      skillAgg[skill].turns += d.turns
      skillAgg[skill].cost += d.costUSD
    }
    for (const turn of sess.turns) {
      for (const call of turn.assistantCalls ?? []) {
        if (call.hasAgentSpawn) { agentSpawnCalls += 1; agentSpawnCost += Number.isFinite(call.costUSD) ? call.costUSD : 0 }
      }
    }
  }

  const tools = Object.entries(toolCalls)
    .sort(([, a], [, b]) => b - a)
    .slice(0, WEB_TOP_LIMIT)
    .map(([name, calls]) => ({ name, calls }))

  const mcpServers = Object.entries(mcpCalls)
    .sort(([, a], [, b]) => b - a)
    .slice(0, WEB_TOP_LIMIT)
    .map(([name, calls]) => ({ name, calls }))

  const skills = Object.entries(skillAgg)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, WEB_TOP_LIMIT)
    .map(([name, d]) => ({ name, turns: d.turns, cost: d.cost }))

  // The fork tracks whether a call spawned an agent (hasAgentSpawn) but not the
  // subagent TYPE (that lives in the Task tool input, which the parser doesn't
  // retain). So we surface one honest aggregate row rather than fabricating
  // per-type names. Empty when no agents were spawned (panel shows "No data").
  const subagents = agentSpawnCalls > 0
    ? [{ name: 'Agent tasks', calls: agentSpawnCalls, cost: agentSpawnCost }]
    : []

  const topProjects = [...projects]
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    .slice(0, WEB_PROJECT_LIMIT)
    .map(p => ({
      name: p.project,
      cost: p.totalCostUSD,
      sessions: p.sessions.length,
      avgCostPerSession: p.sessions.length > 0 ? p.totalCostUSD / p.sessions.length : 0,
    }))

  const modelEfficiency = [...aggregateModelEfficiency(projects).values()]
    .filter(m => getShortModelName(m.model) !== SYNTHETIC_MODEL && m.editTurns > 0)
    .map(m => ({
      name: getShortModelName(m.model),
      costPerEdit: m.costPerEditUSD ?? 0,
      // aggregateModelEfficiency.oneShotRate is a 0–100 percentage, but the SPA
      // renders modelEfficiency as `Math.round(oneShotRate * 100)%` (matching
      // the top-level current.oneShotRate, which IS a 0–1 fraction). Normalize
      // to a fraction here so it doesn't display double-scaled (e.g. 1670%).
      oneShotRate: (m.oneShotRate ?? 0) / 100,
    }))
    .sort((a, b) => b.costPerEdit - a.costPerEdit)
    .slice(0, WEB_MODEL_EFFICIENCY_LIMIT)

  return { topProjects, tools, subagents, skills, mcpServers, modelEfficiency }
}

export function computeProviderCosts(projects: ProjectSummary[]): ProviderCost[] {
  const providerCosts = new Map<string, number>()
  for (const proj of projects) {
    for (const session of proj.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls ?? []) {
          providerCosts.set(call.provider, (providerCosts.get(call.provider) ?? 0) + call.costUSD)
        }
      }
    }
  }
  return Array.from(providerCosts.entries()).map(([name, cost]) => ({ name, cost }))
}

export function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  // Null-prototype maps: model names (and categories) are untrusted transcript
  // strings, so a "__proto__"/"constructor" key must not bind to Object.prototype
  // and pollute it via `if (!map[k]) …; map[k].x += …`. See daily-cache.safeRecord.
  const catTotals: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = Object.create(null)
  const modelTotals: Record<string, { calls: number; cost: number }> = Object.create(null)
  // Per-model token split, kept alongside modelTotals only to compute Codex
  // credits (the fork's PeriodData.models carries {name,cost,calls}, no tokens). (#510)
  const modelTokenTotals: Record<string, { inputTokens: number; cacheReadTokens: number; outputTokens: number }> = Object.create(null)
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
      if (!modelTokenTotals[model]) modelTokenTotals[model] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
      modelTokenTotals[model].inputTokens += d.tokens.inputTokens
      modelTokenTotals[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelTokenTotals[model].outputTokens += d.tokens.outputTokens
    }
  }

  const codexCreditsTotal = Object.entries(modelTokenTotals).reduce((sum, [model, t]) => {
    const c = codexCredits(model, { inputTokens: t.inputTokens, cachedReadTokens: t.cacheReadTokens, outputTokens: t.outputTokens })
    return sum + (c ?? 0)
  }, 0)

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    codexCredits: codexCreditsTotal,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

/// Build a MenubarPayload for an arbitrary period + provider filter. The device
/// sharing host/server call this to produce the same shape the menubar renders,
/// which is then sanitized before transmission. Uses a straightforward full
/// parse of the range (the live-menubar today-parse-once fast path in the CLI's
/// status command is a spawn-latency optimization the sharing path doesn't need).
export async function buildMenubarPayloadForRange(
  periodInfo: { range: DateRange; label: string },
  opts: { provider?: string; optimize?: boolean; enrich?: boolean } = {},
): Promise<MenubarPayload> {
  const provider = opts.provider ?? 'all'
  const projects = await parseAllSessions(periodInfo.range, provider)
  const currentData = buildPeriodData(periodInfo.label, projects)
  const providers = computeProviderCosts(projects)
  // optimize findings are omitted for the shared payload (opts.optimize is
  // accepted for signature parity but shared summaries don't carry findings).
  const base = buildMenubarPayload(currentData, providers, null)
  // enrich is set ONLY by the web dashboard's local /api/usage path. The
  // menubar status path, `codeburn devices`, and the device-sharing server all
  // leave it off, so the extra breakdowns + granular timeline never touch the
  // hot menubar path nor the (separately reviewed) sharing egress surface.
  if (!opts.enrich) return base
  const timeline = buildTimeline(projects)
  return {
    ...base,
    current: { ...base.current, ...buildWebEnrichment(projects) },
    history: { ...base.history, ...(timeline ? { timeline } : {}) },
  }
}
