#!/usr/bin/env node
/**
 * @codeburn/mcp — minimal Model Context Protocol server exposing codeburn
 * usage data to AI agents. Speaks MCP-over-stdio JSON-RPC.
 *
 * STATUS: Scaffold. One real tool (`get_today_spend`) plus the introspection
 * surface (initialize, tools/list, tools/call). The remaining tools listed
 * in README will plug into the same dispatcher.
 *
 * Wire-format reference:
 *   https://modelcontextprotocol.io/docs/concepts/transports#stdio
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: '@codeburn/mcp', version: '0.0.1' }

const TOOLS = {
  get_today_spend: {
    description: 'Total AI coding spend today across every connected provider, in USD.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional provider filter (e.g. "claude", "codex"). Default: all.',
        },
      },
    },
    handler: async ({ provider }) => {
      const args = ['status', '--format', 'json']
      if (provider && /^[a-z0-9_-]+$/i.test(provider)) {
        args.push('--provider', provider)
      }
      const json = await spawnCodeburn(args)
      const parsed = JSON.parse(json)
      return {
        content: [
          {
            type: 'text',
            text: `Today: $${(parsed.today?.cost ?? 0).toFixed(2)} (${parsed.today?.calls ?? 0} calls). Generated ${parsed.generated ?? 'n/a'}.`,
          },
        ],
      }
    },
  },
}

function spawnCodeburn(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('codeburn', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (b) => { out += b.toString() })
    proc.stderr.on('data', (b) => { err += b.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`codeburn ${args.join(' ')} exited ${code}: ${err.trim()}`))
      else resolve(out.trim())
    })
  })
}

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
}

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
      if (!tool) return rpcError(req.id, -32601, `Unknown tool: ${name}`)
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
      return rpcError(req.id, -32601, `Method not found: ${req.method}`)
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
