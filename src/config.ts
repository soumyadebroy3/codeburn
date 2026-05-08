import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export type PlanId =
  | 'claude-pro' | 'claude-max' | 'claude-max-5x'
  | 'codex-plus' | 'codex-pro'
  | 'cursor-pro' | 'cursor-business'
  | 'copilot-pro' | 'copilot-business' | 'copilot-enterprise'
  | 'kiro-pro' | 'antigravity-pro'
  | 'custom' | 'none'
export type PlanProvider = 'claude' | 'codex' | 'cursor' | 'copilot' | 'kiro' | 'antigravity' | 'all'

export type Plan = {
  id: PlanId
  monthlyUsd: number
  provider: PlanProvider
  resetDay?: number
  setAt: string
}

/**
 * Network access policy. Honored by the CLI's update-check and any provider
 * that may otherwise make outbound calls.
 *   - 'off':     no outbound network at all
 *   - 'fx-only': only currency conversion fetches (api.frankfurter.app)
 *   - 'all':     update checks + FX + future telemetry (default)
 *
 * The macOS menubar reads this same config via CLICurrencyConfig and the
 * GNOME extension mirrors it through gschema's `network` key.
 */
export type NetworkPolicy = 'off' | 'fx-only' | 'all'

export type CodeburnConfig = {
  currency?: {
    code: string
    symbol?: string
  }
  /**
   * Legacy single-plan field, kept for backward compatibility with installs
   * that ran `codeburn plan set <id>` before multi-provider plans landed.
   * When `plans` is present, the legacy field is mirrored into `plans[claude]`
   * (or whichever provider it's tagged for) and ignored.
   */
  plan?: Plan
  /**
   * Per-provider plan map. A user with both a Claude Max and Cursor Pro
   * subscription has two entries here; aggregate leverage is sum-paid vs
   * sum-API-value across all entries.
   */
  plans?: Record<string, Plan>
  modelAliases?: Record<string, string>
  network?: NetworkPolicy
}

/**
 * Read the effective network policy. Defaults to 'all' for backward
 * compatibility. Set via `codeburn config set network=off` (future) or
 * by editing ~/.config/codeburn/config.json directly.
 */
export async function getNetworkPolicy(): Promise<NetworkPolicy> {
  const config = await readConfig()
  const v = config.network
  if (v === 'off' || v === 'fx-only' || v === 'all') return v
  return 'all'
}

function getConfigDir(): string {
  return join(homedir(), '.config', 'codeburn')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export async function readConfig(): Promise<CodeburnConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as CodeburnConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: CodeburnConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  const configPath = getConfigPath()
  // Randomize the temp path so two simultaneous saveConfig calls (from
  // overlapping menubar + CLI runs, for example) do not race on the same
  // staging file. The previous fixed `.tmp` suffix could leave one
  // process reading partial bytes the other was mid-writing.
  const tmpPath = `${configPath}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  await rename(tmpPath, configPath)
}

export async function readPlan(): Promise<Plan | undefined> {
  const config = await readConfig()
  return config.plan
}

/**
 * Returns every plan the user has configured, keyed by provider. Merges the
 * legacy single-plan field into the result so older installs keep working.
 */
export async function readAllPlans(): Promise<Record<string, Plan>> {
  const config = await readConfig()
  const merged: Record<string, Plan> = { ...(config.plans ?? {}) }
  if (config.plan && !merged[config.plan.provider]) {
    merged[config.plan.provider] = config.plan
  }
  return merged
}

export async function savePlan(plan: Plan): Promise<void> {
  const config = await readConfig()
  // Mirror to both legacy `plan` (last-set wins) and per-provider `plans`
  // map. New code should read `plans`; legacy code that still reads `plan`
  // continues to work.
  config.plan = plan
  config.plans = { ...(config.plans ?? {}), [plan.provider]: plan }
  await saveConfig(config)
}

export async function savePlans(plans: Record<string, Plan>): Promise<void> {
  const config = await readConfig()
  config.plans = plans
  // Refresh the legacy field to whichever plan was most recently saved so
  // older readers see a sane value.
  const newest = Object.values(plans).sort((a, b) => (b.setAt ?? '').localeCompare(a.setAt ?? ''))[0]
  if (newest) config.plan = newest
  else delete config.plan
  await saveConfig(config)
}

export async function clearPlan(): Promise<void> {
  const config = await readConfig()
  delete config.plan
  delete config.plans
  await saveConfig(config)
}


export function getConfigFilePath(): string {
  return getConfigPath()
}
