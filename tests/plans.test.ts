import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { clearPlan, readAllPlans, readPlan, savePlan } from '../src/config.js'
import { getPresetPlan, isPlanId, isPlanProvider } from '../src/plans.js'

async function withHomeRedirect<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
  const previous = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    HOMEPATH: process.env['HOMEPATH'],
    HOMEDRIVE: process.env['HOMEDRIVE'],
  }
  process.env['HOME'] = dir
  process.env['USERPROFILE'] = dir
  process.env['HOMEPATH'] = dir
  process.env['HOMEDRIVE'] = ''
  try {
    return await fn(dir)
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(dir, { recursive: true, force: true })
  }
}

describe('plan presets', () => {
  it('resolves builtin presets', () => {
    expect(getPresetPlan('claude-pro')).toMatchObject({ id: 'claude-pro', monthlyUsd: 20, provider: 'claude' })
    expect(getPresetPlan('claude-max')).toMatchObject({ id: 'claude-max', monthlyUsd: 200, provider: 'claude' })
    expect(getPresetPlan('cursor-pro')).toMatchObject({ id: 'cursor-pro', monthlyUsd: 20, provider: 'cursor' })
    expect(getPresetPlan('custom')).toBeNull()
  })

  it('validates ids and providers', () => {
    expect(isPlanId('claude-pro')).toBe(true)
    expect(isPlanId('none')).toBe(true)
    expect(isPlanId('bad-plan')).toBe(false)

    expect(isPlanProvider('all')).toBe(true)
    expect(isPlanProvider('claude')).toBe(true)
    expect(isPlanProvider('invalid')).toBe(false)
  })
})

describe('plan config persistence', () => {
  it('round-trips savePlan/readPlan and clearPlan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    // os.homedir() reads HOME on POSIX but USERPROFILE on Windows; HOMEPATH /
    // HOMEDRIVE are the lower-priority Windows fallbacks. Override the full
    // quartet so the test redirects writes to `dir` on every CI platform.
    // Without this, on Windows the test would dump config.json into the
    // runner's real home and the atomic-rename hit EPERM under antivirus.
    const previous = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      HOMEPATH: process.env['HOMEPATH'],
      HOMEDRIVE: process.env['HOMEDRIVE'],
    }
    process.env['HOME'] = dir
    process.env['USERPROFILE'] = dir
    process.env['HOMEPATH'] = dir
    process.env['HOMEDRIVE'] = ''

    try {
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
        setAt: '2026-04-17T12:00:00.000Z',
      })

      const plan = await readPlan()
      expect(plan).toMatchObject({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
      })

      await clearPlan()
      expect(await readPlan()).toBeUndefined()
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clearPlan(provider) drops only that provider and leaves others in place', async () => {
    await withHomeRedirect(async () => {
      await savePlan({ id: 'claude-max', monthlyUsd: 200, provider: 'claude', resetDay: 1, setAt: '2026-05-01T00:00:00.000Z' })
      await savePlan({ id: 'cursor-pro', monthlyUsd: 20, provider: 'cursor', resetDay: 15, setAt: '2026-05-10T00:00:00.000Z' })

      expect(await readAllPlans()).toMatchObject({ claude: { id: 'claude-max' }, cursor: { id: 'cursor-pro' } })

      await clearPlan('claude')
      const remaining = await readAllPlans()
      expect(remaining['claude']).toBeUndefined()
      expect(remaining['cursor']).toMatchObject({ id: 'cursor-pro' })
      // Legacy single-plan field should fall through to the remaining
      // newest provider so older readers still see something sensible.
      const legacy = await readPlan()
      expect(legacy?.provider).toBe('cursor')
    })
  })

  it('clearPlan() with no provider clears every plan (legacy + map)', async () => {
    await withHomeRedirect(async () => {
      await savePlan({ id: 'claude-max', monthlyUsd: 200, provider: 'claude', resetDay: 1, setAt: '2026-05-01T00:00:00.000Z' })
      await savePlan({ id: 'cursor-pro', monthlyUsd: 20, provider: 'cursor', resetDay: 15, setAt: '2026-05-10T00:00:00.000Z' })

      await clearPlan()
      expect(await readPlan()).toBeUndefined()
      expect(await readAllPlans()).toEqual({})
    })
  })
})
