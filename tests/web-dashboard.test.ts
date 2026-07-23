import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { request } from 'http'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runWebDashboard } from '../src/web-dashboard.js'

// This mirrors the upstream tests/web-dashboard.test.ts, adapted to the fork:
//
//  - The fork's `periodInfoFromQuery` (src/cli-date.ts) throws
//    `unknown period "<name>"` (lowercase), where upstream said
//    `Unknown period ...`; the 400-body assertions use a case-insensitive
//    match so both spellings pass.
//  - The fork gates the granular `history.timeline` behind `enrich:true` AND a
//    non-empty parse (src/usage-timeline.ts `buildTimeline` returns undefined
//    when there are zero assistant calls). These tests run against a fresh,
//    EMPTY temp HOME, so no sessions are parsed and `timeline` is absent. The
//    upstream assertion `timeline.bucketMinutes === 15` would fail on empty
//    data, so we assert the always-present `history.daily` array instead and
//    only validate the timeline shape when it happens to be present.
//  - Adds explicit coverage for the loopback Host/Origin security guards and
//    static serving, which the task calls out but the upstream test omitted.
//
// It exercises `runWebDashboard` over 127.0.0.1 with fetch, matching upstream.

// Low-level GET that connects to 127.0.0.1:<port> but sends verbatim headers
// (including a forged Host), which fetch/undici refuses to do — it forces Host
// to the connection authority. Needed to exercise the DNS-rebinding guard.
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('web dashboard server', () => {
  let server: Server
  let base: string
  let port: number
  let homeDir: string
  let cacheDir: string
  const prevHome = process.env['HOME']
  const prevCache = process.env['CODEBURN_CACHE_DIR']

  beforeAll(async () => {
    // Point HOME and the cache at throwaway dirs so the server parses no real
    // sessions and touches no real sharing state.
    homeDir = await mkdtemp(join(tmpdir(), 'codeburn-web-home-'))
    cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-web-cache-'))
    process.env['HOME'] = homeDir
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    server = await runWebDashboard({
      period: 'today', provider: 'all', project: [], exclude: [], port: 0, open: false,
    })
    port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevCache === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = prevCache
    await rm(homeDir, { recursive: true, force: true })
    await rm(cacheDir, { recursive: true, force: true })
  })

  // Regression guard for the original bug: a bad `period` query used to hit
  // process.exit(1) and kill the long-running dashboard server. The handlers
  // must now answer 400 and keep serving.
  it('answers 400 for an invalid /api/usage period and keeps serving', async () => {
    const bad = await fetch(`${base}/api/usage?period=garbage`)
    expect(bad.status).toBe(400)
    // Fork: `unknown period "garbage"`; upstream: `Unknown period ...`.
    expect((await bad.json() as { error: string }).error).toMatch(/unknown period "garbage"/i)

    // The bug was process.exit; if it regressed, this test process would die.
    // A successful follow-up request proves the server survived the bad one.
    const ok = await fetch(`${base}/api/usage?period=today`)
    expect(ok.status).toBe(200)
    const payload = await ok.json() as {
      schemaVersion: number
      current: { label: string }
      history: { daily: unknown[]; timeline?: { bucketMinutes: number; points: unknown[] } }
    }
    // Rich (enrich:true) local payload shape: a stable schema + label plus the
    // always-present daily history array.
    expect(typeof payload.schemaVersion).toBe('number')
    expect(typeof payload.current.label).toBe('string')
    expect(Array.isArray(payload.history.daily)).toBe(true)
    // The granular timeline is only present when there is data to bucket. On an
    // empty temp HOME it is omitted; when present it must be a valid series.
    if (payload.history.timeline) {
      expect(payload.history.timeline.bucketMinutes).toBeGreaterThan(0)
      expect(Array.isArray(payload.history.timeline.points)).toBe(true)
    }
  })

  it('answers 400 for an invalid /api/devices period', async () => {
    const bad = await fetch(`${base}/api/devices?period=garbage`)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toMatch(/unknown period "garbage"/i)
  })

  it('serves /api/devices with the local device on a valid period', async () => {
    const ok = await fetch(`${base}/api/devices?period=today`)
    expect(ok.status).toBe(200)
    const body = await ok.json() as { devices: Array<{ id: string; local?: boolean; payload?: unknown }> }
    expect(Array.isArray(body.devices)).toBe(true)
    // With no paired remotes, this machine is the only device and is flagged
    // local. (Remote pulls are best-effort and absent in a clean environment.)
    const local = body.devices.find((d) => d.id === 'local')
    expect(local).toBeTruthy()
    expect(local?.local).toBe(true)
    expect(local?.payload).toBeTruthy()
  })

  // Loopback-only guard: the local /api/usage payload is UNSANITIZED, so the
  // server must reject any request that is not addressed to localhost (defeats
  // DNS rebinding) and any cross-origin request (CSRF). A forged Host or a
  // non-loopback Origin must yield 403 before any handler runs.
  //
  // fetch()/undici pins the Host header to the connection authority, so a
  // forged Host can only be sent over a raw HTTP client. rawGet still connects
  // to 127.0.0.1 (a rebinding attacker's DNS resolves your machine) but lies in
  // the Host header — exactly the DNS-rebinding shape the guard defends against.
  it('rejects a non-loopback Host header with 403', async () => {
    const res = await rawGet(port, '/api/usage?period=today', { host: 'evil.example.com' })
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/forbidden/i)
  })

  it('rejects a cross-origin request with 403', async () => {
    const res = await fetch(`${base}/api/usage?period=today`, {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/forbidden/i)
  })

  it('allows a loopback Origin', async () => {
    const res = await fetch(`${base}/api/usage?period=today`, {
      headers: { origin: `http://localhost:${port}` },
    })
    expect(res.status).toBe(200)
  })

  // Static serving: the root path returns HTML — either the built SPA
  // (index.html, possibly with the bootstrap payload inlined) or the
  // "Dashboard not built yet" fallback the CLI serves when dist/dash is absent.
  // Either way it is a 200 text/html document, not a 404.
  it('serves an HTML document at the root path', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('<')
    expect(html.length).toBeGreaterThan(0)
  })
})
