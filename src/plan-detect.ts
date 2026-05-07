/**
 * Plan auto-detection across the AI tools codeburn supports.
 *
 * The detection problem is provider-specific:
 *
 *   - Claude Code drops a credentials file at ~/.claude/.credentials.json
 *     with `subscriptionType` and `rateLimitTier` fields. We can map those
 *     directly to a Claude Pro / Max / Max5x plan with high confidence
 *     without making any network calls. This is the only provider where the
 *     plan tier is reliably present in a local file today.
 *
 *   - Codex / Cursor / Copilot / Kiro / Antigravity store local auth tokens
 *     but the plan tier requires an authenticated HTTP call to the vendor's
 *     /me endpoint. We refuse to do that automatically (offline-first
 *     design). Instead we report PRESENCE — "you use this tool" — and the
 *     CLI surfaces a hint card asking the user to run
 *     `codeburn plan set --provider <p> <plan-id>` once.
 *
 *   - BYOK tools (Goose, OpenCode, Roo Code, etc.) have no subscription
 *     by definition. Their API value IS the bill. We don't show a banner.
 *
 * Output is a single `DetectionResult` consumed by cli.ts and export-html.ts.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { Plan, PlanId, PlanProvider } from './config.js'
import { getPresetPlan, planDisplayName } from './plans.js'

const execFileAsync = promisify(execFile)

/** A plan we detected from local credentials. High confidence — values are real. */
export type DetectedPlan = {
  provider: PlanProvider
  plan: Plan
  source: 'claude-credentials-file' | 'claude-keychain-macos'
}

/** A provider we know the user has used (sessions on disk) but whose plan tier we cannot determine offline. */
export type ProviderPresence = {
  provider: string
  displayName: string
  /** Suggested preset id if the user runs `codeburn plan set` later. */
  suggestedPresetIds: PlanId[]
}

export type DetectionResult = {
  detected: DetectedPlan[]
  presenceOnly: ProviderPresence[]
}

// ────────────────────────────────────────────────────────────────────────────
// Claude (high-confidence — read tier from credentials file)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Claude Code's keychain writer line-wraps long values mid-token (newline +
 * leading spaces). The credentials file dumped from Keychain has the same
 * artifact. Strip those before parsing — same logic the menubar's
 * ClaudeCredentialStore.swift uses on Swift's side.
 */
function sanitizeClaudeBlob(raw: string): string {
  let s = raw.replace(/\r/g, '')
  s = s.replace(/\n[ \t]*/g, '')
  return s.trim()
}

type ClaudeCreds = {
  claudeAiOauth?: {
    subscriptionType?: string
    rateLimitTier?: string
  }
}

function claudeTierToPlanId(subscriptionType: string | undefined, rateLimitTier: string | undefined): PlanId | null {
  const sub = (subscriptionType ?? '').toLowerCase()
  const tier = (rateLimitTier ?? '').toLowerCase()

  // Max 20x: rateLimitTier looks like 'default_claude_max_20x'.
  if (sub === 'max' && /max[_-]?20x/.test(tier)) return 'claude-max'
  // Max 5x.
  if (sub === 'max' && /max[_-]?5x/.test(tier)) return 'claude-max-5x'
  // Max with no x suffix — default to 20x (the more common tier as of 2026).
  if (sub === 'max') return 'claude-max'
  if (sub === 'pro') return 'claude-pro'
  // Free, pay-as-you-go, or unknown: don't auto-set a plan.
  return null
}

export async function detectClaudePlan(): Promise<DetectedPlan | null> {
  // 1. File first (Linux/Windows always, macOS sometimes). Reading a file
  //    never prompts so this is the preferred path.
  const path = join(homedir(), '.claude', '.credentials.json')
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(sanitizeClaudeBlob(raw)) as ClaudeCreds
      const result = claudeDetectionFromCreds(parsed)
      if (result) return result
    } catch { /* fall through to keychain */ }
  }

  // 2. macOS Keychain fallback. Default-on: Claude Code itself prompts the
  //    user the first time it accesses this entry and the user already
  //    clicked "Always Allow", so codeburn querying the same entry usually
  //    succeeds silently. The first time codeburn runs after install, the
  //    user gets one Keychain dialog they can dismiss with "Always Allow"
  //    — same UX as the menubar.
  //
  //    Disabled when:
  //      - Not macOS (no /usr/bin/security)
  //      - Not a TTY (CI, scripts, --format json piped through cron)
  //        — the prompt is modal and would block forever
  //      - User opted out with CODEBURN_READ_KEYCHAIN=0
  if (platform() !== 'darwin') return null
  if (process.env.CODEBURN_READ_KEYCHAIN === '0') return null
  // We try the Keychain by default. The first time codeburn runs after
  // install, macOS shows a Keychain dialog; clicking "Always Allow" makes
  // every subsequent run silent. The dialog blocks until the user responds,
  // so we cap it with a timeout (in detectClaudePlanFromKeychain).
  //
  // For non-interactive contexts (CI, scripts piping --format json, the
  // menubar's spawn-the-CLI bridge), the spawn STDIN is detached from a TTY
  // and the Keychain dialog can't appear at all — `security` returns errSecAuth
  // failed and we fall through gracefully. Set CODEBURN_READ_KEYCHAIN=0 to
  // skip the attempt entirely (e.g. for cron / CI runs where the brief
  // delay matters).
  return detectClaudePlanFromKeychain()
}

async function detectClaudePlanFromKeychain(): Promise<DetectedPlan | null> {
  try {
    // `-w` writes only the password (the JSON blob) to stdout. We pipe through
    // the same sanitizer because Keychain dumps Claude's line-wrapped writes
    // verbatim.
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 5000, maxBuffer: 64 * 1024 },
    )
    const parsed = JSON.parse(sanitizeClaudeBlob(stdout)) as ClaudeCreds
    const r = claudeDetectionFromCreds(parsed)
    return r ? { ...r, source: 'claude-keychain-macos' } : null
  } catch {
    return null
  }
}

/** Exported for testability — accepts already-parsed credentials. */
export function claudeDetectionFromCreds(parsed: ClaudeCreds): DetectedPlan | null {
  const oauth = parsed?.claudeAiOauth ?? {}
  const planId = claudeTierToPlanId(oauth.subscriptionType, oauth.rateLimitTier)
  if (!planId) return null
  const preset = getPresetPlan(planId)
  if (!preset) return null
  const plan: Plan = { ...preset, setAt: new Date().toISOString(), autoDetected: true }
  return { provider: 'claude', plan, source: 'claude-credentials-file' }
}

// ────────────────────────────────────────────────────────────────────────────
// Presence detection (low-confidence — only signals "user uses this tool")
// ────────────────────────────────────────────────────────────────────────────

/**
 * For each subscription-tiered provider, suggest the most common plan id(s)
 * to set so the user gets a useful hint instead of a wall of options.
 *
 * Claude is included even though we have a high-confidence detector for it,
 * because that detector can fail on macOS when the user hasn't opted into
 * Keychain access — in that case a hint card pointing to
 * `codeburn plan set --provider claude …` is the next-best UX.
 */
const PRESENCE_SUGGESTIONS: Record<string, PlanId[]> = {
  claude:       ['claude-pro', 'claude-max', 'claude-max-5x'],
  codex:        ['codex-plus', 'codex-pro'],
  cursor:       ['cursor-pro', 'cursor-business'],
  'cursor-agent': ['cursor-pro', 'cursor-business'],
  copilot:      ['copilot-pro', 'copilot-business', 'copilot-enterprise'],
  kiro:         ['kiro-pro'],
  antigravity:  ['antigravity-pro'],
}

const PROVIDERS_WITH_NO_SUBSCRIPTION = new Set([
  'goose', 'opencode', 'roo-code', 'kilo-code', 'pi', 'omp',
  'droid', 'qwen', 'openclaw', 'gemini',
])

/**
 * Probe whether the user has any session data for a given provider. Uses
 * the existing `discoverSessions()` interface so detection is
 * implementation-agnostic — we don't need to know where each tool stores
 * its files.
 */
async function providerHasAnySessions(name: string): Promise<boolean> {
  try {
    const { getAllProviders } = await import('./providers/index.js')
    const all = await getAllProviders()
    const provider = all.find(p => p.name === name)
    if (!provider) return false
    const sources = await provider.discoverSessions()
    return sources.length > 0
  } catch {
    return false
  }
}

export async function detectPresenceOnly(
  alreadyConfiguredProviders: Set<string>,
): Promise<ProviderPresence[]> {
  const presence: ProviderPresence[] = []
  for (const [providerName, suggestedPresetIds] of Object.entries(PRESENCE_SUGGESTIONS)) {
    if (PROVIDERS_WITH_NO_SUBSCRIPTION.has(providerName)) continue
    if (alreadyConfiguredProviders.has(providerName)) continue
    if (!(await providerHasAnySessions(providerName))) continue
    presence.push({
      provider: providerName,
      displayName: providerDisplayName(providerName),
      suggestedPresetIds,
    })
  }
  return presence
}

function providerDisplayName(name: string): string {
  switch (name) {
    case 'claude':        return 'Claude Code'
    case 'codex':         return 'Codex (OpenAI)'
    case 'cursor':        return 'Cursor'
    case 'cursor-agent':  return 'Cursor Agent'
    case 'copilot':       return 'GitHub Copilot'
    case 'kiro':          return 'Kiro'
    case 'antigravity':   return 'Antigravity'
    default:              return name
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run every detector. Returns:
 *   - detected: high-confidence plans we can persist immediately
 *   - presenceOnly: providers we know the user uses but can't auto-tier
 *
 * `existingPlans` tells us which providers already have a plan configured
 * so we don't pester the user with hint cards for things they've set.
 */
export async function detectPlans(existingPlans: Record<string, Plan>): Promise<DetectionResult> {
  const detected: DetectedPlan[] = []
  const claude = await detectClaudePlan()
  if (claude) detected.push(claude)

  const configured = new Set<string>(Object.keys(existingPlans))
  for (const d of detected) configured.add(d.provider)

  const presenceOnly = await detectPresenceOnly(configured)
  return { detected, presenceOnly }
}

/** Render a one-line hint per presence-only provider. */
export function presenceHintLines(presence: ProviderPresence[]): string[] {
  return presence.map(p => {
    const presets = p.suggestedPresetIds.map(planDisplayName).join(' / ')
    return `${p.displayName}: codeburn plan set --provider ${p.provider} <${p.suggestedPresetIds.join('|')}>  (${presets})`
  })
}
