#!/usr/bin/env node
/**
 * @codeburn/mcp-sonar — MCP server that wraps a SonarQube instance.
 *
 * Tools exposed (stdio JSON-RPC, MCP protocol 2024-11-05):
 *
 *   sonar_scan          — run sonar-scanner against a working tree, push to
 *                          SONAR_HOST_URL. Wraps the official Docker image so
 *                          no local install of sonar-scanner is required.
 *   sonar_issues        — fetch issues from the REST API. Filter by
 *                          severity / type (BUG, VULNERABILITY, CODE_SMELL).
 *   sonar_quality_gate  — fetch quality-gate status for a project.
 *   sonar_metrics       — fetch arbitrary metric values (code_smells,
 *                          duplicated_lines_density, complexity, etc.).
 *   sonar_hotspots      — fetch security hotspots.
 *
 * Configuration via environment variables (set in .mcp.json's `env` block
 * or in the user's shell):
 *
 *   SONAR_HOST_URL    — e.g. "https://sonar.1channel.co"  (required)
 *   SONAR_TOKEN       — analysis token (required for scan / private projects)
 *   SONAR_PROJECT_KEY — default project key, can be overridden per call
 *
 * The scan tool shells out to `docker run sonarsource/sonar-scanner-cli`,
 * so docker must be on PATH. All other tools talk to the REST API directly.
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: '@codeburn/mcp-sonar', version: '0.1.0' }

const HOST = (process.env.SONAR_HOST_URL || '').replace(/\/$/, '')
const TOKEN = process.env.SONAR_TOKEN || ''
const DEFAULT_PROJECT = process.env.SONAR_PROJECT_KEY || ''

// ────────────────────────────────────────────────────────────────────────────
// REST helpers
// ────────────────────────────────────────────────────────────────────────────

function ensureConfigured() {
  if (!HOST) throw new Error('SONAR_HOST_URL is not set')
  if (!TOKEN) throw new Error('SONAR_TOKEN is not set')
}

async function api(path, params = {}) {
  ensureConfigured()
  const url = new URL(HOST + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error('SonarQube ' + resp.status + ' on ' + path + ': ' + body.slice(0, 200))
  }
  return resp.json()
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: sonar_scan — run sonar-scanner via Docker
// ────────────────────────────────────────────────────────────────────────────

function spawnDocker(args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk) => { err += chunk.toString() })
    proc.on('error', rejectP)
    proc.on('close', (code) => {
      if (code === 0) resolveP({ stdout: out, stderr: err, code })
      else rejectP(new Error('docker exited ' + code + ': ' + err.slice(-2000)))
    })
  })
}

async function runScan({ workdir, projectKey, sources, exclusions, projectName }) {
  ensureConfigured()
  const cwd = resolve(workdir || process.cwd())
  const key = projectKey || DEFAULT_PROJECT
  if (!key) throw new Error('projectKey is required (set SONAR_PROJECT_KEY or pass projectKey)')

  const dockerArgs = [
    'run', '--rm',
    '-v', cwd + ':/usr/src',
    '-e', 'SONAR_HOST_URL=' + HOST,
    '-e', 'SONAR_TOKEN=' + TOKEN,
    'sonarsource/sonar-scanner-cli:latest',
    '-Dsonar.projectKey=' + key,
  ]
  if (projectName) dockerArgs.push('-Dsonar.projectName=' + projectName)
  if (sources) dockerArgs.push('-Dsonar.sources=' + sources)
  if (exclusions) dockerArgs.push('-Dsonar.exclusions=' + exclusions)
  // Push test directories under sonar.tests so the analyzer scopes test
  // smells separately from production code.
  dockerArgs.push('-Dsonar.tests=tests')
  dockerArgs.push('-Dsonar.test.exclusions=**/node_modules/**,**/dist/**')

  const { stdout, stderr } = await spawnDocker(dockerArgs)
  // Surface the analysis URL the scanner prints near the end of stdout.
  const dashboardMatch = stdout.match(/dashboard\?id=[^\s]+/)
  const dashboardUrl = dashboardMatch ? HOST + '/' + dashboardMatch[0] : HOST + '/dashboard?id=' + key
  return {
    content: [
      { type: 'text', text:
        'Scan complete. Project: ' + key + '\n' +
        'Dashboard: ' + dashboardUrl + '\n\n' +
        'Last 1000 chars of scanner stdout:\n' + stdout.slice(-1000) },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: sonar_issues — fetch issues
// ────────────────────────────────────────────────────────────────────────────

async function fetchIssues({ projectKey, severities, types, statuses, pageSize, page }) {
  const key = projectKey || DEFAULT_PROJECT
  if (!key) throw new Error('projectKey required')
  const data = await api('/api/issues/search', {
    componentKeys: key,
    severities,                      // e.g. "BLOCKER,CRITICAL"
    types: types ?? 'CODE_SMELL,BUG,VULNERABILITY',
    statuses: statuses ?? 'OPEN,CONFIRMED',
    ps: pageSize ?? 100,
    p: page ?? 1,
    s: 'SEVERITY',
    asc: false,
  })
  const summary = (data.issues || []).map((i) => ({
    severity: i.severity,
    type: i.type,
    rule: i.rule,
    message: i.message,
    component: i.component,
    line: i.line,
    effort: i.effort,
    tags: i.tags,
  }))
  return {
    content: [
      { type: 'text', text:
        'Total issues (across all pages): ' + data.total + '\n' +
        'Showing ' + summary.length + ' (page ' + (page ?? 1) + ')\n\n' +
        JSON.stringify(summary, null, 2) },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: sonar_quality_gate
// ────────────────────────────────────────────────────────────────────────────

async function fetchQualityGate({ projectKey }) {
  const key = projectKey || DEFAULT_PROJECT
  if (!key) throw new Error('projectKey required')
  const data = await api('/api/qualitygates/project_status', { projectKey: key })
  return {
    content: [{ type: 'text', text: JSON.stringify(data.projectStatus, null, 2) }],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: sonar_metrics
// ────────────────────────────────────────────────────────────────────────────

async function fetchMetrics({ projectKey, metricKeys }) {
  const key = projectKey || DEFAULT_PROJECT
  if (!key) throw new Error('projectKey required')
  const keys = metricKeys || 'code_smells,bugs,vulnerabilities,security_hotspots,coverage,duplicated_lines_density,ncloc,complexity,sqale_index,cognitive_complexity'
  const data = await api('/api/measures/component', { component: key, metricKeys: keys })
  return {
    content: [{ type: 'text', text: JSON.stringify(data.component?.measures ?? [], null, 2) }],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: sonar_hotspots
// ────────────────────────────────────────────────────────────────────────────

async function fetchHotspots({ projectKey, status, pageSize }) {
  const key = projectKey || DEFAULT_PROJECT
  if (!key) throw new Error('projectKey required')
  const data = await api('/api/hotspots/search', {
    projectKey: key,
    status: status ?? 'TO_REVIEW',
    ps: pageSize ?? 100,
  })
  const summary = (data.hotspots || []).map((h) => ({
    rule: h.ruleKey,
    securityCategory: h.securityCategory,
    vulnerabilityProbability: h.vulnerabilityProbability,
    component: h.component,
    line: h.line,
    message: h.message,
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MCP plumbing
// ────────────────────────────────────────────────────────────────────────────

const TOOLS = {
  sonar_scan: {
    description: 'Run sonar-scanner against a working tree and push results to SonarQube. Requires docker on PATH.',
    inputSchema: {
      type: 'object',
      properties: {
        workdir: { type: 'string', description: 'Absolute path to the source tree. Default: cwd.' },
        projectKey: { type: 'string', description: 'Project key on the SonarQube server. Falls back to SONAR_PROJECT_KEY env.' },
        projectName: { type: 'string', description: 'Display name for newly-provisioned projects.' },
        sources: { type: 'string', description: 'Comma-separated source paths (default: src,gnome,mac/Sources,scripts).' },
        exclusions: { type: 'string', description: 'Comma-separated glob exclusions.' },
      },
    },
    handler: runScan,
  },
  sonar_issues: {
    description: 'Fetch issues (CODE_SMELL / BUG / VULNERABILITY) for a SonarQube project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string' },
        severities: { type: 'string', description: 'Comma-separated severity filter: BLOCKER,CRITICAL,MAJOR,MINOR,INFO' },
        types: { type: 'string', description: 'Comma-separated types: CODE_SMELL,BUG,VULNERABILITY' },
        statuses: { type: 'string', description: 'Default OPEN,CONFIRMED' },
        pageSize: { type: 'number' },
        page: { type: 'number' },
      },
    },
    handler: fetchIssues,
  },
  sonar_quality_gate: {
    description: 'Fetch quality-gate status for a project.',
    inputSchema: { type: 'object', properties: { projectKey: { type: 'string' } } },
    handler: fetchQualityGate,
  },
  sonar_metrics: {
    description: 'Fetch metric values (code_smells, bugs, vulnerabilities, ncloc, complexity, …).',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string' },
        metricKeys: { type: 'string', description: 'Comma-separated metric keys.' },
      },
    },
    handler: fetchMetrics,
  },
  sonar_hotspots: {
    description: 'Fetch security hotspots for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string' },
        status: { type: 'string', description: 'TO_REVIEW (default), REVIEWED' },
        pageSize: { type: 'number' },
      },
    },
    handler: fetchHotspots,
  },
}

function rpcResult(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n' }
function rpcError(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n' }

async function dispatch(req) {
  switch (req.method) {
    case 'initialize':
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      })
    case 'tools/list':
      return rpcResult(req.id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    case 'tools/call': {
      const { name, arguments: args } = req.params ?? {}
      const tool = TOOLS[name]
      if (!tool) return rpcError(req.id, -32601, 'Unknown tool: ' + name)
      try {
        const out = await tool.handler(args ?? {})
        return rpcResult(req.id, out)
      } catch (e) {
        return rpcError(req.id, -32000, e?.message ?? String(e))
      }
    }
    case 'ping':
      return rpcResult(req.id, {})
    case 'notifications/initialized':
      return null
    default:
      return rpcError(req.id, -32601, 'Method not found: ' + req.method)
  }
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let lineEnd
  while ((lineEnd = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, lineEnd).trim()
    buffer = buffer.slice(lineEnd + 1)
    if (!line) continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    const resp = await dispatch(req)
    if (resp) process.stdout.write(resp)
  }
})
process.stdin.on('end', () => process.exit(0))
