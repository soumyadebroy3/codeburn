import { describe, it, expect } from 'vitest'
import { detectSpikes, type DailyPoint } from '../src/anomaly.js'

function dayPoints(...costs: number[]): DailyPoint[] {
  return costs.map((c, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    cost: c,
  }))
}

describe('detectSpikes', () => {
  it('returns empty when input is shorter than window', () => {
    const series = dayPoints(1, 2, 3)
    expect(detectSpikes(series, { window: 14 })).toEqual([])
  })

  it('flags a clear 10x spike', () => {
    const series = dayPoints(...Array(14).fill(10), 100)
    const findings = detectSpikes(series, { window: 14, halfLife: 7, k: 3 })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity === 'strong' || findings[0].severity === 'extreme').toBe(true)
    expect(findings[0].cost).toBe(100)
  })

  it('does not flag steady spend even when costs are high', () => {
    const series = dayPoints(...Array(20).fill(50))
    expect(detectSpikes(series)).toEqual([])
  })

  it('does not flag an uptick within k MAD when baseline noise is realistic', () => {
    // Realistic daily noise (some days busy, some quiet). MAD captures that
    // the variance is wide enough that 35 isn't a meaningful outlier.
    const series = dayPoints(10, 25, 8, 30, 12, 22, 18, 9, 28, 11, 20, 14, 24, 16, 35)
    expect(detectSpikes(series, { window: 14, k: 3 })).toEqual([])
  })

  it('handles zero-baseline window without divide-by-zero', () => {
    const series = dayPoints(...Array(14).fill(0), 5)
    const findings = detectSpikes(series, { window: 14 })
    expect(findings).toHaveLength(1)
    expect(Number.isFinite(findings[0].zScore)).toBe(true)
  })

  it('escalates severity with z-score', () => {
    // Large-baseline window so MAD is non-trivial — the ratio of today's
    // spend to the baseline noise is what drives severity.
    const window = [50, 80, 60, 90, 70, 85, 55, 95, 65, 75, 88, 62, 72, 78]
    const mildSeries = dayPoints(...window, 200)
    const extremeSeries = dayPoints(...window, 5000)
    const mild = detectSpikes(mildSeries, { window: 14, k: 3 })
    const extreme = detectSpikes(extremeSeries, { window: 14, k: 3 })
    expect(mild.length).toBeGreaterThan(0)
    expect(extreme.length).toBeGreaterThan(0)
    // Higher cost should produce at-least-as-severe rating.
    const order = { mild: 0, strong: 1, extreme: 2 } as const
    expect(order[extreme[0].severity]).toBeGreaterThanOrEqual(order[mild[0].severity])
  })
})
