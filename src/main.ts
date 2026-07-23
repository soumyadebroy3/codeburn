import { Command } from 'commander'
import { safeRunGit } from './git-safe.js'
import { installMenubarApp } from './menubar-installer.js'
import { installTrayApp } from './tray-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { getShortModelName, loadPricing, setModelAliases, setPriceOverrides } from './models.js'
import { renderOverview } from './overview.js'
import { codexCredits, codexCreditRate } from './codex-credits.js'
import { parseAllSessions, filterProjectsByName, clearSessionCache } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { type PeriodData, type ProviderCost } from './menubar-json.js'
import { buildMenubarPayload, computeValuation } from './menubar-json.js'
import { buildPeriodData, computeProviderCosts, buildMenubarPayloadForRange } from './usage-payload.js'
import { getDaysInRange, ensureCacheHydrated, emptyCache, BACKFILL_DAYS, toDateString } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { renderDashboard } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { runContextCommand } from './context-tree.js'
import { registerActCommands } from './act/cli.js'
import { renderCompare } from './compare.js'
import { runShareServer } from './sharing/share-run.js'
import { runWebDashboard } from './web-dashboard.js'
import { addRemote, linkRemote, pullDevices, renderDevices, summarizeDeviceUsage } from './sharing/host.js'
import { browse } from './sharing/discovery.js'
import { ShareController } from './sharing/share-controller.js'
import { loadOrCreateIdentity } from './sharing/identity.js'
import { pairingCode } from './sharing/pairing.js'
import { promptChoice } from './sharing/prompt.js'
import { getSharingDir, loadRemotes, saveRemotes } from './sharing/store.js'
import type { UsageQuery } from './sharing/share-server.js'
import { hostname } from 'node:os'
import { getAllProviders, safeDiscoverSessions, allProviderNames } from './providers/index.js'
import { clearPlan, readConfig, readPlan, readAllPlans, saveConfig, savePlan, getConfigFilePath, type CodeburnConfig, type PlanId } from './config.js'
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

// A downstream reader that closes the pipe early (`| head`, quitting `less`, or
// a missing command) makes stdout writes fail with EPIPE. Exit cleanly rather
// than crashing with an unhandled error event.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

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

function assertScope(value: string, allowed: readonly string[], command: string): void {
  if (!allowed.includes(value)) {
    process.stderr.write(
      `codeburn ${command}: unknown scope "${value}". Valid values: ${allowed.join(', ')}.\n`
    )
    process.exit(1)
  }
}

function assertProvider(value: string, command: string): void {
  const names = allProviderNames()
  if (value === 'all' || names.includes(value)) return
  process.stderr.write(
    `codeburn ${command}: unknown provider "${value}". Valid values: all, ${names.join(', ')}.\n`
  )
  process.exit(1)
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
  setPriceOverrides(config.priceOverrides ?? {})
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
        // Codex credits consumed by this model (null for non-Codex models —
        // codexCreditRate returns null, which stands in for the missing
        // per-model `provider` field). (#510)
        credits: codexCreditRate(name) != null
          ? codexCredits(name, {
              inputTokens: rest.inputTokens,
              cachedReadTokens: rest.cacheReadTokens,
              outputTokens: rest.outputTokens,
            })
          : null,
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

function buildDailyHistory(days: ReturnType<typeof aggregateProjectsIntoDays>) {
  return days.map(d => ({
    date: d.date,
    cost: d.cost,
    calls: d.calls,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    // Merge raw model ids into friendly display names (claude-opus-4-8 ->
    // Opus 4.8) and collapse dated/pinned variants before taking the top 3,
    // so the trend tooltip shows clean names, not bare slugs.
    topModels: (() => {
      const merged = new Map<string, { name: string; cost: number; calls: number; inputTokens: number; outputTokens: number }>()
      for (const [n, m] of Object.entries(d.models)) {
        const name = getShortModelName(n)
        const acc = merged.get(name) ?? { name, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 }
        acc.cost += m.cost; acc.calls += m.calls
        acc.inputTokens += m.inputTokens; acc.outputTokens += m.outputTokens
        merged.set(name, acc)
      }
      return [...merged.values()].sort((a, b) => b.cost - a.cost).slice(0, 3)
    })(),
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
  // The HTML export reports the last period (the 30-day window, or the explicit
  // --from/--to custom range). Normalize leverage against that span.
  const htmlPeriodDays = args.customRange
    ? Math.max(1, Math.round((args.customRange.end.getTime() - args.customRange.start.getTime()) / 86_400_000))
    : 30
  const valuation = planRecord
    ? computeValuation(data.cost, {
        id: planRecord.id,
        displayName: planDisplayName(planRecord.id),
        monthlyUsd: planRecord.monthlyUsd,
      }, htmlPeriodDays)
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
  // Cache hit rate = reads / (fresh input + cache read + cache write). cache_write
  // tokens were processed fresh this turn (a miss) and then stored, so they belong
  // on the miss side of the denominator. Matches src/menubar-json.ts:cacheHitPercent,
  // dashboard.tsx, and compare-stats — every surface reports the same rate.
  const cacheHitDenom = totalInput + totalCacheRead + totalCacheWrite
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
    assertProvider(opts.provider, 'report')
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
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, projectScope.filter, opts.exclude, customRange, customRangeLabel)
  })

program
  .command('status')
  .description('Compact status output (today + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--scope <scope>', 'Usage scope for menubar-json: local, combined (paired devices)', 'local')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable). Default auto-scopes to the cwd git repo when run inside one.', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--all-projects', 'Show every project regardless of cwd (overrides cwd auto-scoping)')
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    assertScope(opts.scope, ['local', 'combined'], 'status')
    assertProvider(opts.provider, 'status')
    // --scope combined pulls each paired device's UNFILTERED usage, so a
    // provider/project/exclude filter can't be honored across the fleet —
    // reject the contradiction loudly rather than silently returning a local
    // filter on a combined roll-up.
    if (opts.scope === 'combined' && (opts.provider !== 'all' || opts.project.length > 0 || opts.exclude.length > 0)) {
      process.stderr.write('error: --scope combined cannot be combined with --provider, --project, or --exclude (paired devices report unfiltered usage)\n')
      process.exit(1)
    }
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
      // Hoisted so the per-provider fast path below can also reuse it.
      const todayRange: DateRange = { start: todayStart, end: new Date() }

      const cache = await hydrateCache()

      // Today's all-provider sessions feed three blocks below: the current
      // period (when .all), the providers list (when .all), and the daily
      // history (always). Parse + aggregate ONCE and reuse. Previously each
      // block built its own todayRange with a fresh `new Date()`, so
      // parseAllSessions's in-process cache key (which embeds range.end) never
      // matched and today's JSONL was cold-parsed three times per --all call —
      // the single most-spawned menubar command. One snapshot instant is also
      // more correct: every panel reflects the same moment.
      const todayAllProjects = fp(await parseAllSessions(todayRange, 'all'))
      const todayAllDays = aggregateProjectsIntoDays(todayAllProjects)

      // CURRENT PERIOD DATA
      // - .all provider: assemble from cache + today (fast)
      // - specific provider: parse the period range with provider filter (correct, but slower)
      let currentData: PeriodData
      let scanProjects: ProjectSummary[]
      let scanRange: DateRange

      if (isAllProviders) {
        // Today's sessions were parsed once above; historical data comes from cache to avoid double-counting
        const rangeStartStr = toDateString(periodInfo.range.start)
        const rangeEndStr = toDateString(periodInfo.range.end)
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        const todayInRange = todayAllDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const allDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        scanProjects = todayAllProjects
        scanRange = periodInfo.range
      } else {
        // Per-provider fast path: parse only today's sessions with the
        // provider filter (small, fast), then add the historical
        // cost+calls for that provider straight from the daily cache.
        // Avoids the 22 s re-parse of full session history that the old
        // path triggered every time the user clicked a per-provider tab
        // in the menubar. Ports upstream commit b0131f6.
        const todayProviderProjects = fp(await parseAllSessions(todayRange, pf))
        const todayData = buildPeriodData(periodInfo.label, todayProviderProjects)
        const todayDays = aggregateProjectsIntoDays(todayProviderProjects)
        const rangeStartStr = toDateString(periodInfo.range.start)
        const rangeEndStr = toDateString(periodInfo.range.end)
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        let histCost = 0, histCalls = 0
        for (const d of historicalDays) {
          const prov = d.providers[pf]
          if (prov) { histCost += prov.cost; histCalls += prov.calls }
        }
        currentData = {
          ...todayData,
          cost: todayData.cost + histCost,
          calls: todayData.calls + histCalls,
        }
        // Avoid an unused-var warning while keeping todayDays in scope for
        // later panels that want today-only project breakdowns.
        void todayDays
        scanProjects = todayProviderProjects
        scanRange = todayRange
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
        // Today parsed once above; historical provider costs come from cache
        const rangeStartStr = toDateString(periodInfo.range.start)
        const todayStr = toDateString(todayStart)
        const allDaysForProviders = [
          ...getDaysInRange(cache, rangeStartStr, yesterdayStr),
          ...todayAllDays.filter(d => d.date === todayStr),
        ]
        const providerTotals: Record<string, number> = Object.create(null) // untrusted keys; see buildPeriodData
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
          hasSessions: (await safeDiscoverSessions(p)).length > 0,
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
      // Today parsed once above; historical days come from cache
      const todayStrForHistory = toDateString(todayStart)
      const fullHistory = [...allCacheDays, ...todayAllDays.filter(d => d.date === todayStrForHistory)]
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
        const periodDays = Math.max(1, Math.round(
          (periodInfo.range.end.getTime() - periodInfo.range.start.getTime()) / 86_400_000,
        ))
        valuation = computeValuation(currentData.cost, {
          id: planRecord.id,
          displayName: planDisplayName(planRecord.id),
          monthlyUsd: planRecord.monthlyUsd,
        }, periodDays)
      }

      // Optimize-tab analytics (upstream PR #349). retryTax is the dollar
      // value of edit retries observed in scanProjects, broken down per
      // model. routingWaste is the counterfactual saving the user would
      // have realized by routing those edits to the cheapest reliable
      // model (≥90% one-shot rate, ≥5 edits). Both feed the menubar's
      // Optimize insight pill, which auto-hides when both totals are 0.
      const effMap = aggregateModelEfficiency(scanProjects)
      const retryTaxByModel = [...effMap.values()]
        .filter(m => m.retries > 0 && m.editTurns > 0)
        .map(m => ({
          name: m.model,
          taxUSD: m.retries * (m.editCostUSD / m.editTurns),
          retries: m.retries,
          retriesPerEdit: m.retriesPerEdit,
        }))
        .sort((a, b) => b.taxUSD - a.taxUSD)
      const retryTax = {
        totalUSD: retryTaxByModel.reduce((s, m) => s + m.taxUSD, 0),
        retries: retryTaxByModel.reduce((s, m) => s + m.retries, 0),
        editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
        byModel: retryTaxByModel.slice(0, 5),
      }
      const reliableModels = [...effMap.values()]
        .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5
          && (m.costPerEditUSD ?? 0) >= 0.01)
        .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
      const baseline = reliableModels[0]
      const routingWasteByModel = baseline
        ? [...effMap.values()]
            .filter(m => m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0))
            .map(m => {
              const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
              return {
                name: m.model,
                costPerEdit: m.costPerEditUSD ?? 0,
                editTurns: m.editTurns,
                actualUSD: m.editCostUSD,
                counterfactualUSD: counterfactual,
                savingsUSD: m.editCostUSD - counterfactual,
              }
            })
            .filter(m => m.savingsUSD > 0)
            .sort((a, b) => b.savingsUSD - a.savingsUSD)
        : []
      const routingWaste = {
        totalSavingsUSD: routingWasteByModel.reduce((s, m) => s + m.savingsUSD, 0),
        baselineModel: baseline?.model ?? '',
        baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
        byModel: routingWasteByModel.slice(0, 5),
      }

      const payload = buildMenubarPayload(currentData, providers, optimize, dailyHistory, valuation, retryTax, routingWaste)
      if (opts.scope === 'combined') {
        // Combined multi-device usage is best-effort enrichment on the menubar's
        // hot path. Never let pulling peers (or a corrupt remotes store) take
        // down the base local payload: on any failure, emit local data with
        // `combined` omitted so the menubar always gets a valid response.
        try {
          const localGetUsage = async (): Promise<typeof payload> => payload
          const results = await pullDevices(localGetUsage, { period: opts.period }, hostname(), {})
          payload.combined = summarizeDeviceUsage(results, {
            start: toDateString(periodInfo.range.start),
            end: toDateString(periodInfo.range.end),
          })
        } catch {
          // best-effort only: the local payload is still emitted below
        }
      }
      console.log(JSON.stringify(payload))
      return
    }

    if (opts.format === 'json') {
      // Parse today and month sequentially, clearing the in-memory session
      // cache between them so we don't pin both result sets in RAM at once.
      // Mitigates OOM on accounts with very large month-range session data.
      // Upstream PR #335.
      const todayData = buildPeriodData('today', fp(await parseAllSessions(getDateRange('today').range, pf)))
      clearSessionCache()
      const monthData = buildPeriodData('month', fp(await parseAllSessions(getDateRange('month').range, pf)))
      clearSessionCache()
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

    const monthProjects = fp(await parseAllSessions(getDateRange('month').range, pf))
    clearSessionCache()
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
    assertProvider(opts.provider, 'today')
    const projectScope = resolveProjectScope(opts)
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, projectScope.filter, opts.exclude)
      return
    }
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
    assertProvider(opts.provider, 'month')
    const projectScope = resolveProjectScope(opts)
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, projectScope.filter, opts.exclude)
      return
    }
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
    assertProvider(opts.provider, 'export')
    await loadPricing()
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
  .command('share [action]')
  .description("Securely share this device's usage with your other devices (opt-in LAN sharing). Actions: status. Supports --format json for status.")
  .option('--port <number>', 'Port to listen on', parseInteger, 7777)
  .option('--pair', 'Open a pairing window and print a PIN to add a new device')
  .option('--always', 'Keep sharing until stopped (default stops after 10 min idle)')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (action: string | undefined, opts) => {
    assertFormat(opts.format, ['text', 'json'], 'share')
    if (action === 'status') {
      const share = new ShareController(async () => ({}), opts.port)
      const status = await share.status()
      if (opts.format === 'json') {
        console.log(JSON.stringify(status))
        return
      }
      console.log(`\n  Sharing: ${status.sharing ? 'on' : 'off'}\n  Name: ${status.name}\n  Port: ${status.port}\n  Paired peers: ${status.peers}\n`)
      return
    }
    if (action !== undefined) {
      process.stderr.write('codeburn share: unknown action. Valid values: status.\n')
      process.exit(1)
    }
    if (opts.format === 'json') {
      process.stderr.write('codeburn share: --format json is only supported for `share status`.\n')
      process.exit(1)
    }
    await runShareServer({ port: opts.port, pair: !!opts.pair, always: !!opts.always })
  })

program
  .command('devices [action] [target]')
  .description('Combined usage across your devices. Actions: scan | add (find nearby & pair) | add <host> --pin <pin> (manual) | rm <name>. Supports --format json for read-only output and scan.')
  .option('--pin <pin>', 'Pairing PIN shown on the device you are adding')
  .option('-p, --period <period>', 'Period: today, week, 30days, month, all', 'month')
  .option('--port <number>', 'Default port when adding a device', parseInteger, 7777)
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (action: string | undefined, target: string | undefined, opts) => {
    assertFormat(opts.format, ['text', 'json'], 'devices')
    await loadPricing()
    if (action === 'scan') {
      const dir = getSharingDir()
      const id = await loadOrCreateIdentity(dir)
      const pairedFps = new Set((await loadRemotes(dir)).map((r) => r.fingerprint))
      const found = (await browse(2500))
        .filter((d) => d.fingerprint !== id.fingerprint)
        .map((d) => ({
          name: d.name,
          host: d.host,
          port: d.port,
          fingerprint: d.fingerprint,
          code: pairingCode(id.fingerprint, d.fingerprint),
          paired: pairedFps.has(d.fingerprint),
        }))
      if (opts.format === 'json') {
        console.log(JSON.stringify({ found }))
        return
      }
      if (found.length === 0) {
        console.log('\n  No devices found. On the other Mac run `codeburn share`, and make sure both are on the same Wi-Fi.\n')
        return
      }
      process.stdout.write('\n  Found devices:\n')
      for (const d of found) {
        process.stdout.write(`    ${d.name} (${d.host}:${d.port}) ${d.paired ? '[paired]' : `[code ${d.code}]`}\n`)
      }
      process.stdout.write('\n')
      return
    }
    if (opts.format === 'json' && action !== undefined) {
      process.stderr.write('codeburn devices: --format json is only supported for read-only devices output and scan.\n')
      process.exit(1)
    }
    if (action === 'add') {
      if (target && opts.pin) {
        // Manual pairing trusts the address you typed: it sends the PIN to
        // whoever answers at <target> without first confirming it's the right
        // device (unlike discover-and-approve, which matches a code on both
        // ends). Warn so a mistyped/hijacked address can't silently capture the
        // PIN. (security review — first-pairing TOCTOU)
        process.stderr.write(
          `\n  ⚠ Manual pairing sends the PIN to ${target} without verifying it's the right device.\n` +
          `    Double-check that address is the one shown on your other Mac.\n` +
          `    Tip: 'codeburn devices add' (no host) discovers and confirms a matching code instead.\n`
        )
        const device = await addRemote(target, opts.pin, { defaultPort: opts.port })
        console.log(`\n  Paired with "${device.name}" (${device.host}:${device.port}).\n`)
        return
      }
      process.stdout.write('\n  Looking for devices on your network...\n')
      const found = await browse(3000)
      if (found.length === 0) {
        console.error('  No devices found. On the other Mac run `codeburn share`, and make sure both are on the same Wi-Fi.\n')
        process.exit(1)
      }
      let chosen = found[0]!
      if (found.length > 1) {
        found.forEach((d, i) => process.stdout.write(`    ${i + 1}) ${d.name} (${d.host})\n`))
        const n = await promptChoice('  Connect to which? [number]', found.length)
        if (n < 1) {
          console.error('  Cancelled.\n')
          process.exit(1)
        }
        chosen = found[n - 1]!
      }
      const device = await linkRemote(chosen, {
        onCode: (code) =>
          process.stdout.write(`\n  Connecting to "${chosen.name}". Confirm this code on that device:  ${code}\n  Waiting for approval...\n`),
      })
      console.log(`\n  Paired with "${device.name}".\n`)
      return
    }
    if (action === 'rm' || action === 'remove') {
      const remotes = await loadRemotes()
      const next = remotes.filter((r) => r.name !== target && `${r.host}:${r.port}` !== target)
      await saveRemotes(next)
      console.log(`\n  Removed ${remotes.length - next.length} device(s).\n`)
      return
    }
    const localGetUsage = async (q: UsageQuery) => {
      const customRange = parseDateRangeFlags(q.from, q.to)
      const periodInfo = customRange
        ? { range: customRange, label: formatDateRangeLabel(q.from, q.to) }
        : getDateRange(toPeriod(q.period ?? opts.period))
      return buildMenubarPayloadForRange(periodInfo, { provider: 'all', optimize: false })
    }
    const results = await pullDevices(localGetUsage, { period: opts.period }, hostname(), {})
    if (opts.format === 'json') {
      console.log(JSON.stringify(summarizeDeviceUsage(results)))
      return
    }
    process.stdout.write('\n' + renderDevices(results))
  })

program
  .command('identity')
  .description('Show this device identity (name + cert fingerprint) used for sharing')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts: { format: string }) => {
    assertFormat(opts.format, ['text', 'json'], 'identity')
    const id = await loadOrCreateIdentity(getSharingDir())
    if (opts.format === 'json') {
      console.log(JSON.stringify({ name: id.name, fingerprint: id.fingerprint }))
      return
    }
    console.log(`\n  Name: ${id.name}\n  Fingerprint: ${id.fingerprint}\n`)
  })

program
  .command('web')
  .description('Open the local web dashboard in your browser (loopback-only)')
  .option('-p, --period <period>', 'Initial period: today, week, 30days, month, all', 'today')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--port <number>', 'Port to listen on (falls back to a free port if taken)', parseInteger, 4747)
  .option('--no-open', 'Do not open the browser automatically')
  .action(async (opts) => {
    assertProvider(opts.provider, 'web')
    await runWebDashboard({
      period: opts.period,
      provider: opts.provider,
      from: opts.from,
      to: opts.to,
      project: opts.project,
      exclude: opts.exclude,
      port: opts.port,
      open: opts.open,
    })
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
      // `--provider all` (the default) clears every stored plan.
      // `--provider <name>` removes only that provider's plan and leaves
      // others in place. Matches upstream PR #300's `plan reset --provider`
      // semantics. Errors are silent because clearPlan tolerates missing
      // keys.
      const scope = opts?.provider ?? 'all'
      if (scope === 'all') {
        await clearPlan()
        console.log('\n  All plans reset. API-pricing view is active.\n')
      } else {
        await clearPlan(scope)
        console.log(`\n  Plan reset for provider "${scope}". Other provider plans (if any) are retained.\n`)
      }
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
  .option('--apply', 'Interactively apply config-class fixes (backed up, journaled, undoable)')
  .option('--yes', 'With --apply: apply every appliable fix without prompting')
  .option('--dry-run', 'With --apply: print the plan and exit without changing anything')
  .option('--only <ids>', 'With --apply: restrict to a comma-separated list of finding ids')
  .action(async (opts) => {
    assertProvider(opts.provider, 'optimize')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    if (opts.apply) {
      const { runOptimizeApply } = await import('./act/optimize-apply.js')
      await runOptimizeApply(projects, range, { yes: opts.yes, dryRun: opts.dryRun, only: opts.only })
      return
    }
    await runOptimize(projects, label, range)
  })

program
  .command('context [session]')
  .description('Context token breakdown per session: what fills the window, by role, block type, and tool (experimental). No session argument opens an interactive browser.')
  .option('--list', 'List recent sessions to pick from')
  .option('--full', 'Cover the whole session history instead of the live (post-compaction) window')
  .option('--json', 'JSON output')
  .option('--provider <provider>', 'Session source: claude or codex', 'claude')
  .action(async (session: string | undefined, opts: { list?: boolean; full?: boolean; json?: boolean; provider?: string }) => {
    if (opts.provider !== 'claude' && opts.provider !== 'codex') {
      console.error('context: --provider must be claude or codex')
      process.exitCode = 1
      return
    }
    if (!session && !opts.list && !opts.json && process.stdout.isTTY && process.stdin.isTTY) {
      const { runContextTui } = await import('./context-tui.js')
      await runContextTui({ initialScope: opts.full ? 'full' : 'effective' })
      return
    }
    await runContextCommand(session, opts)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    assertProvider(opts.provider, 'compare')
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })

program
  .command('overview')
  .description('Plain-text usage overview, copy-pasteable (defaults to this month)')
  .option('-p, --period <period>', 'Period: today, week, 30days, month, all', 'month')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--no-color', 'Disable ANSI colors')
  .action(async (opts) => {
    assertProvider(opts.provider, 'overview')
    await loadPricing()
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
    const { range, label } = customRange
      ? { range: customRange, label: formatDateRangeLabel(opts.from, opts.to) }
      : getDateRange(toPeriod(opts.period))
    const projects = filterProjectsByName(await parseAllSessions(range, opts.provider), opts.project, opts.exclude)
    process.stdout.write(renderOverview(projects, { label, color: opts.color }))
  })

program
  .command('audit')
  .description("Token audit: raw provider token fields vs codeburn's displayed totals and cost derivation")
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--format <format>', 'Output format: table, json', 'table')
  .action(async (opts) => {
    assertProvider(opts.provider, 'audit')
    const { aggregateAudit, renderAuditTable, renderAuditJson } = await import('./audit-report.js')
    await loadPricing()

    let range
    if (opts.from || opts.to) {
      const customRange = parseDateRangeFlags(opts.from, opts.to)
      if (!customRange) {
        process.stderr.write('codeburn: --from and --to must be valid YYYY-MM-DD dates\n')
        process.exit(1)
      }
      range = customRange
    } else {
      range = getDateRange(opts.period).range
    }

    const projects = await parseAllSessions(range, opts.provider)
    const rows = await aggregateAudit(projects)

    const fmt = (opts.format ?? 'table').toLowerCase()
    if (fmt === 'json') {
      process.stdout.write(renderAuditJson(rows) + '\n')
    } else {
      if (rows.length === 0) {
        process.stdout.write('No model usage found for the selected period.\n')
        return
      }
      process.stdout.write(renderAuditTable(rows) + '\n')
    }
  })

type PriceOverrideConfig = NonNullable<CodeburnConfig['priceOverrides']>[string]

type PriceOverrideOptions = {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  remove?: string
  list?: boolean
}

function invalidUsdPerMillionRate(option: string, value: number | undefined): string | null {
  if (value === undefined) return null
  if (Number.isFinite(value) && value >= 0) return null
  return `Invalid ${option}: expected a finite number >= 0 (USD per 1,000,000 tokens).`
}

function formatPriceOverrideParts(rates: PriceOverrideConfig): string {
  const parts = [`input ${rates.input}`, `output ${rates.output}`]
  if (typeof rates.cacheRead === 'number') parts.push(`cache read ${rates.cacheRead}`)
  if (typeof rates.cacheCreation === 'number') parts.push(`cache creation ${rates.cacheCreation}`)
  return parts.join(', ')
}

program
  .command('price-override [model]')
  .description('Override or add local model pricing. Rates are USD per 1,000,000 tokens (e.g. --input 0.27).')
  .option('--input <usd-per-1M>', 'Input token price in USD per 1,000,000 tokens', parseNumber)
  .option('--output <usd-per-1M>', 'Output token price in USD per 1,000,000 tokens', parseNumber)
  .option('--cache-read <usd-per-1M>', 'Cache-read token price in USD per 1,000,000 tokens', parseNumber)
  .option('--cache-creation <usd-per-1M>', 'Cache-creation token price in USD per 1,000,000 tokens', parseNumber)
  .option('--remove <model>', 'Remove a price override')
  .option('--list', 'List configured price overrides')
  .action(async (model?: string, opts?: PriceOverrideOptions) => {
    const config = await readConfig()
    const overrides = new Map<string, PriceOverrideConfig>(Object.entries(config.priceOverrides ?? {}))

    if (opts?.list || (!model && !opts?.remove)) {
      const entries = [...overrides.entries()]
      if (entries.length === 0) {
        console.log('\n  No price overrides configured.')
        console.log('  Rates use USD per 1,000,000 tokens.')
        console.log(`  Config: ${getConfigFilePath()}`)
        console.log('  Add one with: codeburn price-override <model> --input <usd-per-1M> --output <usd-per-1M>\n')
      } else {
        console.log('\n  Price overrides (USD per 1,000,000 tokens):')
        for (const [name, rates] of entries) {
          console.log(`    ${name}: ${formatPriceOverrideParts(rates)}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!overrides.has(opts.remove)) {
        console.error(`\n  Price override not found: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      overrides.delete(opts.remove)
      config.priceOverrides = overrides.size > 0 ? Object.fromEntries(overrides) : undefined
      await saveConfig(config)
      console.log(`\n  Removed price override: ${opts.remove}\n`)
      return
    }

    const input = opts?.input
    const output = opts?.output
    const cacheRead = opts?.cacheRead
    const cacheCreation = opts?.cacheCreation
    if (!model || input === undefined || output === undefined) {
      console.error('\n  Usage: codeburn price-override <model> --input <usd-per-1M> --output <usd-per-1M> [--cache-read <usd-per-1M>] [--cache-creation <usd-per-1M>]\n')
      process.exitCode = 1
      return
    }

    const invalidRate = [
      invalidUsdPerMillionRate('--input', input),
      invalidUsdPerMillionRate('--output', output),
      invalidUsdPerMillionRate('--cache-read', cacheRead),
      invalidUsdPerMillionRate('--cache-creation', cacheCreation),
    ].find((message): message is string => message !== null)
    if (invalidRate) {
      console.error(`\n  ${invalidRate}\n`)
      process.exitCode = 1
      return
    }

    const override: PriceOverrideConfig = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
    }
    overrides.set(model, override)
    config.priceOverrides = Object.fromEntries(overrides)
    await saveConfig(config)
    console.log(`\n  Price override saved: ${model}: ${formatPriceOverrideParts(override)}`)
    console.log('  Unit: USD per 1,000,000 tokens')
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('yield')
  .description('Track which AI spend shipped to main vs reverted/abandoned (experimental)')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'week')
  .action(async (opts) => {
    const { computeYield, formatYieldSummary } = await import('./yield.js')
    await loadPricing()
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

// Review/undo the acting layer's applied changes: `act list | undo | report`. (#610)
registerActCommands(program)

program.parse()
