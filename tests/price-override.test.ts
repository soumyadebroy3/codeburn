import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import {
  getModelCosts,
  calculateCost,
  loadPricing,
  setModelAliases,
  setPriceOverrides,
  getPriceOverridesConfigHash,
} from '../src/models.js'

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
})

describe('user price overrides', () => {
  it('prices a model missing from the pricing snapshot', () => {
    const model = 'zz-price-override-missing-model-390'
    expect(getModelCosts(model)).toBeNull()

    setPriceOverrides({
      [model]: { input: 1.25, output: 2.5 },
    })

    const costs = getModelCosts(model)
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(1.25e-6)
    expect(costs!.outputCostPerToken).toBe(2.5e-6)
    expect(calculateCost(model, 1_000_000, 1_000_000, 0, 0, 0)).toBe(3.75)
  })

  it('wins over snapshot pricing and configured aliases', () => {
    setModelAliases({
      'price-override-aliased-model': 'claude-opus-4-6',
      'price-override-canonical-source': 'price-override-canonical-target',
    })
    setPriceOverrides({
      'gpt-4o': { input: 7, output: 8 },
      'claude-opus-4-6': { input: 4, output: 5 },
      'price-override-aliased-model': { input: 2, output: 3 },
      'price-override-canonical-target': { input: 6, output: 7 },
    })

    expect(getModelCosts('gpt-4o')!.inputCostPerToken).toBe(7e-6)
    expect(getModelCosts('price-override-aliased-model')!.inputCostPerToken).toBe(2e-6)
    expect(getModelCosts('price-override-canonical-source')!.inputCostPerToken).toBe(6e-6)
  })

  it('converts USD per 1,000,000 tokens to per-token ModelCosts exactly', () => {
    const model = 'price-override-unit-conversion'
    setPriceOverrides({
      [model]: { input: 1, output: 0 },
    })

    expect(getModelCosts(model)!.inputCostPerToken).toBe(1e-6)
    expect(calculateCost(model, 1_000_000, 0, 0, 0, 0)).toBe(1)
  })

  it('defaults cache rates from input pricing when omitted', () => {
    const model = 'price-override-cache-defaults'
    setPriceOverrides({
      [model]: { input: 10, output: 20 },
    })

    const costs = getModelCosts(model)
    expect(costs).not.toBeNull()
    expect(costs!.cacheWriteCostPerToken).toBeCloseTo(12.5e-6, 12)
    expect(costs!.cacheReadCostPerToken).toBeCloseTo(1e-6, 12)
  })

  it('honors explicit cache-read and cache-creation overrides', () => {
    const model = 'price-override-explicit-cache'
    setPriceOverrides({
      [model]: { input: 10, output: 20, cacheRead: 3, cacheCreation: 30 },
    })

    const costs = getModelCosts(model)
    expect(costs).not.toBeNull()
    expect(costs!.cacheReadCostPerToken).toBeCloseTo(3e-6, 12)
    expect(costs!.cacheWriteCostPerToken).toBeCloseTo(30e-6, 12)
  })

  it('wins for case-insensitive and prefix matches without shadowing a more-specific exact snapshot entry', () => {
    const miniSnapshot = getModelCosts('gpt-5-mini')
    expect(miniSnapshot).not.toBeNull()

    setPriceOverrides({
      'gpt-5': { input: 91, output: 92 },
    })

    expect(getModelCosts('GPT-5')!.inputCostPerToken).toBe(91e-6)
    expect(getModelCosts('gpt-5-foo')!.inputCostPerToken).toBe(91e-6)

    const mini = getModelCosts('gpt-5-mini')
    expect(mini).not.toBeNull()
    expect(mini!.inputCostPerToken).toBe(miniSnapshot!.inputCostPerToken)
    expect(mini!.outputCostPerToken).toBe(miniSnapshot!.outputCostPerToken)
  })

  it('ignores invalid override entries but keeps valid ones', () => {
    setPriceOverrides({
      'price-override-bad-input': { input: -1, output: 2 },
      'price-override-good': { input: 5, output: 6 },
    })

    expect(getModelCosts('price-override-bad-input')).toBeNull()
    expect(getModelCosts('price-override-good')!.inputCostPerToken).toBe(5e-6)
  })
})

describe('getPriceOverridesConfigHash', () => {
  it('is the builtin baseline with no user overrides and changes when rates change', () => {
    // The builtin composer price overrides now participate in the hash so a
    // release that edits them invalidates cached daily costs. With no USER
    // overrides the hash is therefore a stable, non-empty builtin baseline
    // (not the empty string it used to be).
    setPriceOverrides({})
    const baseline = getPriceOverridesConfigHash()
    expect(baseline).not.toBe('')
    // Stable across repeated calls with no user overrides.
    setPriceOverrides({})
    expect(getPriceOverridesConfigHash()).toBe(baseline)

    setPriceOverrides({ 'price-hash-model': { input: 1, output: 2 } })
    const first = getPriceOverridesConfigHash()
    expect(first).not.toBe(baseline)

    setPriceOverrides({ 'price-hash-model': { input: 3, output: 2 } })
    const second = getPriceOverridesConfigHash()
    expect(second).not.toBe(baseline)
    expect(second).not.toBe(first)
  })

  it('is stable across insertion order (keys sorted)', () => {
    setPriceOverrides({
      'b-model': { input: 1, output: 2 },
      'a-model': { input: 3, output: 4 },
    })
    const hashA = getPriceOverridesConfigHash()

    setPriceOverrides({
      'a-model': { input: 3, output: 4 },
      'b-model': { input: 1, output: 2 },
    })
    const hashB = getPriceOverridesConfigHash()

    expect(hashA).toBe(hashB)
  })
})
