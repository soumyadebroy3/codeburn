/**
 * `codeburn export --html` — sophisticated single-file HTML report.
 *
 * Self-contained: no external scripts, fonts, or images. Inline SVG charts,
 * print-ready, dark-mode aware. Suitable for sharing with a tech lead, attaching
 * to a finance ticket, or pinning locally.
 *
 * Sections: hero stats · daily timeline (anomaly-highlighted) · per-project
 * breakdown · activity donut · model distribution · provider distribution ·
 * yield (if available) · top sessions · optimize findings · cache efficiency
 * panel.
 */

import type { MenubarPayload } from './menubar-json.js'
import type { ProjectSummary, SessionSummary } from './types.js'
import type { SpikeFinding } from './anomaly.js'
import type { YieldSummary } from './yield.js'
import type { ProviderPresence } from './plan-detect.js'

export type ExportContext = {
  payload: MenubarPayload
  projects: ProjectSummary[]
  spikes: SpikeFinding[]
  yieldSummary?: YieldSummary | null
  /**
   * Providers we know the user uses (sessions on disk) but couldn't
   * auto-detect a plan for. Drives the no-plan hint card. Empty array means
   * either everything is configured or the user runs only BYOK / pay-as-
   * you-go tools — in which case the report shows no banner at all.
   */
  presenceOnly?: ProviderPresence[]
  /**
   * Scope of the report data (set by cli.ts). When kind === 'cwd' or
   * 'explicit' the report renders a "scoped to <X>" subtitle so readers
   * know they're looking at one repo instead of the global rollup.
   */
  scope?: { kind: 'explicit' | 'cwd' | 'all'; label: string | null }
  title?: string
  redactPaths?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatUSD(n: number, exact = false): string {
  if (!exact && Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  }
  return `$${n.toFixed(2).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10) : iso
}

// Pre-defined palette so charts are colour-stable across reports.
const PALETTE = [
  '#FF8C42', '#5BF5E0', '#FFD700', '#5BF5A0', '#A0A0FF',
  '#F55B5B', '#FF6FAA', '#82CFFD', '#B388EB', '#5DADE2',
  '#7DCEA0', '#F4D03F', '#E59866', '#85929E', '#D7BDE2',
]

const SEV_COLOR: Record<SpikeFinding['severity'], string> = {
  mild: '#FFD700',
  strong: '#F57C00',
  extreme: '#C62828',
}

const IMPACT_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: '#C62828',
  medium: '#F57C00',
  low: '#777777',
}

// ────────────────────────────────────────────────────────────────────────────
// SVG charts
// ────────────────────────────────────────────────────────────────────────────

type DailyHistoryEntry = MenubarPayload['history']['daily'][number]

// ────────────────────────────────────────────────────────────────────────────
// Calendar heatmap (Statuspage-style)
// ────────────────────────────────────────────────────────────────────────────

const HEAT_PALETTE = ['#9bd87a', '#c5e866', '#f5c242', '#f4914e', '#e54848']

/**
 * Quintile-bucket the non-zero costs in `daily` and return a function that
 * maps a cost to a colour. Quintiles within the visible window so the chart
 * always uses the full palette regardless of whether the user spent $5/day
 * or $500/day in absolute terms.
 */
function costColorScale(daily: DailyHistoryEntry[]): (cost: number) => string {
  const nonZero = daily.map(d => d.cost).filter(c => c > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return () => HEAT_PALETTE[0]
  const q = (frac: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * frac))]
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)]
  return (cost: number) => {
    if (cost <= 0) return HEAT_PALETTE[0]
    for (let i = 0; i < cuts.length; i++) if (cost <= cuts[i]) return HEAT_PALETTE[i]
    return HEAT_PALETTE[4]
  }
}

function calendarHeatmap(daily: DailyHistoryEntry[], spikes: SpikeFinding[]): string {
  if (daily.length === 0) return '<div class="empty">No daily history available.</div>'
  const byDate = new Map(daily.map(d => [d.date, d]))
  const spikeDates = new Map(spikes.map(s => [s.date, s]))
  const colorFor = costColorScale(daily)

  // Bucket daily entries into months.
  const months = new Map<string, DailyHistoryEntry[]>()
  for (const d of daily) {
    const ym = d.date.slice(0, 7)
    if (!months.has(ym)) months.set(ym, [])
    months.get(ym)!.push(d)
  }
  const sortedMonths = Array.from(months.keys()).sort((a, b) => a.localeCompare(b))

  // Limit to the most recent 12 months so the calendar stays scannable;
  // anything older becomes a single "+ N earlier months not shown" line so
  // the truncation is visible instead of silent.
  const MAX_VISIBLE_MONTHS = 12
  const visible = sortedMonths.slice(-MAX_VISIBLE_MONTHS)
  const hiddenCount = sortedMonths.length - visible.length

  function monthBlock(ym: string): string {
    const [yy, mm] = ym.split('-').map(Number)
    const monthName = new Date(Date.UTC(yy, mm - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
    const total = (months.get(ym) ?? []).reduce((s, d) => s + d.cost, 0)
    // Find the leading offset so the first day lands in its proper weekday column.
    // Sunday-first to match Statuspage. Fall back to absolute-position math so
    // we never mis-align around DST.
    const firstDow = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay()

    // Render each week as its own flex row of <div> cells. Earlier we used
    // a single CSS Grid with empty <span> elements, but adjacent empty
    // spans with display:block were rendering as one fused rectangle in
    // some browsers (the grid gap collapsed). Per-week <div>s with explicit
    // flex gap is layout that browsers handle uniformly.
    type Cell = { iso: string | null; color: string; tooltip: string; spikeClass: string }
    const blank = (): Cell => ({ iso: null, color: '', tooltip: '', spikeClass: '' })
    const allCells: Cell[] = []
    for (let i = 0; i < firstDow; i++) allCells.push(blank())

    // For the CURRENT month, only render days up to today — future days
    // haven't happened yet and showing them as "no data" cells is
    // misleading. Past months render in full. The trailing week of any
    // month (current or past) is allowed to be short; that's the natural
    // shape of a month boundary and we deliberately do NOT pad to 7.
    //
    // Use LOCAL date for "today" — the user's intuition about today is
    // local. UTC-only would clip the wrong day for users in negative-UTC
    // zones around midnight (PST: UTC May 8 00:30 = May 7 17:30 local;
    // they expect to see May 7 cell, not May 8).
    const today = new Date()
    const lastRenderableDay = (yy === today.getFullYear() && mm === today.getMonth() + 1)
      ? today.getDate()
      : daysInMonth

    for (let day = 1; day <= lastRenderableDay; day++) {
      const iso = `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const entry = byDate.get(iso)
      if (!entry) {
        allCells.push({ iso, color: '', tooltip: `${iso}: no data`, spikeClass: '' })
        continue
      }
      const color = colorFor(entry.cost)
      const spike = spikeDates.get(iso)
      const tip = `${iso} · ${formatUSD(entry.cost, true)} · ${entry.calls} calls`
        + (spike ? ` · spike (${spike.severity})` : '')
      allCells.push({ iso, color, tooltip: tip, spikeClass: spike ? ` spike-${spike.severity}` : '' })
    }

    const weeks: Cell[][] = []
    for (let i = 0; i < allCells.length; i += 7) weeks.push(allCells.slice(i, i + 7))

    const renderCell = (c: Cell) => {
      if (!c.color) {
        // Empty cell (leading dow filler or no data day).
        const t = c.tooltip ? ` title="${escapeHtml(c.tooltip)}"` : ''
        return `<div class="cell cell-empty"${t}></div>`
      }
      return `<div class="cell${c.spikeClass}" style="background:${c.color}" title="${escapeHtml(c.tooltip)}"></div>`
    }

    return `<div class="cal-month">
      <div class="cal-head">
        <div class="cal-name">${escapeHtml(monthName)}</div>
        <div class="cal-total">${formatUSD(total, true)}</div>
      </div>
      <div class="cal-grid">${weeks.map(w => `<div class="cal-week">${w.map(renderCell).join('')}</div>`).join('')}</div>
    </div>`
  }

  const truncationNote = hiddenCount > 0
    ? `<div class="cal-truncated">+ ${hiddenCount} earlier month${hiddenCount === 1 ? '' : 's'} not shown · re-run with a tighter <code>--from</code> / <code>--to</code> to focus, or query the JSON export for full history</div>`
    : ''

  return `<div class="cal-row">
    ${visible.map(monthBlock).join('')}
  </div>
  ${truncationNote}
  <div class="cal-legend">
    <span class="cal-legend-label">Less</span>
    ${HEAT_PALETTE.map(c => `<span class="cell" style="background:${c}"></span>`).join('')}
    <span class="cal-legend-label">More</span>
    <span class="cal-legend-spacer"></span>
    <span class="cell spike-extreme"></span><span class="cal-legend-label">spike</span>
  </div>`
}

/**
 * Pick a "nice" tick interval (round multiple of 1/2/5 × 10^k) so the axis
 * never reads as $40.48 / $80.95 / etc. Returns the rounded max + the
 * step between tick lines.
 */
function niceScale(rawMax: number, targetTicks = 5): { niceMax: number; step: number } {
  // Fast-path for non-finite or non-positive input. Without this, NaN /
  // Infinity / 0 propagate through Math.log10 → Math.pow → step=NaN, and
  // the subsequent `for (let v = 0; v <= max; v += step)` loop never
  // terminates.
  if (!Number.isFinite(rawMax) || rawMax <= 0) return { niceMax: 1, step: 1 }
  const roughStep = rawMax / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const norm = roughStep / mag
  const stepMul = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  const step = stepMul * mag
  if (!Number.isFinite(step) || step <= 0) return { niceMax: 1, step: 1 }
  const niceMax = Math.ceil(rawMax / step) * step
  return { niceMax, step }
}

function dailyTimeline(daily: DailyHistoryEntry[], spikes: SpikeFinding[]): string {
  if (daily.length === 0) return '<div class="empty">No daily history available.</div>'

  // Fill quiet days (zero usage) with cost=0 so the x-axis is calendar-linear,
  // not data-day-indexed. Without this, three consecutive bars in the chart
  // could span anywhere from 3 to 30 calendar days depending on how many
  // quiet days fell between them, distorting the time axis, the 7-day moving
  // average, and the weekend bands.
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const filled: DailyHistoryEntry[] = []
  if (sorted.length > 0) {
    const start = new Date(sorted[0].date + 'T00:00:00Z')
    const end = new Date(sorted.at(-1)!.date + 'T00:00:00Z')
    const byDate = new Map(sorted.map(d => [d.date, d]))
    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      const iso = new Date(t).toISOString().slice(0, 10)
      const found = byDate.get(iso)
      if (found) filled.push(found)
      else filled.push({
        date: iso, cost: 0, calls: 0,
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [],
      })
    }
  }
  const series = filled.length > 0 ? filled : sorted

  const W = 820
  const H = 240
  const PAD_L = 56
  const PAD_R = 16
  const PAD_T = 20
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const rawMax = Math.max(1, ...series.map(d => d.cost))
  const { niceMax, step } = niceScale(rawMax, 5)
  const max = niceMax
  const barW = innerW / series.length
  const spikeDates = new Map(spikes.map(s => [s.date, s]))

  // Weekend shading — light bands behind Sat + Sun bars to give the eye a
  // rhythm without competing with the data.
  const weekendBands: string[] = []
  for (let i = 0; i < series.length; i++) {
    const dow = new Date(series[i].date + 'T00:00:00Z').getUTCDay()
    if (dow !== 0 && dow !== 6) continue   // Sun=0, Sat=6
    const x = PAD_L + i * barW
    weekendBands.push(`<rect x="${x}" y="${PAD_T}" width="${barW}" height="${innerH}" class="weekend"/>`)
  }

  // Y-axis grid lines + tick labels at nice round dollar amounts.
  const yLabels: string[] = []
  for (let v = 0; v <= max + 1e-9; v += step) {
    const y = PAD_T + innerH - (innerH * v) / max
    yLabels.push(
      `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" class="grid"/>` +
      `<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" class="axis">${formatUSD(v)}</text>`,
    )
  }

  const bars = series.map((d, i) => {
    if (d.cost <= 0) return ''   // skip drawing zero bars; the gap visualises the quiet day
    const x = PAD_L + i * barW
    const h = (d.cost / max) * innerH
    const y = PAD_T + innerH - h
    const isSpike = spikeDates.has(d.date)
    const color = isSpike ? SEV_COLOR[spikeDates.get(d.date)!.severity] : '#5BF5E0'
    const tooltip = `${d.date}: ${formatUSD(d.cost, true)} · ${d.calls} calls`
        + (isSpike ? ` · spike (${spikeDates.get(d.date)!.severity})` : '')
    return `<rect x="${x + 1}" y="${y}" width="${Math.max(2, barW - 2)}" height="${h}" fill="${color}" class="bar"><title>${escapeHtml(tooltip)}</title></rect>`
  }).join('')

  // Moving-average trend line removed per UX feedback — the dashed overlay
  // competed visually with the bars and added no signal a careful reader
  // couldn't get from the bar heights alone. Bars + spike highlights are
  // enough.

  // X-axis: pick ticks with a minimum pixel gap so labels never overlap.
  const MIN_LABEL_GAP_PX = 80
  const xTicks: string[] = []
  let lastTickX = -Infinity
  for (let i = 0; i < series.length; i++) {
    const x = PAD_L + i * barW + barW / 2
    if (x - lastTickX < MIN_LABEL_GAP_PX) continue
    lastTickX = x
    xTicks.push(`<text x="${x}" y="${H - 10}" text-anchor="middle" class="axis">${shortDate(series[i].date)}</text>`)
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily spend timeline">
    ${weekendBands.join('')}
    ${yLabels.join('')}
    ${bars}
    ${xTicks.join('')}
  </svg>
  <div class="chart-legend">
    <span class="cl-swatch cl-bar"></span>daily spend
    <span class="cl-swatch cl-spike"></span>spike day
    <span class="cl-swatch cl-weekend"></span>weekend
  </div>`
}

function donut(items: Array<{ label: string; value: number; color: string }>, centerLabel: string, centerValue: string): string {
  const total = items.reduce((s, i) => s + i.value, 0)
  if (total <= 0) return '<div class="empty">No data.</div>'
  const W = 220
  const cx = W / 2
  const cy = W / 2
  const r = 90
  const inner = 60
  let acc = 0
  const segments: string[] = []
  for (const it of items) {
    if (it.value <= 0) continue
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2
    acc += it.value
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2
    const large = end - start > Math.PI ? 1 : 0
    const x1 = cx + r * Math.cos(start)
    const y1 = cy + r * Math.sin(start)
    const x2 = cx + r * Math.cos(end)
    const y2 = cy + r * Math.sin(end)
    const xi1 = cx + inner * Math.cos(end)
    const yi1 = cy + inner * Math.sin(end)
    const xi2 = cx + inner * Math.cos(start)
    const yi2 = cy + inner * Math.sin(start)
    const path = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
      `L ${xi1} ${yi1}`,
      `A ${inner} ${inner} 0 ${large} 0 ${xi2} ${yi2}`,
      'Z',
    ].join(' ')
    const tooltip = `${it.label}: ${formatUSD(it.value, true)} (${((it.value / total) * 100).toFixed(1)}%)`
    segments.push(`<path d="${path}" fill="${it.color}"><title>${escapeHtml(tooltip)}</title></path>`)
  }
  return `<svg viewBox="0 0 ${W} ${W}" class="donut" role="img">
    ${segments.join('')}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-value">${escapeHtml(centerValue)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="donut-label">${escapeHtml(centerLabel)}</text>
  </svg>`
}

function legend(items: Array<{ label: string; value: number; color: string }>, total: number, max = 8): string {
  const top = items.slice(0, max)
  const rest = items.slice(max)
  const restCost = rest.reduce((s, i) => s + i.value, 0)
  const restPct = total > 0 ? ((restCost / total) * 100).toFixed(1) : '0.0'
  const moreLine = rest.length > 0
    ? `<li class="more">+ ${rest.length} more · ${formatUSD(restCost, true)} <em>${restPct}%</em></li>`
    : ''
  return `<ul class="legend">${top.map(i => {
    const pct = total > 0 ? ((i.value / total) * 100).toFixed(1) : '0.0'
    return `<li title="${escapeHtml(i.label)}"><span class="dot" style="background:${i.color}"></span><span class="lab">${escapeHtml(i.label)}</span><span class="val">${formatUSD(i.value, true)} <em>${pct}%</em></span></li>`
  }).join('')}${moreLine}</ul>`
}

function projectBars(projects: ProjectSummary[], total: number, redacted: boolean): string {
  const sorted = [...projects].sort((a, b) => b.totalCostUSD - a.totalCostUSD).slice(0, 12)
  if (sorted.length === 0) return '<div class="empty">No projects in this window.</div>'
  return `<table class="bars"><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Cost</th><th class="num">Share</th><th></th></tr></thead><tbody>${sorted.map(p => {
    const pct = total > 0 ? (p.totalCostUSD / total) * 100 : 0
    const label = redacted ? p.project : (p.projectPath || p.project)
    return `<tr>
      <td class="proj">${escapeHtml(label)}</td>
      <td class="num">${p.sessions.length}</td>
      <td class="num">${formatUSD(p.totalCostUSD, true)}</td>
      <td class="num pct">${pct.toFixed(1)}%</td>
      <td class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%"></div></div></td>
    </tr>`
  }).join('')}</tbody></table>`
}

function topSessions(projects: ProjectSummary[], redacted: boolean, limit = 10): string {
  const all: Array<{ session: SessionSummary; project: string }> = []
  for (const p of projects) {
    for (const s of p.sessions) all.push({ session: s, project: redacted ? p.project : (p.projectPath || p.project) })
  }
  all.sort((a, b) => b.session.totalCostUSD - a.session.totalCostUSD)
  const top = all.slice(0, limit)
  if (top.length === 0) return '<div class="empty">No sessions.</div>'
  return `<table><thead><tr><th>Session</th><th>Project</th><th class="num">API calls</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${top.map(({ session: s, project }) => {
    const totalTokens = s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens
    return `<tr>
      <td><code>${escapeHtml(s.sessionId.slice(0, 12))}</code></td>
      <td class="proj">${escapeHtml(project)}</td>
      <td class="num">${s.apiCalls}</td>
      <td class="num">${formatTokens(totalTokens)}</td>
      <td class="num">${formatUSD(s.totalCostUSD, true)}</td>
    </tr>`
  }).join('')}</tbody></table>`
}

function tokenMixBar(p: MenubarPayload['current']): string {
  const cacheRead = p.cacheHitPercent
  const inputPct = 100 - cacheRead
  return `<div class="token-mix">
    <div class="seg seg-cache" style="flex-basis:${cacheRead}%" title="Cache reads: ${cacheRead.toFixed(1)}%">
      <span>${cacheRead.toFixed(0)}% cached</span>
    </div>
    <div class="seg seg-fresh" style="flex-basis:${inputPct}%" title="Fresh input: ${inputPct.toFixed(1)}%">
      <span>${inputPct.toFixed(0)}% fresh</span>
    </div>
  </div>
  <div class="caption">Cache reads carry only ~10% of fresh-input price; high cache hit drives spend down.</div>`
}

function planBanner(v: NonNullable<MenubarPayload['valuation']>, autoDetected: boolean): string {
  const planName = v.plan?.displayName ?? 'Plan'
  const isUnder = v.leverage < 1
  const className = isUnder ? 'plan-banner under' : 'plan-banner'
  const verdict = isUnder
    ? `Underutilizing — you'd save by downgrading.`
    : v.leverage >= 3
      ? `Heavy use — your plan is paying off.`
      : `Plan covers your usage.`
  const detectedNote = autoDetected
    ? `<div class="pb-auto">auto-detected · run \`codeburn plan\` to override</div>`
    : ''
  return `<div class="${className}">
    <div class="pb-cell">
      <span class="pb-l">${escapeHtml(planName)} subscription</span>
      <span class="pb-v">${formatUSD(v.paidUSD)}<small style="font-size:.6em;font-weight:500;opacity:.7"> /mo flat</small></span>
      <span class="pb-d">what you actually pay</span>
      ${detectedNote}
    </div>
    <div class="arrow">→ this period →</div>
    <div class="pb-cell">
      <span class="pb-l">API-equivalent value</span>
      <span class="pb-v">${formatUSD(v.apiValueUSD)}<small style="font-size:.6em;font-weight:500;opacity:.7"> · ${v.leverage.toFixed(1)}× leverage</small></span>
      <span class="pb-d">${escapeHtml(verdict)}</span>
    </div>
  </div>`
}

function noPlanHint(presence: ProviderPresence[]): string {
  if (presence.length === 0) return ''
  const lines = presence.map(p => {
    const presets = p.suggestedPresetIds.join(' | ')
    return `<li><strong>${escapeHtml(p.displayName)}</strong> — <code>codeburn plan set --provider ${escapeHtml(p.provider)} ${escapeHtml(presets)}</code></li>`
  }).join('')
  return `<div class="no-plan-hint">
    <div class="nph-title">The dollar figures below are API-equivalent value, not your actual bill.</div>
    <p>If you're on a flat-rate subscription for any of the tools we detected, configure it once with <code>codeburn plan set</code> so the report can show real leverage instead of metered API rates:</p>
    <ul>${lines}</ul>
    <p style="margin-top:.5rem">For pay-as-you-go API users (no subscription), the figures below are accurate as-is.</p>
  </div>`
}

function spikeListItem(s: SpikeFinding): string {
  return `
    <li>
      <span class="badge ${s.severity}">${s.severity}</span>
      <span class="when">${escapeHtml(s.date)}</span>
      <span class="cost">${formatUSD(s.cost, true)}</span>
      <span class="dim">vs baseline ${formatUSD(s.baseline, true)} · z=${s.zScore.toFixed(1)}</span>
    </li>
  `
}

function spikeList(spikes: SpikeFinding[]): string {
  if (spikes.length === 0) return '<div class="empty">No anomalous days detected.</div>'
  const sorted = [...spikes].sort((a, b) => b.zScore - a.zScore).slice(0, 10)
  return `<ul class="spikes">${sorted.map(spikeListItem).join('')}</ul>`
}

function findingsRow(f: MenubarPayload['optimize']['topFindings'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(f.title)}</td>
      <td><span class="impact" style="color:${IMPACT_COLOR[f.impact]}">${f.impact}</span></td>
      <td class="num">${formatUSD(f.savingsUSD, true)}</td>
    </tr>`
}

function findingsList(findings: MenubarPayload['optimize']['topFindings']): string {
  if (findings.length === 0) return '<div class="empty">No optimizations identified — your spend looks efficient.</div>'
  return `<table><thead><tr><th>Finding</th><th>Impact</th><th class="num">Est. monthly savings</th></tr></thead><tbody>${findings.map(findingsRow).join('')}</tbody></table>`
}

function yieldPanel(y: YieldSummary): string {
  const pct = (n: number) => y.total.cost > 0 ? Math.round((n / y.total.cost) * 100) : 0
  return `<div class="yield-grid">
    <div class="yield-card good">
      <div class="yield-pct">${pct(y.productive.cost)}%</div>
      <div class="yield-label">Shipped to main</div>
      <div class="yield-detail">${formatUSD(y.productive.cost, true)} · ${y.productive.sessions} sessions</div>
    </div>
    <div class="yield-card warn">
      <div class="yield-pct">${pct(y.reverted.cost)}%</div>
      <div class="yield-label">Reverted</div>
      <div class="yield-detail">${formatUSD(y.reverted.cost, true)} · ${y.reverted.sessions} sessions</div>
    </div>
    <div class="yield-card bad">
      <div class="yield-pct">${pct(y.abandoned.cost)}%</div>
      <div class="yield-label">Abandoned</div>
      <div class="yield-detail">${formatUSD(y.abandoned.cost, true)} · ${y.abandoned.sessions} sessions</div>
    </div>
  </div>
  <div class="yield-bar"><div class="seg-good" style="flex:${y.productive.cost}"></div><div class="seg-warn" style="flex:${y.reverted.cost}"></div><div class="seg-bad" style="flex:${y.abandoned.cost}"></div></div>`
}

// ────────────────────────────────────────────────────────────────────────────
// CSS
// ────────────────────────────────────────────────────────────────────────────

const CSS = `
  :root {
    --bg: #fcfcfc; --panel: #fff; --ink: #1a1a1a; --dim: #666; --muted: #999;
    --border: #e4e4e4; --accent: #FF8C42; --teal: #5BF5E0; --green: #5BF5A0;
    --grid: #ececec;
    /* Empty heatmap cells inherit the grid colour by default and override only
       where contrast against the panel demands it (dark mode). One source of
       truth, no literal hex sprinkled through component CSS. */
    --cell-empty: var(--grid);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d0d0e; --panel: #16171a; --ink: #ececec; --dim: #aaa; --muted: #777;
            --border: #2a2b2f; --grid: #232427;
            /* Empty cell colour against the #16171a panel. At ~50% lightness
               the contrast against the panel is high enough that a 6px gap
               reads as a clear gutter without antialiasing fusing adjacent
               cells together. */
            --cell-empty: #5a5d65; }
  }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         max-width: 1100px; margin: 2rem auto; padding: 0 1.25rem;
         color: var(--ink); background: var(--bg); }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
  h1 { font-size: 1.7rem; margin: 0; letter-spacing: -0.01em; }
  .subtitle { color: var(--dim); font-size: .9rem; }
  .subtitle.scope { margin-top: .15rem; color: var(--accent); font-size: .82rem; }
  .subtitle.scope code { background: rgba(255,140,66,.12); border: 1px solid rgba(255,140,66,.3);
                          color: var(--accent); padding: 1px 6px; border-radius: 3px;
                          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; padding-bottom: .35rem;
       border-bottom: 1px solid var(--border); letter-spacing: .01em;
       display: flex; align-items: center; gap: .5rem; }
  h2 .count { color: var(--muted); font-weight: 400; font-size: .9rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
               gap: .65rem; margin: 1rem 0; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
          padding: .9rem 1rem; }
  .stat .v { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; }
  .stat .l { color: var(--dim); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; margin-top: .15rem; }
  .stat .delta { font-size: .8rem; color: var(--muted); margin-top: .1rem; }

  /* Plan/leverage banner — only shown when plan is configured */
  .plan-banner { background: linear-gradient(135deg, #5BF5A0 0%, #5BF5E0 100%);
                 color: #003a35; padding: 1rem 1.25rem; border-radius: 12px; margin: 1rem 0;
                 display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; align-items: center; }
  @media (max-width: 700px) { .plan-banner { grid-template-columns: 1fr; } }
  .plan-banner .pb-cell { display: flex; flex-direction: column; }
  .plan-banner .pb-l { font-size: .8rem; letter-spacing: .06em; text-transform: uppercase; opacity: .75; }
  .plan-banner .pb-v { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.01em; }
  .plan-banner .pb-d { font-size: .85rem; opacity: .75; margin-top: .15rem; }
  .plan-banner .arrow { color: #006650; opacity: .6; font-size: 1.2rem; text-align: center; }
  .plan-banner.under { background: linear-gradient(135deg, #FFD700 0%, #FF8C42 100%); color: #4a2c00; }
  .plan-banner.under .pb-l, .plan-banner.under .pb-d { opacity: .8; }
  .plan-banner.under .arrow { color: #6a3000; }
  .plan-banner .pb-auto { font-size: .7rem; opacity: .65; margin-top: .35rem; font-style: italic; }

  /* No-plan hint card — shown to users on subscription tools we couldn't auto-detect. */
  .no-plan-hint { background: rgba(255,140,66,.08); border: 1px solid rgba(255,140,66,.35);
                  border-left-width: 4px; border-radius: 8px; padding: .85rem 1rem; margin: 1rem 0; }
  .no-plan-hint .nph-title { font-weight: 600; color: var(--ink); margin-bottom: .25rem; }
  .no-plan-hint p { margin: 0; color: var(--dim); font-size: .9rem; line-height: 1.5; }
  .no-plan-hint code { background: var(--grid); padding: 1px 5px; border-radius: 3px; font-size: .82rem; }
  .no-plan-hint ul { margin: .5rem 0 0; padding-left: 1.25rem; color: var(--dim); font-size: .85rem; }
  .no-plan-hint li { margin: .15rem 0; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 800px) { .grid-2 { grid-template-columns: 1fr; } }
  .pie-row { display: grid; grid-template-columns: 220px 1fr; align-items: center; gap: 1rem; }
  @media (max-width: 600px) { .pie-row { grid-template-columns: 1fr; } }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.proj { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.pct { color: var(--dim); }
  .chart { width: 100%; height: 260px; display: block; }
  .chart .bar { transition: opacity .15s; }
  .chart .bar:hover { opacity: .8; }
  .chart .grid { stroke: var(--grid); stroke-width: 1; }
  .chart .axis { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .chart .weekend { fill: var(--grid); opacity: .3; }
  .chart-legend { display: flex; gap: 1rem; align-items: center; margin-top: .5rem;
                  color: var(--muted); font-size: .78rem; flex-wrap: wrap; }
  .cl-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px;
               vertical-align: middle; margin-right: .35rem; }
  .cl-bar { background: #5BF5E0; }
  .cl-spike { background: #C62828; }
  .cl-weekend { background: var(--grid); opacity: .6; }
  .donut { width: 220px; height: 220px; }
  .donut .donut-value { fill: var(--ink); font-size: 22px; font-weight: 600; }
  .donut .donut-label { fill: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .legend { list-style: none; padding: 0; margin: 0; }
  .legend li { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: center; gap: .5rem; padding: .15rem 0; font-size: .85rem; }
  .legend .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  /* minmax(0, 1fr) above + these three lines together prevent long model
     names (e.g. claude-haiku-4-5-20251001) from wrapping the legend row.
     The full name shows on hover via the title attribute. */
  .legend .lab { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .legend .val { font-variant-numeric: tabular-nums; color: var(--dim); white-space: nowrap; }
  .legend .val em { font-style: normal; color: var(--muted); margin-left: .5em; font-size: .85em; }
  /* The .more overflow line is plain text. Each regular legend row is its
     OWN grid container (the dot/label/value columns), so anonymous text in
     a row gets squeezed into the 14px first column and wraps character-by-
     character. Override display so the .more row flows as a normal block
     of text. */
  .legend .more { display: block; color: var(--muted); font-style: italic;
                  padding: .25rem 0 .15rem; font-size: .78rem; }
  .bars td { vertical-align: middle; }
  .bar-cell { width: 30%; min-width: 90px; }
  .bar-track { height: 8px; background: var(--grid); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #5BF5E0 0%, #FF8C42 100%); }
  .token-mix { display: flex; height: 32px; border-radius: 6px; overflow: hidden; margin: .5rem 0; border: 1px solid var(--border); }
  .seg { display: flex; align-items: center; justify-content: center; font-size: .75rem; color: #fff; font-weight: 600; }
  .seg-cache { background: #5BF5E0; color: #003a35; }
  .seg-fresh { background: #FF8C42; }
  .caption { color: var(--muted); font-size: .8rem; }
  .spikes { list-style: none; padding: 0; margin: 0; }
  .spikes li { display: grid; grid-template-columns: 70px 90px 90px 1fr; gap: .5rem; padding: .35rem 0; border-bottom: 1px solid var(--border); align-items: center; font-size: .9rem; }
  .badge { font-size: .7rem; text-transform: uppercase; padding: .15rem .4rem; border-radius: 3px; font-weight: 600; }
  .badge.mild { background: rgba(255,215,0,.15); color: #b8860b; }
  .badge.strong { background: rgba(245,124,0,.15); color: #f57c00; }
  .badge.extreme { background: rgba(198,40,40,.15); color: #c62828; }
  .when { font-variant-numeric: tabular-nums; }
  .cost { font-weight: 600; font-variant-numeric: tabular-nums; }
  .dim { color: var(--muted); }
  .impact { font-weight: 600; text-transform: capitalize; }
  .yield-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; }
  .yield-card { padding: 1rem; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); }
  .yield-card.good { border-left: 4px solid #5BF5A0; }
  .yield-card.warn { border-left: 4px solid #FFD700; }
  .yield-card.bad  { border-left: 4px solid #F55B5B; }
  .yield-pct { font-size: 1.6rem; font-weight: 600; letter-spacing: -0.01em; }
  .yield-label { color: var(--ink); font-weight: 500; }
  .yield-detail { color: var(--dim); font-size: .85rem; margin-top: .25rem; }
  .yield-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: .75rem 0 0; border: 1px solid var(--border); }
  .yield-bar .seg-good { background: #5BF5A0; }
  .yield-bar .seg-warn { background: #FFD700; }
  .yield-bar .seg-bad { background: #F55B5B; }
  .empty { color: var(--muted); font-style: italic; padding: 1rem; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .8rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; background: var(--grid); padding: 1px 4px; border-radius: 3px; }
  @media print {
    body { max-width: 100%; margin: 0; padding: 1rem; }
    .panel { break-inside: avoid; }
  }

  /* Calendar heatmap (Statuspage-style)
     Fixed cell size matches the Anthropic Claude Status page: small squares
     (~22px), tight gap (3px), 7-column grid. Months wrap horizontally and
     stack vertically only when the viewport gets too narrow. */
  .cal-row { display: flex; flex-wrap: wrap; gap: 2rem; row-gap: 1.5rem; }
  .cal-month { flex: 0 0 auto; }
  .cal-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: .55rem; gap: 1.25rem; }
  .cal-name { font-weight: 600; font-size: 1rem; }
  .cal-total { color: var(--dim); font-variant-numeric: tabular-nums; font-weight: 500; font-size: .85rem; text-align: right; }
  /* The grid is now a column of weekly flex rows rather than a CSS Grid.
     This rendering path is much harder to misinterpret — browsers can't
     collapse the gap between two flex items even when the items are empty
     <div> elements with the same background. */
  .cal-grid { display: flex; flex-direction: column; gap: 6px; }
  .cal-week { display: flex; gap: 6px; }
  /* Empty colour goes through a CSS variable so dark mode picks up the
     correct shade automatically. Cells with data override via inline style.
     The flex 0 0 22px declaration below is load-bearing: without it,
     default flex-shrink lets some cells shrink below their declared width
     when the row is laid out, producing visibly different sizes between
     empty and coloured cells. The triple-zero forces every cell to be
     exactly 22px wide regardless of flex container math. */
  .cell { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 3px;
          background: var(--cell-empty); box-sizing: border-box; }
  .cell.spike-mild   { box-shadow: inset 0 0 0 2px #FFD700; }
  .cell.spike-strong { box-shadow: inset 0 0 0 2px #F57C00; }
  .cell.spike-extreme { box-shadow: inset 0 0 0 2px #C62828; }
  .cal-truncated { color: var(--muted); font-size: .82rem; margin-top: 1rem;
                   padding: .5rem .75rem; border: 1px dashed var(--border); border-radius: 6px; }
  .cal-truncated code { background: var(--grid); padding: 1px 5px; border-radius: 3px; font-size: .82rem; }
  .cal-legend { display: flex; align-items: center; gap: 5px; margin-top: 1rem; flex-wrap: wrap; }
  .cal-legend .cell { flex: 0 0 12px; width: 12px; height: 12px; border-radius: 2px; }
  .cal-legend-label { color: var(--muted); font-size: .78rem; }
  .cal-legend-spacer { flex: 0 0 .75rem; }
`

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

/**
 * The auto-detected flag is exposed via the saved Plan, but not directly via
 * the menubar payload's ValuationBlock. Sniff it from the context's
 * payload.valuation (we don't get it for free — just default to false).
 * Caller can override by setting valuation.plan.autoDetected in the future.
 */
function autoDetectedFromContext(_ctx: ExportContext): boolean {
  // TODO: thread autoDetected through the menubar payload too. For now we
  // err on the side of not adding the "auto-detected" sub-line; explicit
  // user-set plans look identical, which is the correct fallback.
  return false
}

export function buildExportHtml(ctx: ExportContext): string {
  const { payload, projects, spikes, yieldSummary } = ctx
  const title = ctx.title ?? 'CodeBurn Report'
  const redacted = !!ctx.redactPaths
  const { current, optimize, history } = payload
  const generatedHuman = new Date(payload.generated).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  })

  // Activity legend (with palette)
  const activitiesColored = current.topActivities.map((a, i) => ({
    label: a.name, value: a.cost, color: PALETTE[i % PALETTE.length],
  }))
  const activityTotal = activitiesColored.reduce((s, a) => s + a.value, 0)

  // Models legend
  const modelsColored = current.topModels
    .filter(m => m.name !== '<synthetic>')
    .map((m, i) => ({ label: m.name, value: m.cost, color: PALETTE[i % PALETTE.length] }))
  const modelTotal = modelsColored.reduce((s, m) => s + m.value, 0)

  // Providers
  const providersColored = Object.entries(current.providers)
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost], i) => ({
      label: name.charAt(0).toUpperCase() + name.slice(1),
      value: cost,
      color: PALETTE[i % PALETTE.length],
    }))
  const providerTotal = providersColored.reduce((s, p) => s + p.value, 0)

  // Period totals for stat cards
  const totalTokens = current.inputTokens + current.outputTokens
  const avgCostPerSession = current.sessions > 0 ? current.cost / current.sessions : 0
  const avgCostPerCall = current.calls > 0 ? current.cost / current.calls : 0

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>

<header>
  <div>
    <h1>${escapeHtml(title)}</h1>
    <div class="subtitle">${escapeHtml(current.label)} · generated ${escapeHtml(generatedHuman)}${redacted ? ' · paths redacted' : ''}</div>
    ${ctx.scope && ctx.scope.kind !== 'all' && ctx.scope.label
        ? `<div class="subtitle scope">scoped to <code>${escapeHtml(ctx.scope.label)}</code> · pass --all-projects to see everything</div>`
        : ''}
  </div>
  <div class="subtitle">payload schema v${payload.schemaVersion}</div>
</header>

${payload.valuation ? planBanner(payload.valuation, autoDetectedFromContext(ctx)) : noPlanHint(ctx.presenceOnly ?? [])}

<section class="stat-grid">
  <div class="stat"><div class="v">${formatUSD(current.cost)}</div><div class="l">${payload.valuation ? 'API value' : 'API-equivalent spend'}</div><div class="delta">avg ${formatUSD(avgCostPerSession)}/session · ${formatUSD(avgCostPerCall, true)}/call</div></div>
  <div class="stat"><div class="v">${current.calls.toLocaleString()}</div><div class="l">API calls</div></div>
  <div class="stat"><div class="v">${current.sessions.toLocaleString()}</div><div class="l">Sessions</div></div>
  <div class="stat"><div class="v">${formatTokens(totalTokens)}</div><div class="l">Tokens (in+out)</div><div class="delta">${formatTokens(current.outputTokens)} out · ${formatTokens(current.inputTokens)} in</div></div>
  <div class="stat"><div class="v">${current.cacheHitPercent.toFixed(1)}%</div><div class="l">Cache hit rate</div></div>
  <div class="stat"><div class="v">${current.oneShotRate != null ? Math.round(current.oneShotRate * 100) + '%' : '—'}</div><div class="l">One-shot rate</div><div class="delta">edits that landed first try</div></div>
</section>

<h2>Spend calendar ${spikes.length > 0 ? `<span class="count">${spikes.length} anomal${spikes.length === 1 ? 'y' : 'ies'} flagged</span>` : ''}</h2>
<div class="panel">
  ${calendarHeatmap(history.daily, spikes)}
</div>

<h2>Daily timeline</h2>
<div class="panel">
  ${dailyTimeline(history.daily, spikes)}
</div>

${spikes.length > 0 ? `<h2>Cost spikes <span class="count">${spikes.length}</span></h2>
<div class="panel">${spikeList(spikes)}</div>
<p class="caption">EWMA baseline (half-life 7d) ± k·MAD. Hover bars in the timeline to see numbers; severity badges scale with z-score.</p>` : ''}

${yieldSummary ? `<h2>Productivity yield <span class="count">${yieldSummary.total.sessions} sessions</span></h2>
<div class="panel">${yieldPanel(yieldSummary)}</div>
<p class="caption">"Shipped" = at least one session commit landed on the main branch. "Reverted" = a later <code>git revert</code> targeted that commit. "Abandoned" = no commit within session window + 1h.</p>` : ''}

<h2>Where the spend went</h2>
<div class="grid-2">
  <div class="panel">
    <div class="pie-row">
      ${donut(activitiesColored, 'Activity', formatUSD(activityTotal))}
      <div>${legend(activitiesColored, activityTotal)}</div>
    </div>
  </div>
  <div class="panel">
    <div class="pie-row">
      ${donut(modelsColored, 'Model', formatUSD(modelTotal))}
      <div>${legend(modelsColored, modelTotal)}</div>
    </div>
  </div>
</div>

${providersColored.length > 1 ? `<h2>Providers <span class="count">${providersColored.length} active</span></h2>
<div class="panel"><div class="pie-row">${donut(providersColored, 'Provider', formatUSD(providerTotal))}<div>${legend(providersColored, providerTotal)}</div></div></div>` : ''}

<h2>Per-project breakdown <span class="count">${projects.length} project${projects.length === 1 ? '' : 's'}</span></h2>
<div class="panel">${projectBars(projects, current.cost, redacted)}</div>

<h2>Top sessions</h2>
<div class="panel">${topSessions(projects, redacted)}</div>

<h2>Cache efficiency</h2>
<div class="panel">${tokenMixBar(current)}</div>

${optimize.findingCount > 0 ? `<h2>Optimization findings <span class="count">${optimize.findingCount} · ${formatUSD(optimize.savingsUSD)} potential savings</span></h2>
<div class="panel">${findingsList(optimize.topFindings)}</div>` : ''}

<footer>
  Generated by codeburn · <code>npm install -g codeburn</code> · <code>codeburn export --format html</code><br/>
  Daily timeline EWMA window 14d, half-life 7d, k=3 MAD threshold. Yield categorisation reads <code>git log</code> in your project's repo with hardened invocation (no per-repo config exec).
</footer>

</body>
</html>`
}
