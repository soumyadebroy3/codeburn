import { describe, it, expect } from 'vitest'
import { claudeDetectionFromCreds } from '../src/plan-detect.js'

describe('claudeDetectionFromCreds — rateLimitTier mapping', () => {
  it('detects Claude Max 20x', () => {
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    })
    expect(r).not.toBeNull()
    expect(r!.plan.id).toBe('claude-max')
    expect(r!.plan.monthlyUsd).toBe(200)
    expect(r!.plan.autoDetected).toBe(true)
    expect(r!.source).toBe('claude-credentials-file')
  })

  it('detects Claude Max 5x', () => {
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
    })
    expect(r!.plan.id).toBe('claude-max-5x')
    expect(r!.plan.monthlyUsd).toBe(100)
  })

  it('detects Claude Pro', () => {
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'pro', rateLimitTier: 'default_pro' },
    })
    expect(r!.plan.id).toBe('claude-pro')
    expect(r!.plan.monthlyUsd).toBe(20)
  })

  it('falls through Max → Max20x when tier is ambiguous', () => {
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'unrecognized_tier' },
    })
    expect(r!.plan.id).toBe('claude-max')
  })

  it('returns null for free / pay-as-you-go / unknown', () => {
    expect(claudeDetectionFromCreds({ claudeAiOauth: { subscriptionType: 'free' } })).toBeNull()
    expect(claudeDetectionFromCreds({ claudeAiOauth: {} })).toBeNull()
    expect(claudeDetectionFromCreds({})).toBeNull()
  })

  it('handles uppercase / mixed-case input', () => {
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'MAX', rateLimitTier: 'DEFAULT_CLAUDE_MAX_20X' },
    })
    expect(r!.plan.id).toBe('claude-max')
  })

  it('returns autoDetected: true and a fresh ISO setAt timestamp', () => {
    const before = Date.now()
    const r = claudeDetectionFromCreds({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    })
    const after = Date.now()
    expect(r!.plan.autoDetected).toBe(true)
    expect(r!.plan.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const setAtMs = new Date(r!.plan.setAt).getTime()
    expect(setAtMs).toBeGreaterThanOrEqual(before)
    expect(setAtMs).toBeLessThanOrEqual(after)
  })
})
