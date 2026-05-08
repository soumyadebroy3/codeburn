/**
 * Hardened git invocation primitives shared by every codeburn entry point
 * that shells out to `git` (yield.ts, cli.ts's repo-detect, future
 * additions). Centralising the logic stops the two places from drifting
 * when the threat model changes.
 *
 * The threats this module mitigates:
 *
 *   - **Per-repo config exec** (CVE-2022-24765 family). A malicious
 *     `.git/config` planted in any directory codeburn might invoke `git`
 *     against can set `core.fsmonitor` / `core.sshCommand` / `core.pager`
 *     to arbitrary commands that execute on the next git invocation. The
 *     `-c` overrides in `SAFE_GIT_ARGS` blank these out so a hostile
 *     config has no effect.
 *
 *   - **GIT_CONFIG_* env injection**. Inheriting the user's environment
 *     verbatim would carry `GIT_CONFIG_COUNT=…` style env-config hijacks
 *     from the parent shell. `safeGitEnv` strips every GIT_* variable and
 *     re-injects only the ones we explicitly want.
 *
 *   - **Path traversal via `cwd`**. `entry.cwd` from session JSONL is
 *     attacker-influenced. We refuse to invoke `git` with a `cwd` outside
 *     `$HOME` / `$TMPDIR` / the user-configured allow-list.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * Resolve `git` to an absolute path once at module-load time so the
 * `safeRunGit` spawn doesn't rely on PATH for command lookup. PATH
 * inheritance + relative-name resolution would let a hostile bin
 * directory ahead of /usr/bin shadow git. We try the standard install
 * locations first, then fall back to bare `git` (PATH lookup) so the
 * tool still works on a custom Linux that puts git somewhere unusual.
 */
function resolveGitBinary(): string {
  const candidates = [
    '/opt/homebrew/bin/git',  // macOS arm64 brew
    '/usr/local/bin/git',     // macOS x86_64 brew + many Linux installs
    '/usr/bin/git',           // OS-shipped git (Linux, macOS Xcode tools)
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'git'  // fall back to PATH lookup
}

const GIT_BIN = resolveGitBinary()

export const SAFE_GIT_ARGS: readonly string[] = [
  '-c', 'core.fsmonitor=',
  '-c', 'core.sshCommand=',
  '-c', 'core.pager=cat',
  '-c', 'protocol.version=2',
  '-c', 'safe.directory=*',
]

export function safeGitEnv(): NodeJS.ProcessEnv {
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

export function trustedRoots(): string[] {
  const roots: string[] = [resolve(homedir()), resolve(tmpdir())]
  const extra = process.env.CODEBURN_ALLOWED_PROJECT_ROOTS
  if (extra) {
    for (const r of extra.split(':')) {
      if (r) roots.push(resolve(r))
    }
  }
  return roots
}

// tmpdir() resolves to /tmp on Linux, /var/folders/... on macOS. We allow
// scratch directories CREATED inside it (test fixtures, codeburn-* mkdtemp
// dirs) but never /tmp itself — a hostile .git/config sitting at /tmp would
// otherwise execute under our hardened spawn. Strict-subpath only.
function isStrictTmpSubpath(resolved: string): boolean {
  const tmp = resolve(tmpdir())
  return resolved !== tmp && resolved.startsWith(tmp + sep)
}

export function isCwdAllowed(dir: string): boolean {
  let resolved: string
  try {
    resolved = resolve(dir)
  } catch {
    return false
  }
  if (isStrictTmpSubpath(resolved)) return true
  const home = resolve(homedir())
  if (resolved === home || resolved.startsWith(home + sep)) return true
  const extra = process.env.CODEBURN_ALLOWED_PROJECT_ROOTS
  if (extra) {
    for (const r of extra.split(':')) {
      if (!r) continue
      const rr = resolve(r)
      if (resolved === rr || resolved.startsWith(rr + sep)) return true
    }
  }
  return false
}

/**
 * Run `git <args>` from `cwd` with the hardened env / config overrides.
 * Returns trimmed stdout on success, or null when:
 *   - cwd is outside the trusted roots
 *   - git fails (non-zero exit, ENOENT, timeout)
 *   - git's stdout exceeds maxBuffer
 *
 * Callers must treat null as "no answer" rather than "git said nothing".
 */
export function safeRunGit(args: string[], cwd: string, timeoutMs: number = 10_000): string | null {
  if (!isCwdAllowed(cwd)) return null
  try {
    return execFileSync(GIT_BIN, [...SAFE_GIT_ARGS, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeGitEnv(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  } catch {
    return null
  }
}
