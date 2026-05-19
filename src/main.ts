import { Command } from 'commander'
import { safeRunGit } from './git-safe.js'
import { installMenubarApp } from './menubar-installer.js'
import { installTrayApp } from './tray-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing, setModelAliases } from './models.js'
import { parseAllSessions, filterProjectsByName } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { type PeriodData, type ProviderCost } from './menubar-json.js'
import { buildMenubarPayload, computeValuation } from './menubar-json.js'
import { getDaysInRange, ensureCacheHydrated, emptyCache, BACKFILL_DAYS, toDateString } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { renderDashboard } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { renderCompare } from './compare.js'
import { getAllProviders } from './providers/index.js'
import { clearPlan, readConfig, readPlan, readAllPlans, saveConfig, savePlan, getConfigFilePath, type PlanId } from './config.js'
import { detectPlans } from './plan-detect.js'
import { clampResetDay, getPlanUsageOrNull, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

/**
 * If the cwd is inside a git repo, return that repo's root path. Used to
 * auto-scope reports to the repo the user is in — running `codeburn export`
 * from /Users/soumya/terraform-aws aggregates only that project, not
 * everything codeburn knows about. Pass --all-projects to opt out.
 *
 * Routes through the same `safeRunGit` primitive that yield.ts uses, so
 * the two callers can't drift — they share `SAFE_GIT_ARGS`, `safeGitEnv`,
 * and the trusted-roots allowlist.
 */
function detectCwdRepoRoot(): string | null {
  const out = safeRunGit(['rev-parse', '--show-toplevel'], process.cwd(), 3_000)
  return out || null
}

/**
 * Resolve the effective project filter for a command. Precedence:
 *   1. Explicit --project <names> on the CLI wins (existing behaviour).
 *   2. Explicit --all-projects opts out of cwd scoping → no filter.
 *   3. Otherwise: auto-detect git repo root from cwd; if found, use that
 *      path as a single-element project filter (substring match against
 *      projectPath). Returns the resolved filter and a `scope` label that
 *      callers can render in report titles/banners.
 */
function resolveProjectScope(opts: { project?: string[]; allProjects?: boolean }): { filter: string[]; scope: { kind: 'explicit' | 'cwd' | 'all'; label: string | null } } {
  if (opts.project && opts.project.length > 0) {
    return { filter: opts.project, scope: { kind: 'explicit', label: opts.project.join(', ') } }
  }
  if (opts.allProjects) {
    return { filter: [], scope: { kind: 'all', label: null } }
  }
  const repoRoot = detectCwdRepoRoot()
  if (repoRoot) {
    return { filter: [repoRoot], scope: { kind: 'cwd', label: repoRoot } }
  }
  return { filter: [], scope: { kind: 'all', label: null } }
}

async function hydrateCache() {
  try {
    return await ensureCacheHydrated(
      (range) => parseAllSessions(range, 'all'),
      aggregateProjectsIntoDays,
    )
  } catch {
    return emptyCache()
  }
}

function collect(val: string, acc: string[]): string[] {
  acc.push(val)
  return acc
}

function parseNumber(value: string): number {
  return Number(value)
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10)
}

type JsonPlanSummary = {
  id: PlanId
  budget: number
  spent: number
  percentUsed: number
  status: 'under' | 'near' | 'over'
  projectedMonthEnd: number
  daysUntilReset: number
  periodStart: string
  periodEnd: string
}

function toJsonPlanSummary(planUsage: PlanUsage): JsonPlanSummary {
  return {
    id: planUsage.plan.id,
    budget: convertCost(planUsage.budgetUsd),
    spent: convertCost(planUsage.spentApiEquivalentUsd),
    percentUsed: Math.round(planUsage.percentUsed * 10) / 10,
    status: planUsage.status,
    projectedMonthEnd: convertCost(planUsage.projectedMonthUsd),
    daysUntilReset: planUsage.daysUntilReset,
    periodStart: planUsage.periodStart.toISOString(),
    periodEnd: planUsage.periodEnd.toISOString(),
  }
}

function assertFormat(value: string, allowed: readonly string[], command: string): void {
  if (!allowed.includes(value)) {
    process.stderr.write(
      `codeburn ${command}: unknown format "${value}". Valid values: ${allowed.join(', ')}.\n`
    )
    process.exit(1)
  }
}

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range, provider), project, exclude)
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary } = buildJsonReport(projects, label, period)
  const planUsage = await getPlanUsageOrNull()
  if (planUsage) {
    report.plan = toJsonPlanSummary(planUsage)
  }
  console.log(JSON.stringify(report, null, 2))
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)
  .option('--verbose', 'print warnings to stderr on read failures and skipped files')
  .option('--timezone <zone>', 'IANA timezone for date grouping (e.g. Asia/Tokyo, America/New_York)')

program.hook('preAction', async (thisCommand) => {
  const tz = thisCommand.opts<{ timezone?: string }>().timezone ?? process.env['CODEBURN_TZ']
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
    } catch {
      console.error(`\n  Invalid timezone: "${tz}". Use an IANA timezone like "America/New_York" or "Asia/Tokyo".\n`)
      process.exit(1)
    }
    process.env.TZ = tz
  }
  const config = await readConfig()
  setModelAliases(config.modelAliases ?? {})
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['CODEBURN_VERBOSE'] = '1'
  }
  await loadCurrency()
  // Plan auto-detect was removed in favour of an explicit, uniform
  // `codeburn plan set --provider <X> <plan>` flow for every supported
  // tool. See plan-detect.ts.
})

type ModelMapEntry = { calls: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
type CategoryMapEntry = { turns: number; cost: number; editTurns: number; oneShotTurns: number }

function buildDailyMap(sessions: ProjectSummary['sessions']): Record<string, { cost: number; calls: number }> {
  const dailyMap: Record<string, { cost: number; calls: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!turn.timestamp) continue
      const day = dateKey(turn.timestamp)
      dailyMap[day] ??= { cost: 0, calls: 0 }
      for (const call of turn.assistantCalls) {
        dailyMap[day].cost += call.costUSD
        dailyMap[day].calls += 1
      }
    }
  }
  return dailyMap
}

function buildModelMap(sessions: ProjectSummary['sessions']): Record<string, ModelMapEntry> {
  const modelMap: Record<string, ModelMapEntry> = {}
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      modelMap[model] ??= { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      modelMap[model].calls += d.calls
      modelMap[model].cost += d.costUSD
      modelMap[model].inputTokens += d.tokens.inputTokens
      modelMap[model].outputTokens += d.tokens.outputTokens
      modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
    }
  }
  return modelMap
}

function buildCategoryMap(sessions: ProjectSummary['sessions']): Record<string, CategoryMapEntry> {
  const catMap: Record<string, CategoryMapEntry> = {}
  for (const sess of sessions) {
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      catMap[cat] ??= { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
      catMap[cat].turns += d.turns
      catMap[cat].cost += d.costUSD
      catMap[cat].editTurns += d.editTurns
      catMap[cat].oneShotTurns += d.oneShotTurns
    }
  }
  return catMap
}

function buildToolMaps(sessions: ProjectSummary['sessions']): { tools: Record<string, number>; mcp: Record<string, number>; bash: Record<string, number> } {
  const tools: Record<string, number> = {}
  const mcp: Record<string, number> = {}
  const bash: Record<string, number> = {}
  for (const sess of sessions) {
    for (const [tool, d] of Object.entries(sess.toolBreakdown)) tools[tool] = (tools[tool] ?? 0) + d.calls
    for (const [server, d] of Object.entries(sess.mcpBreakdown)) mcp[server] = (mcp[server] ?? 0) + d.calls
    for (const [cmd, d] of Object.entries(sess.bashBreakdown)) bash[cmd] = (bash[cmd] ?? 0) + d.calls
  }
  return { tools, mcp, bash }
}

function sortedCallMap(m: Record<string, number>): Array<{ name: string; calls: number }> {
  return Object.entries(m).sort(([, a], [, b]) => b - a).map(([name, calls]) => ({ name, calls }))
}

function buildModelList(modelMap: Record<string, ModelMapEntry>, modelEfficiency: ReturnType<typeof aggregateModelEfficiency>) {
  return Object.entries(modelMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, { cost, ...rest }]) => {
      const efficiency = modelEfficiency.get(name)
      return {
        name,
        ...rest,
        cost: convertCost(cost),
        editTurns: efficiency?.editTurns ?? 0,
        oneShotTurns: efficiency?.oneShotTurns ?? 0,
        oneShotRate: efficiency?.oneShotRate ?? null,
        retriesPerEdit: efficiency?.retriesPerEdit ?? null,
        costPerEdit: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? convertCost(efficiency.costPerEditUSD)
          : null,
      }
    })
}

function buildActivityList(catMap: Record<string, CategoryMapEntry>) {
  return Object.entries(catMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      cost: convertCost(d.cost),
      turns: d.turns,
      editTurns: d.editTurns,
      oneShotTurns: d.oneShotTurns,
      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
    }))
}

function computeProviderCosts(projects: ProjectSummary[]): ProviderCost[] {
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

function buildDailyHistory(days: ReturnType<typeof aggregateProjectsIntoDays>) {
  return days.map(d => ({
    date: d.date,
    cost: d.cost,
    calls: d.calls,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    topModels: Object.entries(d.models).slice(0, 3).map(([n, m]) => ({
      name: n, cost: m.cost, calls: m.calls,
      inputTokens: m.inputTokens, outputTokens: m.outputTokens,
    })),
  }))
}

async function computeYieldForScope(
  projectScope: ReturnType<typeof resolveProjectScope>,
  customRange: DateRange | null,
) {
  try {
    const { computeYield } = await import('./yield.js')
    const yieldCwd = projectScope.scope.kind === 'cwd' || projectScope.scope.kind === 'explicit'
      ? (projectScope.scope.label ?? process.cwd())
      : process.cwd()
    return await computeYield(customRange ?? getDateRange('30days').range, yieldCwd)
  } catch {
    return null
  }
}

type WriteHtmlExportArgs = {
  periods: PeriodExport[]
  outputPath: string
  defaultName: string
  projectScope: ReturnType<typeof resolveProjectScope>
  customRange: DateRange | null
  redactPaths: boolean
}

async function writeHtmlExport(args: WriteHtmlExportArgs): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const { buildExportHtml } = await import('./export-html.js')
  const { detectSpikes } = await import('./anomaly.js')
  const { basename: pathBasename } = await import('node:path')

  const period = args.periods.at(-1)!
  const days = aggregateProjectsIntoDays(period.projects)
  const data = buildPeriodDataFromDays(days, period.label)

  const providers = computeProviderCosts(period.projects)
  const dailyHistory = buildDailyHistory(days)

  // Pull the user's plan (if set) so the HTML hero section can show
  // "$200 paid · $X value · Yx leverage" instead of the raw spend.
  const planRecord = await readPlan().catch(() => undefined)
  const valuation = planRecord
    ? computeValuation(data.cost, {
        id: planRecord.id,
        displayName: planDisplayName(planRecord.id),
        monthlyUsd: planRecord.monthlyUsd,
      })
    : undefined

  const payload = buildMenubarPayload(data, providers, null, dailyHistory, valuation)
  const spikes = detectSpikes(dailyHistory.map(d => ({ date: d.date, cost: d.cost })))

  // For the no-plan path, surface providers we know the user uses but
  // can't auto-detect a tier for.
  const existingPlans = await readAllPlans()
  const detection = await detectPlans(existingPlans).catch(() => ({ presenceOnly: [] }))

  const yieldSummary = await computeYieldForScope(args.projectScope, args.customRange)

  const titleScope = args.projectScope.scope.kind === 'cwd' || args.projectScope.scope.kind === 'explicit'
    ? ` — ${pathBasename(args.projectScope.scope.label ?? '')}`
    : ''

  const html = buildExportHtml({
    payload,
    projects: period.projects,
    spikes,
    yieldSummary,
    presenceOnly: detection.presenceOnly,
    title: `CodeBurn Report${titleScope} — ${period.label}`,
    redactPaths: args.redactPaths,
    scope: args.projectScope.scope,
  })
  const finalPath = args.outputPath.endsWith('.html') ? args.outputPath : `${args.defaultName}.html`
  await writeFile(finalPath, html, 'utf-8')
  return finalPath
}

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()

  const totalCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const totalInput = sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = sessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = sessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  // Match src/menubar-json.ts:cacheHitPercent: reads over reads+fresh-input. cache_write
  // counts tokens being stored, not served, so it doesn't belong in the denominator.
  const cacheHitDenom = totalInput + totalCacheRead
  const cacheHitPercent = cacheHitDenom > 0 ? Math.round((totalCacheRead / cacheHitDenom) * 1000) / 10 : 0

  const daily = Object.entries(buildDailyMap(sessions))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({ date, cost: convertCost(d.cost), calls: d.calls }))

  const projectList = projects.map(p => ({
    name: p.project,
    path: p.projectPath,
    cost: convertCost(p.totalCostUSD),
    avgCostPerSession: p.sessions.length > 0 ? convertCost(p.totalCostUSD / p.sessions.length) : null,
    calls: p.totalApiCalls,
    sessions: p.sessions.length,
  }))

  const models = buildModelList(buildModelMap(sessions), aggregateModelEfficiency(projects))
  const activities = buildActivityList(buildCategoryMap(sessions))
  const { tools: toolMap, mcp: mcpMap, bash: bashMap } = buildToolMaps(sessions)

  const topSessions = projects
    .flatMap(p => p.sessions.map(s => ({ project: p.project, sessionId: s.sessionId, date: s.firstTimestamp ? dateKey(s.firstTimestamp) : null, cost: convertCost(s.totalCostUSD), calls: s.apiCalls })))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  return {
    generated: new Date().toISOString(),
    currency: code,
    period,
    periodKey,
    overview: {
      cost: convertCost(totalCostUSD),
      calls: totalCalls,
      sessions: totalSessions,
      cacheHitPercent,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
      },
    },
    daily,
    projects: projectList,
    models,
    activities,
    tools: sortedCallMap(toolMap),
    mcpServers: sortedCallMap(mcpMap),
    shellCommands: sortedCallMap(bashMap),
    topSessions,
  }
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all', 'week')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'report')
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const projectScope = resolveProjectScope(opts)
    const period = toPeriod(opts.period)
    if (opts.format === 'json') {
      await loadPricing()
      await hydrateCache()
      if (customRange) {
        const label = formatDateRangeLabel(opts.from, opts.to)
        const projects = filterProjectsByName(
          await parseAllSessions(customRange, opts.provider),
          projectScope.filter,
          opts.exclude,
        )
        console.log(JSON.stringify(buildJsonReport(projects, label, 'custom'), null, 2))
      } else {
        await runJsonReport(period, opts.provider, projectScope.filter, opts.exclude)
      }
      return
    }
    await hydrateCache()
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, projectScope.filter, opts.exclude, customRange, customRangeLabel)
  })

function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number }> = {}
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
    }
  }

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

program
  .command('status')
  .description('Compact status output (today + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    await loadPricing()
    const pf = opts.provider
    const projectScope = resolveProjectScope(opts)
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, projectScope.filter, opts.exclude)
    if (opts.format === 'menubar-json') {
      const periodInfo = getDateRange(opts.period)
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
      const isAllProviders = pf === 'all'

      const cache = await hydrateCache()

      // CURRENT PERIOD DATA
      // - .all provider: assemble from cache + today (fast)
      // - specific provider: parse the period range with provider filter (correct, but slower)
      let currentData: PeriodData
      let scanProjects: ProjectSummary[]
      let scanRange: DateRange

      if (isAllProviders) {
        // Parse only today's sessions; historical data comes from cache to avoid double-counting
        const todayRange: DateRange = { start: todayStart, end: new Date() }
        const todayProjects = fp(await parseAllSessions(todayRange, 'all'))
        const todayDays = aggregateProjectsIntoDays(todayProjects)
        const rangeStartStr = toDateString(periodInfo.range.start)
        const rangeEndStr = toDateString(periodInfo.range.end)
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const allDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        scanProjects = todayProjects
        scanRange = periodInfo.range
      } else {
        const projects = fp(await parseAllSessions(periodInfo.range, pf))
        currentData = buildPeriodData(periodInfo.label, projects)
        scanProjects = projects
        scanRange = periodInfo.range
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
        // Parse only today; historical provider costs come from cache
        const todayRangeForProviders: DateRange = { start: todayStart, end: new Date() }
        const todayDaysForProviders = aggregateProjectsIntoDays(fp(await parseAllSessions(todayRangeForProviders, 'all')))
        const rangeStartStr = toDateString(periodInfo.range.start)
        const todayStr = toDateString(todayStart)
        const allDaysForProviders = [
          ...getDaysInRange(cache, rangeStartStr, yesterdayStr),
          ...todayDaysForProviders.filter(d => d.date === todayStr),
        ]
        const providerTotals: Record<string, number> = {}
        for (const d of allDaysForProviders) {
          for (const [name, p] of Object.entries(d.providers)) {
            providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
          }
        }
        for (const [name, cost] of Object.entries(providerTotals)) {
          providers.push({ name: displayNameByName.get(name) ?? name, cost })
        }
        // Parallelize discovery across providers — sequential await of each
        // discoverSessions() in a for-loop was the long pole on `report` for
        // users with many tools installed (each can be a directory walk + JSON
        // parse). Order in `providers` is no longer load-order; we sort below.
        const candidatesToProbe = allProviders.filter(p => !providers.some(pc => pc.name === p.displayName))
        const probed = await Promise.all(candidatesToProbe.map(async p => ({
          provider: p,
          hasSessions: (await p.discoverSessions()).length > 0,
        })))
        for (const { provider, hasSessions } of probed) {
          if (hasSessions) providers.push({ name: provider.displayName, cost: 0 })
        }
      } else {
        const display = displayNameByName.get(pf) ?? pf
        providers.push({ name: display, cost: currentData.cost })
      }

      // DAILY HISTORY (last 365 days)
      // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
      // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
      // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
      const historyStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
      const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)
      // Parse only today for history; historical days come from cache
      const todayRangeForHistory: DateRange = { start: todayStart, end: new Date() }
      const allTodayDaysForHistory = aggregateProjectsIntoDays(fp(await parseAllSessions(todayRangeForHistory, 'all')))
      const todayStrForHistory = toDateString(todayStart)
      const fullHistory = [...allCacheDays, ...allTodayDaysForHistory.filter(d => d.date === todayStrForHistory)]
      const dailyHistory = fullHistory.map(d => {
        if (isAllProviders) {
          const topModels = Object.entries(d.models)
            .filter(([name]) => name !== '<synthetic>')
            .sort(([, a], [, b]) => b.cost - a.cost)
            .slice(0, 5)
            .map(([name, m]) => ({
              name,
              cost: m.cost,
              calls: m.calls,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
            }))
          return {
            date: d.date,
            cost: d.cost,
            calls: d.calls,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            cacheReadTokens: d.cacheReadTokens,
            cacheWriteTokens: d.cacheWriteTokens,
            topModels,
          }
        }
        const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
        return {
          date: d.date,
          cost: prov.cost,
          calls: prov.calls,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: [],
        }
      })

      const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
      // Plan/valuation block: when the user has set `codeburn plan set
      // claude-max` (or similar), surface "$X paid · $Y API value · Zx
      // leverage" so the menubar / GNOME / scripts know this is a flat
      // subscription, not pay-as-you-go billing.
      const planRecord = await readPlan().catch(() => undefined)
      let valuation
      if (planRecord) {
        valuation = computeValuation(currentData.cost, {
          id: planRecord.id,
          displayName: planDisplayName(planRecord.id),
          monthlyUsd: planRecord.monthlyUsd,
        })
      }
      console.log(JSON.stringify(buildMenubarPayload(currentData, providers, optimize, dailyHistory, valuation)))
      return
    }

    if (opts.format === 'json') {
      await hydrateCache()
      const todayData = buildPeriodData('today', fp(await parseAllSessions(getDateRange('today').range, pf)))
      const monthData = buildPeriodData('month', fp(await parseAllSessions(getDateRange('month').range, pf)))
      const { code, rate } = getCurrency()
      const payload: {
        currency: string
        today: { cost: number; calls: number }
        month: { cost: number; calls: number }
        plan?: JsonPlanSummary
      } = {
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }
      const planUsage = await getPlanUsageOrNull()
      if (planUsage) {
        payload.plan = toJsonPlanSummary(planUsage)
      }
      console.log(JSON.stringify(payload))
      return
    }

    await hydrateCache()
    const monthProjects = fp(await parseAllSessions(getDateRange('month').range, pf))
    // Read the plan so the status line can switch to "Month value" + leverage
    // verdict when the user is on a flat subscription instead of pay-as-you-go.
    const planRecord = await readPlan().catch(() => undefined)
    const planForStatus = planRecord
      ? { displayName: planDisplayName(planRecord.id), monthlyUsd: planRecord.monthlyUsd }
      : null
    console.log(renderStatusBar(monthProjects, planForStatus))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'today')
    const projectScope = resolveProjectScope(opts)
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, projectScope.filter, opts.exclude)
      return
    }
    await hydrateCache()
    await renderDashboard('today', opts.provider, opts.refresh, projectScope.filter, opts.exclude)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'month')
    const projectScope = resolveProjectScope(opts)
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, projectScope.filter, opts.exclude)
      return
    }
    await hydrateCache()
    await renderDashboard('month', opts.provider, opts.refresh, projectScope.filter, opts.exclude)
  })

program
  .command('export')
  .description('Export usage data to CSV, JSON, or self-contained HTML')
  .option('-f, --format <format>', 'Export format: csv, json, html', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--redact-paths', 'Replace absolute project paths with salted hashes (safe to share)')
  .action(async (opts) => {
    assertFormat(opts.format, ['csv', 'json', 'html'], 'export')
    await loadPricing()
    await hydrateCache()
    const pf = opts.provider
    // Resolve the effective project scope: explicit --project wins, then
    // --all-projects opts out, then auto-detect from cwd. The yield panel
    // already scoped to cwd; this propagates the same scope to hero stats,
    // calendar, daily timeline, donuts, and per-project breakdown so the
    // report is internally consistent (issue surfaced by user testing).
    const projectScope = resolveProjectScope(opts)
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, projectScope.filter, opts.exclude)
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const periods: PeriodExport[] = customRange
      ? [{ label: formatDateRangeLabel(opts.from, opts.to), projects: fp(await parseAllSessions(customRange, pf)) }]
      : [
          { label: 'Today', projects: fp(await parseAllSessions(getDateRange('today').range, pf)) },
          { label: '7 Days', projects: fp(await parseAllSessions(getDateRange('week').range, pf)) },
          { label: '30 Days', projects: fp(await parseAllSessions(getDateRange('30days').range, pf)) },
        ]

    if (periods.every(p => p.projects.length === 0)) {
      console.log('\n  No usage data found.\n')
      return
    }

    const defaultName = `codeburn-${toDateString(new Date())}`
    const outputPath = opts.output ?? `${defaultName}.${opts.format}`

    let savedPath: string
    try {
      if (opts.redactPaths) {
        const { redactInPlace } = await import('./redact.js')
        for (const period of periods) await redactInPlace(period.projects)
      }
      if (opts.format === 'json') {
        savedPath = await exportJson(periods, outputPath)
      } else if (opts.format === 'html') {
        savedPath = await writeHtmlExport({
          periods,
          outputPath,
          defaultName,
          projectScope,
          customRange,
          redactPaths: !!opts.redactPaths,
        })
      } else {
        savedPath = await exportCsv(periods, outputPath)
      }
    } catch (err) {
      // Protection guards in export.ts (symlink refusal, non-codeburn folder refusal, etc.)
      // throw with a user-readable message. Print just the message, not the stack, so the CLI
      // doesn't spray its internals at the user.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Export failed: ${message}\n`)
      process.exit(1)
    }

    const exportedLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : 'Today + 7 Days + 30 Days'
    console.log(`\n  Exported (${exportedLabel}) to: ${savedPath}\n`)
  })

program
  .command('menubar')
  .description('Install and launch the macOS menubar app (one command, no clone)')
  .option('--force', 'Reinstall even if an older copy is already in ~/Applications')
  .action(async (opts: { force?: boolean }) => {
    try {
      const result = await installMenubarApp({ force: opts.force })
      console.log(`\n  Ready. ${result.installedPath}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Menubar install failed: ${message}\n`)
      process.exit(1)
    }
  })

program
  .command('tray')
  .description('Install and launch the Windows tray app (Windows only — equivalent of `codeburn menubar`)')
  .option('--force', 'Force-reinstall even when the same version is already installed')
  .action(async (opts: { force?: boolean }) => {
    try {
      const result = await installTrayApp({ force: opts.force })
      console.log(`\n  Installed from ${result.installerPath}.\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Tray install failed: ${message}\n`)
      process.exit(1)
    }
  })

program
  .command('currency [code]')
  .description('Set display currency (e.g. codeburn currency GBP)')
  .option('--symbol <symbol>', 'Override the currency symbol')
  .option('--reset', 'Reset to USD (removes currency config)')
  .action(async (code?: string, opts?: { symbol?: string; reset?: boolean }) => {
    if (opts?.reset) {
      const config = await readConfig()
      delete config.currency
      await saveConfig(config)
      console.log('\n  Currency reset to USD.\n')
      return
    }

    if (!code) {
      const { code: activeCode, rate, symbol } = getCurrency()
      if (activeCode === 'USD' && rate === 1) {
        console.log('\n  Currency: USD (default)')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log(`\n  Currency: ${activeCode}`)
        console.log(`  Symbol: ${symbol}`)
        console.log(`  Rate: 1 USD = ${rate} ${activeCode}`)
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    const upperCode = code.toUpperCase()
    if (!isValidCurrencyCode(upperCode)) {
      console.error(`\n  "${code}" is not a valid ISO 4217 currency code.\n`)
      process.exitCode = 1
      return
    }

    const config = await readConfig()
    config.currency = {
      code: upperCode,
      ...(opts?.symbol ? { symbol: opts.symbol } : {}),
    }
    await saveConfig(config)

    await loadCurrency()
    const { rate, symbol } = getCurrency()

    console.log(`\n  Currency set to ${upperCode}.`)
    console.log(`  Symbol: ${symbol}`)
    console.log(`  Rate: 1 USD = ${rate} ${upperCode}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('model-alias [from] [to]')
  .description('Map a provider model name to a canonical one for pricing (e.g. codeburn model-alias my-model claude-opus-4-6)')
  .option('--remove <from>', 'Remove an alias')
  .option('--list', 'List configured aliases')
  .action(async (from?: string, to?: string, opts?: { remove?: string; list?: boolean }) => {
    const config = await readConfig()
    const aliases = config.modelAliases ?? {}

    if (opts?.list || (!from && !opts?.remove)) {
      const entries = Object.entries(aliases)
      if (entries.length === 0) {
        console.log('\n  No model aliases configured.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log('\n  Model aliases:')
        for (const [src, dst] of entries) {
          console.log(`    ${src} -> ${dst}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!(opts.remove in aliases)) {
        console.error(`\n  Alias not found: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      delete aliases[opts.remove]
      config.modelAliases = Object.keys(aliases).length > 0 ? aliases : undefined
      await saveConfig(config)
      console.log(`\n  Removed alias: ${opts.remove}\n`)
      return
    }

    if (!from || !to) {
      console.error('\n  Usage: codeburn model-alias <from> <to>\n')
      process.exitCode = 1
      return
    }

    aliases[from] = to
    config.modelAliases = aliases
    await saveConfig(config)
    console.log(`\n  Alias saved: ${from} -> ${to}`)
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('plan [action] [id]')
  .description('Show or configure a subscription plan for overage tracking')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--monthly-usd <n>', 'Monthly plan price in USD (for custom)', parseNumber)
  .option('--provider <name>', 'Provider scope: all, claude, codex, cursor', 'all')
  .option('--reset-day <n>', 'Day of month plan resets (1-28)', parseInteger, 1)
  .action(async (action?: string, id?: string, opts?: { format?: string; monthlyUsd?: number; provider?: string; resetDay?: number }) => {
    assertFormat(opts?.format ?? 'text', ['text', 'json'], 'plan')
    const mode = action ?? 'show'

    if (mode === 'show') {
      const plan = await readPlan()
      const displayPlan = !plan || plan.id === 'none'
        ? { id: 'none', monthlyUsd: 0, provider: 'all', resetDay: 1, setAt: null }
        : {
            id: plan.id,
            monthlyUsd: plan.monthlyUsd,
            provider: plan.provider,
            resetDay: clampResetDay(plan.resetDay),
            setAt: plan.setAt,
          }
      if (opts?.format === 'json') {
        console.log(JSON.stringify(displayPlan))
        return
      }
      if (!plan || plan.id === 'none') {
        console.log('\n  Plan: none')
        console.log('  API-pricing view is active.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
        return
      }
      console.log(`\n  Plan: ${planDisplayName(plan.id)} (${plan.id})`)
      console.log(`  Budget: $${plan.monthlyUsd}/month`)
      console.log(`  Provider: ${plan.provider}`)
      console.log(`  Reset day: ${clampResetDay(plan.resetDay)}`)
      console.log(`  Set at: ${plan.setAt}`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'reset') {
      await clearPlan()
      console.log('\n  Plan reset. API-pricing view is active.\n')
      return
    }

    if (mode !== 'set') {
      console.error('\n  Usage: codeburn plan [set <id> | reset]\n')
      process.exitCode = 1
      return
    }

    if (!id || !isPlanId(id)) {
      console.error(`\n  Plan id must be one of: claude-pro, claude-max, cursor-pro, custom, none; got "${id ?? ''}".\n`)
      process.exitCode = 1
      return
    }

    const resetDay = opts?.resetDay ?? 1
    if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) {
      console.error(`\n  --reset-day must be an integer from 1 to 28; got ${resetDay}.\n`)
      process.exitCode = 1
      return
    }

    if (id === 'none') {
      await clearPlan()
      console.log('\n  Plan reset. API-pricing view is active.\n')
      return
    }

    if (id === 'custom') {
      if (opts?.monthlyUsd === undefined) {
        console.error('\n  Custom plans require --monthly-usd <positive number>.\n')
        process.exitCode = 1
        return
      }
      const monthlyUsd = opts.monthlyUsd
      if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
        console.error(`\n  --monthly-usd must be a positive number; got ${opts.monthlyUsd}.\n`)
        process.exitCode = 1
        return
      }
      const provider = opts?.provider ?? 'all'
      if (!isPlanProvider(provider)) {
        console.error(`\n  --provider must be one of: all, claude, codex, cursor; got "${provider}".\n`)
        process.exitCode = 1
        return
      }
      await savePlan({
        id: 'custom',
        monthlyUsd,
        provider,
        resetDay,
        setAt: new Date().toISOString(),
      })
      console.log(`\n  Plan set to custom ($${monthlyUsd}/month, ${provider}, reset day ${resetDay}).`)
      console.log(`  Config saved to ${getConfigFilePath()}\n`)
      return
    }

    const preset = getPresetPlan(id)
    if (!preset) {
      console.error(`\n  Unknown preset "${id}".\n`)
      process.exitCode = 1
      return
    }

    await savePlan({
      ...preset,
      resetDay,
      setAt: new Date().toISOString(),
    })
    console.log(`\n  Plan set to ${planDisplayName(preset.id)} ($${preset.monthlyUsd}/month).`)
    console.log(`  Provider: ${preset.provider}`)
    console.log(`  Reset day: ${resetDay}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('optimize')
  .description('Find token waste and get exact fixes')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    await loadPricing()
    await hydrateCache()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    await runOptimize(projects, label, range)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    await loadPricing()
    await hydrateCache()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })

program
  .command('yield')
  .description('Track which AI spend shipped to main vs reverted/abandoned (experimental)')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'week')
  .action(async (opts) => {
    const { computeYield, formatYieldSummary } = await import('./yield.js')
    await loadPricing()
    await hydrateCache()
    const { range, label } = getDateRange(opts.period)
    console.log(`\n  Analyzing yield for ${label}...\n`)
    const summary = await computeYield(range, process.cwd())
    console.log(formatYieldSummary(summary))
  })

program
  .command('diagnose')
  .description('Show which providers were discovered and what was skipped (verbose pipeline trace)')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const { runDiagnose } = await import('./diagnose.js')
    await runDiagnose({ json: opts.json })
  })

program
  .command('doctor')
  .description('Verify your environment (Node version, cache permissions, optional providers)')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const { runDoctor } = await import('./doctor.js')
    const exit = await runDoctor({ json: opts.json })
    process.exit(exit)
  })

program
  .command('import <syncDir>')
  .description('Merge dated JSONL exports from a multi-machine sync directory into the local cache')
  .action(async (syncDir: string) => {
    const { runImport, formatImportReport } = await import('./import-data.js')
    const report = await runImport(syncDir)
    console.log(formatImportReport(report))
    if (report.errors.length > 0) process.exit(1)
  })

program.parse()
