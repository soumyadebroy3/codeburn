import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getModelCosts, getShortModelName, calculateCost, loadPricing, setModelAliases } from '../src/models.js'

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => setModelAliases({}))

describe('getModelCosts', () => {
  it('does not match short canonical against longer pricing key', () => {
    const costs = getModelCosts('gpt-4')
    if (costs) {
      expect(costs.inputCostPerToken).not.toBe(2.5e-6)
    }
  })

  it('returns correct pricing for gpt-4o vs gpt-4o-mini', () => {
    const mini = getModelCosts('gpt-4o-mini')
    const full = getModelCosts('gpt-4o')
    expect(mini).not.toBeNull()
    expect(full).not.toBeNull()
    expect(mini!.inputCostPerToken).toBeLessThan(full!.inputCostPerToken)
  })

  it('returns fallback pricing for known Claude models', () => {
    const costs = getModelCosts('claude-opus-4-6-20260205')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(5e-6)
  })
})

describe('getShortModelName', () => {
  it('maps gpt-4o-mini correctly (not gpt-4o)', () => {
    expect(getShortModelName('gpt-4o-mini-2024-07-18')).toBe('GPT-4o Mini')
  })

  it('maps gpt-4o correctly', () => {
    expect(getShortModelName('gpt-4o-2024-08-06')).toBe('GPT-4o')
  })

  it('maps gpt-4.1-mini correctly (not gpt-4.1)', () => {
    expect(getShortModelName('gpt-4.1-mini-2025-04-14')).toBe('GPT-4.1 Mini')
  })

  it('maps gpt-5.4-mini correctly (not gpt-5.4)', () => {
    expect(getShortModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
  })

  it('maps claude-opus-4-6 with date suffix', () => {
    expect(getShortModelName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
  })

  it('maps claude-opus-4-8 to Opus 4.8 (not the bare Opus 4 prefix)', () => {
    expect(getShortModelName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(getShortModelName('claude-opus-4-8-20260601')).toBe('Opus 4.8')
  })
})

describe('builtin aliases - getModelCosts', () => {
  it('resolves anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-opus', () => {
    expect(getModelCosts('anthropic--claude-4.5-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.5-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('OMP opus resolves to same pricing as canonical claude-opus-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })

  it('OMP sonnet resolves to same pricing as canonical claude-sonnet-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('OMP haiku resolves to same pricing as canonical claude-haiku-4-5', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).toEqual(getModelCosts('claude-haiku-4-5'))
  })
})

describe('builtin aliases - getShortModelName', () => {
  it('anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })

  it('anthropic--claude-4.6-sonnet -> Sonnet 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-sonnet')).toBe('Sonnet 4.6')
  })

  it('anthropic--claude-4.5-opus -> Opus 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-opus')).toBe('Opus 4.5')
  })

  it('anthropic--claude-4.5-sonnet -> Sonnet 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-sonnet')).toBe('Sonnet 4.5')
  })

  it('anthropic--claude-4.5-haiku -> Haiku 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-haiku')).toBe('Haiku 4.5')
  })

  it('anthropic/anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic/anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })
})

describe('user aliases via setModelAliases', () => {
  it('user alias resolves for getModelCosts', () => {
    setModelAliases({ 'my-internal-model': 'claude-sonnet-4-6' })
    expect(getModelCosts('my-internal-model')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('user alias resolves for getShortModelName', () => {
    setModelAliases({ 'my-internal-model': 'claude-opus-4-6' })
    expect(getShortModelName('my-internal-model')).toBe('Opus 4.6')
  })

  it('user alias overrides builtin', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-sonnet-4-5'))
  })

  it('resetting aliases restores builtins', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    setModelAliases({})
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })
})

describe('calculateCost - OMP names produce non-zero cost', () => {
  it('calculates cost for anthropic--claude-4.6-opus', () => {
    expect(calculateCost('anthropic--claude-4.6-opus', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('calculates cost for anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(calculateCost('anthropic/anthropic--claude-4.6-sonnet', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })
})

describe('calculateCost - Claude cache write durations', () => {
  it('prices 1-hour cache writes at 1.6x the 5-minute cache write rate', () => {
    const fiveMinute = calculateCost('claude-opus-4-7', 0, 0, 1_000_000, 0, 0)
    const oneHour = calculateCost('claude-opus-4-7', 0, 0, 1_000_000, 0, 0, 'standard', 1_000_000)
    const mixed = calculateCost('claude-opus-4-7', 0, 0, 100_000, 0, 0, 'standard', 60_000)

    expect(fiveMinute).toBeCloseTo(6.25, 6)
    expect(oneHour).toBeCloseTo(10, 6)
    expect(mixed).toBeCloseTo(0.85, 6)
  })
})

describe('existing model names still resolve', () => {
  it('canonical claude-opus-4-6', () => {
    expect(getModelCosts('claude-opus-4-6')).not.toBeNull()
  })

  it('canonical claude-sonnet-4-5', () => {
    expect(getModelCosts('claude-sonnet-4-5')).not.toBeNull()
  })

  it('date-stamped claude-sonnet-4-20250514', () => {
    expect(getModelCosts('claude-sonnet-4-20250514')).not.toBeNull()
  })

  it('pinned claude-sonnet-4-6@20250929', () => {
    expect(getModelCosts('claude-sonnet-4-6@20250929')).not.toBeNull()
  })

  it('anthropic/-prefixed anthropic/claude-opus-4-6', () => {
    expect(getModelCosts('anthropic/claude-opus-4-6')).not.toBeNull()
  })
})

// Exercise the warn-helper code paths from PR #266: looksLikeLocalModel and
// shouldWarnAboutUnknownModel are private, but every shape we care about
// flows through calculateCost(<unknown-model>, …) on the no-pricing branch.
describe('unknown model warnings', () => {
  function capture(fn: () => void): string {
    const orig = process.stderr.write.bind(process.stderr)
    let buf = ''
    process.stderr.write = ((chunk: string | Uint8Array) => {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stderr.write
    try { fn() } finally { process.stderr.write = orig }
    return buf
  }

  it('synthetic model is silent', () => {
    const out = capture(() => calculateCost('<synthetic>', 1, 1, 0, 0, 0))
    expect(out).toBe('')
  })

  it('Ollama-style local model with colon tag is silent (looksLikeLocalModel)', () => {
    const out = capture(() => {
      calculateCost(`qwen3.6:35b-a3b-bf16-${Math.random()}`, 1, 1, 0, 0, 0)
    })
    expect(out).toBe('')
  })

  it('quantized fingerprint suffix is silent (looksLikeLocalModel)', () => {
    const out = capture(() => {
      calculateCost(`mystery-model-q4_K_M-${Math.random()}`, 1, 1, 0, 0, 0)
    })
    expect(out).toBe('')
  })

  it('plain unknown model is silent without CODEBURN_VERBOSE', () => {
    const prev = process.env['CODEBURN_VERBOSE']
    delete process.env['CODEBURN_VERBOSE']
    try {
      const out = capture(() => {
        calculateCost(`totally-unknown-${Math.random()}`, 1, 1, 0, 0, 0)
      })
      expect(out).toBe('')
    } finally {
      if (prev !== undefined) process.env['CODEBURN_VERBOSE'] = prev
    }
  })

  it('plain unknown model warns once when CODEBURN_VERBOSE=1', () => {
    process.env['CODEBURN_VERBOSE'] = '1'
    try {
      const name = `unknown-verbose-${Math.random()}`
      const out = capture(() => calculateCost(name, 1, 1, 0, 0, 0))
      expect(out).toContain('no pricing data for model')
      // Second call is silent — set deduplicates.
      const out2 = capture(() => calculateCost(name, 1, 1, 0, 0, 0))
      expect(out2).toBe('')
    } finally {
      delete process.env['CODEBURN_VERBOSE']
    }
  })

  it('returns 0 cost for unknown models regardless of warning behaviour', () => {
    const cost = calculateCost('definitely-not-a-real-model', 1000, 1000, 0, 0, 0)
    expect(cost).toBe(0)
  })
})

describe('Warp Claude variants resolve to pricing (upstream PR #378)', () => {
  const cases: Array<[string, string]> = [
    ['claude-4-6-sonnet-high', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-low', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-medium', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-high-fast', 'claude-sonnet-4-6'],
    ['claude-4-7-opus-xhigh', 'claude-opus-4-7'],
    ['claude-4-7-opus-xhigh-fast', 'claude-opus-4-7'],
  ]

  for (const [input, expectedAlias] of cases) {
    it(`${input} resolves to ${expectedAlias} pricing`, () => {
      const costs = getModelCosts(input)
      expect(costs).not.toBeNull()
      expect(costs!.inputCostPerToken).toBeGreaterThan(0)
      const expected = getModelCosts(expectedAlias)
      expect(expected).not.toBeNull()
      expect(costs!.inputCostPerToken).toBe(expected!.inputCostPerToken)
      expect(costs!.outputCostPerToken).toBe(expected!.outputCostPerToken)
    })

    it(`${input} calculates non-zero cost`, () => {
      expect(calculateCost(input, 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
    })
  }
})

describe('DeepSeek v4 models resolve to pricing (upstream PR #367)', () => {
  it('deepseek-v4-pro has current official discounted pricing', () => {
    const costs = getModelCosts('deepseek-v4-pro')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(4.35e-7)
    expect(costs!.outputCostPerToken).toBe(8.7e-7)
    expect(costs!.cacheReadCostPerToken).toBe(3.625e-9)
    expect(costs!.cacheWriteCostPerToken).toBe(0)
  })

  it('deepseek-v4-flash has current official pricing', () => {
    const costs = getModelCosts('deepseek-v4-flash')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(1.4e-7)
    expect(costs!.outputCostPerToken).toBe(2.8e-7)
    expect(costs!.cacheReadCostPerToken).toBe(2.8e-9)
    expect(costs!.cacheWriteCostPerToken).toBe(0)
  })

  it('provider-prefixed DeepSeek v4 names resolve to the same pricing', () => {
    expect(getModelCosts('deepseek/deepseek-v4-pro')).toEqual(getModelCosts('deepseek-v4-pro'))
    expect(getModelCosts('deepseek/deepseek-v4-flash')).toEqual(getModelCosts('deepseek-v4-flash'))
  })

  it('calculates non-zero costs for observed DeepSeek v4 Claude usage', () => {
    const pro = calculateCost('deepseek-v4-pro', 2_477_914, 762_994, 0, 258_556_928, 0)
    const flash = calculateCost('deepseek-v4-flash', 1_552_573, 353_914, 0, 48_388_608, 0)

    expect(pro).toBeCloseTo(2.68, 2)
    expect(flash).toBeCloseTo(0.45, 2)
  })

  it('uses DeepSeek v4 display names', () => {
    expect(getShortModelName('deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    expect(getShortModelName('deepseek-v4-flash')).toBe('DeepSeek v4 Flash')
  })

  it('keeps bundled DeepSeek v4 fallback entries when runtime pricing cache is stale', async () => {
    const previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    const cacheRoot = await mkdtemp(join(tmpdir(), 'codeburn-pricing-cache-'))

    try {
      process.env['CODEBURN_CACHE_DIR'] = cacheRoot
      await mkdir(cacheRoot, { recursive: true })
      await writeFile(join(cacheRoot, 'litellm-pricing.json'), JSON.stringify({
        timestamp: Date.now(),
        data: {
          'gpt-4o-mini': {
            inputCostPerToken: 9e-7,
            outputCostPerToken: 1.8e-6,
            cacheWriteCostPerToken: 0,
            cacheReadCostPerToken: 9e-8,
            webSearchCostPerRequest: 0.01,
            fastMultiplier: 1,
          },
        },
      }), 'utf-8')

      await loadPricing()

      expect(getModelCosts('gpt-4o-mini')!.inputCostPerToken).toBe(9e-7)
      expect(getModelCosts('deepseek-v4-pro')!.inputCostPerToken).toBe(4.35e-7)
      expect(getModelCosts('deepseek-v4-flash')!.inputCostPerToken).toBe(1.4e-7)
    } finally {
      if (previousCacheDir === undefined) {
        delete process.env['CODEBURN_CACHE_DIR']
      } else {
        process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
      }
      await rm(cacheRoot, { recursive: true, force: true })
      await loadPricing()
    }
  })
})

describe('Gemini 3.5 Flash variants resolve to canonical id + display (upstream PR #377)', () => {
  const variants = ['gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low', 'Gemini 3.5 Flash (High)']

  for (const variant of variants) {
    it(`${variant} aliases to gemini-3.5-flash`, () => {
      // Alias resolution is forward-compatible: pricing applies once LiteLLM
      // indexes gemini-3.5-flash (the bundled snapshot doesn't yet), but the
      // canonical resolution and display name are correct now.
      expect(getModelCosts(variant)).toEqual(getModelCosts('gemini-3.5-flash'))
      expect(getShortModelName(variant)).toBe('Gemini 3.5 Flash')
    })
  }
})
