import { describe, it, expect } from 'vitest'

import { buildExportHtml, type ExportContext } from '../../src/export-html.js'
import { buildMenubarPayload, type PeriodData, type ProviderCost } from '../../src/menubar-json.js'
import type { ProjectSummary } from '../../src/types.js'

// export-html.ts builds a self-contained HTML report from UNTRUSTED session
// data (project paths, model/provider names, session ids, category labels).
// Its only XSS defense is escapeHtml() applied at every interpolation site, so
// that discipline is security-load-bearing. These tests lock it in: a future
// dropped escapeHtml() call (or a weakened escapeHtml) must fail CI.

const XSS = '<script>alert(1)</script>'
const ATTR_XSS = '"><img src=x onerror=alert(2)>'

function makePayload(): ReturnType<typeof buildMenubarPayload> {
  const period: PeriodData = {
    label: 'Today',
    cost: 10,
    calls: 5,
    sessions: 1,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    categories: [{ name: `${XSS} coding`, cost: 5, turns: 3, editTurns: 3, oneShotTurns: 2 }],
    models: [{ name: XSS, cost: 7, calls: 3 }],
  }
  const providers: ProviderCost[] = [{ name: `${XSS}prov`, cost: 4 }]
  return buildMenubarPayload(period, providers, null)
}

function makeProject(): ProjectSummary {
  return {
    project: XSS,
    projectPath: `/Users/x/${ATTR_XSS}`,
    totalCostUSD: 10,
    totalApiCalls: 5,
    sessions: [{
      sessionId: `${XSS}session`,
      project: XSS,
      firstTimestamp: '2026-04-09T10:00:00Z',
      lastTimestamp: '2026-04-09T11:00:00Z',
      totalCostUSD: 10,
      totalInputTokens: 100,
      totalOutputTokens: 200,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: 5,
      turns: [],
      modelBreakdown: {},
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      categoryBreakdown: {} as never,
      skillBreakdown: {} as never,
    }],
  }
}

describe('buildExportHtml — XSS / HTML-injection defense', () => {
  it('escapes untrusted project paths, names, and titles when paths are shown', () => {
    const ctx: ExportContext = {
      payload: makePayload(),
      projects: [makeProject()],
      spikes: [],
      title: `${XSS} Report`,
      redactPaths: false,
    }
    const html = buildExportHtml(ctx)

    // The raw injected markup must never appear unescaped anywhere in the
    // output. (The inert text "onerror=alert(2)" can survive once its
    // surrounding <, >, and " are escaped — that IS the defense working — so
    // we assert on the dangerous raw tag/attribute-breakout forms instead.)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('"><img')

    // ...and the escaped form must be present, proving the untrusted strings
    // actually reached the output (not silently dropped) and went through
    // escapeHtml — so the assertions above are meaningful, not vacuous.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes the untrusted project name when paths are redacted', () => {
    const ctx: ExportContext = {
      payload: makePayload(),
      projects: [makeProject()],
      spikes: [],
      redactPaths: true,
    }
    const html = buildExportHtml(ctx)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
