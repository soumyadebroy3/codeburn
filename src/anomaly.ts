/**
 * EWMA-based cost-spike detection for `codeburn report`.
 *
 * For each day, compute a weighted moving baseline of the prior N days. If
 * today's cost exceeds `baseline + k * MAD` (median absolute deviation), flag
 * it. Robust against zero-spend days (weekends) and slow drift; reacts to
 * sudden spikes within 1-2 days.
 *
 * Pure function, no I/O. Hooked into the dashboard renderer and exposed via
 * `report --json` so external consumers (the menubar, CI dashboards) can
 * render their own annotations.
 */

export type DailyPoint = {
  date: string
  cost: number
}

export type SpikeFinding = {
  date: string
  cost: number
  baseline: number
  zScore: number
  ratio: number  // cost / baseline (capped at 100x for display)
  severity: 'mild' | 'strong' | 'extreme'
}

export type SpikeOptions = {
  /** Lookback window. 14 days gives stable weekday/weekend mix. */
  window: number
  /** EWMA half-life in days. Shorter = more reactive. */
  halfLife: number
  /** Threshold multiplier on MAD. 3 = ~99th percentile under Gaussian noise. */
  k: number
  /**
   * Absolute USD floor. Any day whose cost is below this value will never be
   * flagged as a spike, regardless of how anomalous it is in z-score terms.
   * Defaults to $5 — relative-only triggering produced absurd findings like
   * "$1 day after 14 quiet days = extreme spike".
   */
  minCost: number
}

const DEFAULTS: SpikeOptions = { window: 14, halfLife: 7, k: 3, minCost: 5 }

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mad(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = median(xs)
  const dev = xs.map(x => Math.abs(x - m))
  const rawMad = median(dev)
  // Flooring MAD to a near-zero constant (1e-9) used to produce absurd
  // z-scores for low-baseline windows: 14 quiet days followed by a $1
  // recovery would compute z ≈ 6.7e8 and flag the day as "extreme". Floor
  // instead to whichever is largest of the actual MAD, 10% of the data
  // median, or $0.01 — so a tiny absolute spike off a tiny baseline reads
  // as a tiny z-score, not an extreme one.
  const dataMedian = m
  const floor = Math.max(dataMedian * 0.1, 0.01)
  return Math.max(rawMad, floor)
}

function ewma(values: number[], halfLife: number): number {
  if (values.length === 0) return 0
  const decay = Math.pow(0.5, 1 / Math.max(halfLife, 1e-9))
  let weight = 0
  let acc = 0
  for (let i = values.length - 1; i >= 0; i--) {
    const w = Math.pow(decay, values.length - 1 - i)
    acc += values[i] * w
    weight += w
  }
  return weight > 0 ? acc / weight : 0
}

export function detectSpikes(
  series: DailyPoint[],
  options: Partial<SpikeOptions> = {},
): SpikeFinding[] {
  const opts = { ...DEFAULTS, ...options }
  const findings: SpikeFinding[] = []
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date))

  for (let i = opts.window; i < sorted.length; i++) {
    const window = sorted.slice(i - opts.window, i).map(p => p.cost)
    const baseline = ewma(window, opts.halfLife)
    const m = mad(window)
    const today = sorted[i]
    if (today.cost <= baseline) continue
    // Absolute-cost floor: a $1 day after a quiet stretch will mathematically
    // look like an "extreme" relative spike (infinite ratio off a $0
    // baseline) but is operationally meaningless. Skip below the floor.
    if (today.cost < opts.minCost) continue
    const zScore = (today.cost - baseline) / (m * 1.4826)  // MAD→σ conversion
    if (zScore < opts.k) continue
    const ratio = baseline > 0 ? Math.min(100, today.cost / baseline) : 100
    let severity: SpikeFinding['severity'] = 'mild'
    if (zScore >= opts.k * 2) severity = 'strong'
    if (zScore >= opts.k * 4) severity = 'extreme'
    findings.push({ date: today.date, cost: today.cost, baseline, zScore, ratio, severity })
  }

  return findings
}
