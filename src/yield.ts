import { execFileSync } from 'child_process'
import { resolve, sep } from 'path'
import { homedir, tmpdir } from 'os'
import { parseAllSessions } from './parser.js'
import type { DateRange, SessionSummary } from './types.js'

export type YieldCategory = 'productive' | 'reverted' | 'abandoned'

export type SessionYield = {
  sessionId: string
  project: string
  cost: number
  category: YieldCategory
  commitCount: number
}

export type YieldSummary = {
  productive: { cost: number; sessions: number }
  reverted: { cost: number; sessions: number }
  abandoned: { cost: number; sessions: number }
  total: { cost: number; sessions: number }
  details: SessionYield[]
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/\-]+$/

// Neutralize per-repo config keys that git happily executes as commands when
// it discovers them in a `.git/config`. A malicious session JSONL can drop
// `entry.cwd` pointing at a directory whose `.git/config` sets these keys —
// without these `-c` overrides, `git` invocations below run attacker code.
// (CVE-2022-24765 / CVE-2024-32002 family.)
const SAFE_GIT_ARGS: readonly string[] = [
  '-c', 'core.fsmonitor=',
  '-c', 'core.sshCommand=',
  '-c', 'core.pager=cat',
  '-c', 'protocol.version=2',
  '-c', 'safe.directory=*',
]

function safeGitEnv(): NodeJS.ProcessEnv {
  // Strip every GIT_* variable from the inherited env, then add only the ones
  // we want git to see. This defeats `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`
  // injection from the parent shell.
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_')) continue
    env[k] = v
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_PAGER = 'cat'
  return env
}

// Confine git invocations to user-writable roots ($HOME, $TMPDIR, plus any
// CODEBURN_ALLOWED_PROJECT_ROOTS). `entry.cwd` from session JSONL is
// otherwise an arbitrary-path primitive.
function trustedRoots(): string[] {
  const roots: string[] = [resolve(homedir()), resolve(tmpdir())]
  const extra = process.env.CODEBURN_ALLOWED_PROJECT_ROOTS
  if (extra) {
    for (const r of extra.split(':')) {
      if (r) roots.push(resolve(r))
    }
  }
  return roots
}

function isCwdAllowed(dir: string): boolean {
  let resolved: string
  try {
    resolved = resolve(dir)
  } catch {
    return false
  }
  for (const root of trustedRoots()) {
    if (resolved === root || resolved.startsWith(root + sep)) return true
  }
  return false
}

function runGit(args: string[], cwd: string): string | null {
  if (!isCwdAllowed(cwd)) return null
  try {
    return execFileSync('git', [...SAFE_GIT_ARGS, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeGitEnv(),
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch {
    return null
  }
}

function isGitRepo(dir: string): boolean {
  if (!isCwdAllowed(dir)) return false
  return runGit(['rev-parse', '--is-inside-work-tree'], dir) === 'true'
}

function getMainBranch(cwd: string): string {
  const result = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (result) {
    const branch = result.replace('refs/remotes/origin/', '')
    if (SAFE_REF_PATTERN.test(branch)) return branch
  }

  const branches = runGit(['branch', '-a'], cwd) ?? ''
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return 'main'
}

type CommitInfo = {
  sha: string
  timestamp: Date
  inMain: boolean
  /** Set when a LATER commit's body says "This reverts commit <sha>" — i.e. the work in this commit was reverted out of main. */
  wasReverted: boolean
}

/**
 * Find SHAs that were the target of a `git revert` ANYWHERE in the repo's
 * history (not just the time window). The standard `git revert` body
 * format is "This reverts commit <SHA>." which we grep out.
 *
 * The previous implementation flagged a commit as `isRevert` based on the
 * substring "revert" appearing in its OWN subject. Two bugs there:
 * 1. Subjects like "Add revert button" matched.
 * 2. The session that PERFORMED the revert was tagged "reverted", not the
 *    session whose work was being reverted — so the original session always
 *    looked productive even after its work was thrown away.
 */
function getRevertedShas(cwd: string): Set<string> {
  const bodies = runGit(
    ['log', '--all', '--grep=^This reverts commit', '--format=%B%x1e'],
    cwd,
  ) ?? ''
  const set = new Set<string>()
  const re = /This reverts commit ([0-9a-f]{7,40})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bodies)) !== null) {
    set.add(m[1].toLowerCase())
  }
  return set
}

function getCommitsInRange(cwd: string, since: Date, until: Date, mainBranch: string): CommitInfo[] {
  const sinceStr = since.toISOString()
  const untilStr = until.toISOString()

  const log = runGit(
    ['log', '--all', `--since=${sinceStr}`, `--until=${untilStr}`, '--format=%H|%aI|%s'],
    cwd
  )

  if (!log) return []

  const mainCommits = new Set(
    (runGit(['log', mainBranch, '--format=%H'], cwd) ?? '').split('\n').filter(Boolean)
  )
  const revertedShas = getRevertedShas(cwd)

  return log.split('\n').filter(Boolean).map(line => {
    const [sha] = line.split('|')
    const timestamp = line.split('|')[1] ?? ''
    return {
      sha,
      timestamp: new Date(timestamp),
      inMain: mainCommits.has(sha),
      wasReverted: revertedShas.has(sha.toLowerCase()) ||
                   revertedShas.has(sha.toLowerCase().slice(0, 7)),
    }
  })
}

function categorizeSession(
  session: SessionSummary,
  commits: CommitInfo[]
): { category: YieldCategory; commitCount: number } {
  if (!session.firstTimestamp) {
    return { category: 'abandoned', commitCount: 0 }
  }

  const sessionStart = new Date(session.firstTimestamp)
  const lastTs = session.lastTimestamp ?? session.firstTimestamp
  const sessionEnd = new Date(new Date(lastTs).getTime() + 60 * 60 * 1000)

  const relevantCommits = commits.filter(c =>
    c.timestamp >= sessionStart && c.timestamp <= sessionEnd
  )

  if (relevantCommits.length === 0) {
    return { category: 'abandoned', commitCount: 0 }
  }

  const inMainCount = relevantCommits.filter(c => c.inMain).length
  const revertedCount = relevantCommits.filter(c => c.inMain && c.wasReverted).length

  if (revertedCount > 0 && revertedCount >= inMainCount / 2) {
    return { category: 'reverted', commitCount: relevantCommits.length }
  }

  if (inMainCount > 0) {
    return { category: 'productive', commitCount: inMainCount }
  }

  return { category: 'abandoned', commitCount: relevantCommits.length }
}

export async function computeYield(range: DateRange, cwd: string): Promise<YieldSummary> {
  const projects = await parseAllSessions(range, 'all')

  const summary: YieldSummary = {
    productive: { cost: 0, sessions: 0 },
    reverted: { cost: 0, sessions: 0 },
    abandoned: { cost: 0, sessions: 0 },
    total: { cost: 0, sessions: 0 },
    details: [],
  }

  const commits = isGitRepo(cwd)
    ? getCommitsInRange(cwd, range.start, range.end, getMainBranch(cwd))
    : []

  for (const project of projects) {
    const projectCwd = project.projectPath && isGitRepo(project.projectPath)
      ? project.projectPath
      : cwd

    const projectCommits = projectCwd !== cwd && isGitRepo(projectCwd)
      ? getCommitsInRange(projectCwd, range.start, range.end, getMainBranch(projectCwd))
      : commits

    for (const session of project.sessions) {
      const { category, commitCount } = categorizeSession(session, projectCommits)

      summary[category].cost += session.totalCostUSD
      summary[category].sessions += 1
      summary.total.cost += session.totalCostUSD
      summary.total.sessions += 1

      summary.details.push({
        sessionId: session.sessionId,
        project: project.project,
        cost: session.totalCostUSD,
        category,
        commitCount,
      })
    }
  }

  return summary
}

export function formatYieldSummary(summary: YieldSummary): string {
  const { productive, reverted, abandoned, total } = summary

  const pct = (n: number) => total.cost > 0 ? Math.round((n / total.cost) * 100) : 0
  const fmt = (n: number) => `$${n.toFixed(2)}`

  const lines = [
    '',
    `Productive:  ${fmt(productive.cost).padStart(8)} (${pct(productive.cost)}%) - ${productive.sessions} sessions shipped to main`,
    `Reverted:    ${fmt(reverted.cost).padStart(8)} (${pct(reverted.cost)}%) - ${reverted.sessions} sessions were reverted`,
    `Abandoned:   ${fmt(abandoned.cost).padStart(8)} (${pct(abandoned.cost)}%) - ${abandoned.sessions} sessions never committed`,
    '',
    `Total:       ${fmt(total.cost).padStart(8)}     - ${total.sessions} sessions`,
    '',
  ]

  return lines.join('\n')
}

// Exported for tests only. Not part of the public API.
export const __test__ = {
  isCwdAllowed,
  safeGitEnv,
  SAFE_GIT_ARGS,
}
