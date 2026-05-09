import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { clearPlan, readPlan, savePlan } from '../src/config.js'
import { getPresetPlan, isPlanId, isPlanProvider } from '../src/plans.js'

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
})
