import { describe, it, expect } from 'vitest'
import { buildMenubarPayload, MENUBAR_SCHEMA_VERSION, type MenubarPayload, type PeriodData } from '../src/menubar-json.js'

const period: PeriodData = {
  label: 'Today',
  cost: 1.23,
  calls: 4,
  sessions: 2,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 800,
  cacheWriteTokens: 200,
  categories: [
    { name: 'edit', cost: 0.5, turns: 3, editTurns: 3, oneShotTurns: 1 },
  ],
  models: [
    { name: 'opus-4.7', cost: 1.0, calls: 3 },
  ],
}

// The Swift menubar (mac/Sources/CodeBurnMenubar/Data/MenubarPayload.swift)
// and the GNOME extension (gnome/indicator.js) decode this exact shape. Any
// change here that removes or renames a field is a breaking ABI change for
// both consumers. Bump MENUBAR_SCHEMA_VERSION when that happens.
describe('Menubar snapshot contract (v1)', () => {
  it('schemaVersion is exposed at the top level', () => {
    const payload = buildMenubarPayload(period, [], null)
    expect(payload.schemaVersion).toBe(MENUBAR_SCHEMA_VERSION)
    expect(payload.schemaVersion).toBe(1)
  })

  it('top-level keys are stable', () => {
    const payload = buildMenubarPayload(period, [], null)
    expect(Object.keys(payload).sort()).toEqual(
      ['current', 'generated', 'history', 'optimize', 'schemaVersion'].sort(),
    )
  })

  it('current.* keys are stable', () => {
    const payload = buildMenubarPayload(period, [], null)
    expect(Object.keys(payload.current).sort()).toEqual([
      'cacheHitPercent',
      'calls',
      'cost',
      'inputTokens',
      'label',
      'oneShotRate',
      'outputTokens',
      'providers',
      'sessions',
      'topActivities',
      'topModels',
    ].sort())
  })

  it('optimize.* keys are stable', () => {
    const payload = buildMenubarPayload(period, [], null)
    expect(Object.keys(payload.optimize).sort()).toEqual(
      ['findingCount', 'savingsUSD', 'topFindings'].sort(),
    )
  })

  it('payload survives JSON round-trip without loss', () => {
    const payload = buildMenubarPayload(period, [{ name: 'Claude', cost: 0.5 }], null)
    const round: MenubarPayload = JSON.parse(JSON.stringify(payload))
    expect(round.schemaVersion).toBe(payload.schemaVersion)
    expect(round.current.cost).toBe(payload.current.cost)
    expect(round.current.providers).toEqual(payload.current.providers)
  })

  it('providers map normalizes names to lowercase', () => {
    const payload = buildMenubarPayload(period, [
      { name: 'Claude', cost: 1 },
      { name: 'CODEX', cost: 2 },
    ], null)
    expect(payload.current.providers).toEqual({ claude: 1, codex: 2 })
  })
})
