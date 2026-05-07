import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { tmpdir, homedir } from 'os'
import { join, sep } from 'path'

import { __test__ } from '../../src/yield.js'

const { isCwdAllowed, safeGitEnv, SAFE_GIT_ARGS } = __test__

describe('yield.ts cwd hardening', () => {
  it('isCwdAllowed permits homedir', () => {
    expect(isCwdAllowed(homedir())).toBe(true)
    expect(isCwdAllowed(join(homedir(), 'projects'))).toBe(true)
  })

  it('isCwdAllowed rejects /etc, /tmp, root', () => {
    expect(isCwdAllowed('/etc')).toBe(false)
    expect(isCwdAllowed('/etc/passwd')).toBe(false)
    expect(isCwdAllowed('/')).toBe(false)
    if (process.platform !== 'win32') {
      // /tmp is outside HOME on macOS/Linux
      expect(isCwdAllowed('/tmp')).toBe(false)
    }
  })

  it('isCwdAllowed rejects path-traversal lookalikes', () => {
    // A literal path that resolves outside HOME must be rejected even if it
    // contains the homedir as a substring.
    expect(isCwdAllowed(`${homedir()}-foo`)).toBe(false)
    expect(isCwdAllowed(join(homedir(), '..', '..', 'etc'))).toBe(false)
  })

  it('safeGitEnv strips GIT_* and clamps config sources', () => {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.sshCommand'
    process.env.GIT_CONFIG_VALUE_0 = 'touch /tmp/PWNED-env'
    try {
      const env = safeGitEnv()
      expect(env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    } finally {
      delete process.env.GIT_CONFIG_COUNT
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  it('SAFE_GIT_ARGS includes the lethal config keys', () => {
    const flat = SAFE_GIT_ARGS.join(' ')
    expect(flat).toContain('core.fsmonitor=')
    expect(flat).toContain('core.sshCommand=')
    expect(flat).toContain('core.pager=cat')
  })
})

describe('yield.ts: hostile .git/config does not RCE', () => {
  let dir: string
  let canary: string

  beforeAll(async () => {
    dir = await mkdtemp(join(homedir(), '.codeburn-yield-test-'))
    canary = join(dir, 'CANARY')
    await mkdir(join(dir, '.git'), { recursive: true })
    // The four classic vectors. Any of these would touch CANARY if git ran
    // them. The SAFE_GIT_ARGS prefix neutralizes them.
    await writeFile(
      join(dir, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = touch ${JSON.stringify(canary + '.fsmonitor')}`,
        `\tsshCommand = touch ${JSON.stringify(canary + '.ssh')}`,
        `\tpager = touch ${JSON.stringify(canary + '.pager')}`,
        '[safe]',
        '\tdirectory = *',
      ].join('\n'),
    )
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(join(dir, '.git', 'objects'), { recursive: true })
    await mkdir(join(dir, '.git', 'refs', 'heads'), { recursive: true })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('runGit with SAFE_GIT_ARGS does not touch the canary file', async () => {
    // Drive runGit indirectly by importing it via __test__? It is not exported.
    // Instead: replicate the exact spawn that yield.ts does, asserting the
    // hardened invocation does not honour the malicious config.
    try {
      execFileSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeGitEnv(),
        timeout: 5_000,
      })
    } catch {
      // Failure is fine — we only care that the canaries did not get created.
    }

    for (const suffix of ['.fsmonitor', '.ssh', '.pager']) {
      const exists = await stat(canary + suffix).then(() => true, () => false)
      expect(exists, `canary ${suffix} must not exist`).toBe(false)
    }
  })
})
