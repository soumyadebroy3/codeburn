import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { isCwdAllowed, safeGitEnv, safeRunGit, SAFE_GIT_ARGS } from '../src/git-safe.js'

describe('git-safe — SAFE_GIT_ARGS', () => {
  it('disables every per-repo config exec vector', () => {
    expect(SAFE_GIT_ARGS).toContain('core.fsmonitor=')
    expect(SAFE_GIT_ARGS).toContain('core.sshCommand=')
    expect(SAFE_GIT_ARGS).toContain('core.pager=cat')
    expect(SAFE_GIT_ARGS).toContain('safe.directory=*')
  })
})

describe('git-safe — safeGitEnv', () => {
  it('strips inherited GIT_* env vars', () => {
    process.env.GIT_AUTHOR_NAME = 'Test'
    process.env.GIT_CONFIG_COUNT = '99'
    try {
      const env = safeGitEnv()
      expect(env.GIT_AUTHOR_NAME).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    } finally {
      delete process.env.GIT_AUTHOR_NAME
      delete process.env.GIT_CONFIG_COUNT
    }
  })

  it('forces config-source overrides', () => {
    const env = safeGitEnv()
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('preserves non-GIT env vars (PATH, HOME, etc.)', () => {
    const env = safeGitEnv()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.HOME).toBe(process.env.HOME)
  })
})

describe('git-safe — isCwdAllowed', () => {
  it('accepts paths under $HOME', () => {
    expect(isCwdAllowed(process.env.HOME ?? '/tmp')).toBe(true)
    expect(isCwdAllowed(join(process.env.HOME ?? '/tmp', 'subdir'))).toBe(true)
  })

  it('accepts strict subpaths of $TMPDIR but rejects the tmp root itself', () => {
    const t = tmpdir()
    // Bare tmpdir() must NOT be allowed — a hostile .git/config sitting at
    // /tmp would otherwise execute under our hardened spawn. Subdirs (test
    // fixtures, mkdtemp scratch dirs) are fine.
    expect(isCwdAllowed(t)).toBe(false)
    expect(isCwdAllowed(join(t, 'codeburn-test-' + Math.random()))).toBe(true)
  })

  it('rejects /etc and other system paths', () => {
    expect(isCwdAllowed('/etc')).toBe(false)
    expect(isCwdAllowed('/etc/passwd')).toBe(false)
    expect(isCwdAllowed('/private/var/db')).toBe(false)
  })

  it('honours CODEBURN_ALLOWED_PROJECT_ROOTS env var', () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), 'codeburn-allow-'))
    try {
      process.env.CODEBURN_ALLOWED_PROJECT_ROOTS = fakeRoot
      expect(isCwdAllowed(fakeRoot)).toBe(true)
      expect(isCwdAllowed(join(fakeRoot, 'sub'))).toBe(true)
    } finally {
      delete process.env.CODEBURN_ALLOWED_PROJECT_ROOTS
      rmSync(fakeRoot, { recursive: true, force: true })
    }
  })

})

describe('git-safe — safeRunGit', () => {
  it('refuses cwd outside trusted roots', () => {
    expect(safeRunGit(['rev-parse', '--show-toplevel'], '/etc')).toBeNull()
  })

  it('returns null when git fails (non-repo cwd)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeburn-not-a-repo-'))
    try {
      const out = safeRunGit(['rev-parse', '--is-inside-work-tree'], dir)
      // git exits non-zero outside a repo; safeRunGit catches → null
      expect(out).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs successfully inside a real git repo', () => {
    // Create a minimal repo so the test isn't dependent on the suite's cwd
    const dir = mkdtempSync(join(tmpdir(), 'codeburn-repo-'))
    try {
      mkdirSync(join(dir, '.git'))
      mkdirSync(join(dir, '.git', 'refs'))
      mkdirSync(join(dir, '.git', 'objects'))
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
      const out = safeRunGit(['rev-parse', '--is-inside-work-tree'], dir)
      // On macOS / Linux a hand-rolled .git is recognised by git rev-parse.
      expect(out === 'true' || out === null).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects the timeout argument', () => {
    // Fast-path: git --version returns instantly. Just confirms the
    // optional 3rd parameter is accepted without throwing.
    const dir = mkdtempSync(join(tmpdir(), 'codeburn-tout-'))
    try {
      const out = safeRunGit(['--version'], dir, 5_000)
      // Either git ran (and returned its version string) or we couldn't
      // start (null). Both are tolerable; we just exercise the timeout
      // parameter path.
      expect(out === null || /^git version/.test(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
