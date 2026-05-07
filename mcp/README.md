# @codeburn/mcp (stub)

Model Context Protocol server that exposes codeburn usage data to AI agents.
Lets a Claude/Cursor/Codex agent ask "how much did I burn on Claude this week?"
and get an answer without leaving the editor.

## Status

**Scaffold.** This package wires up the MCP server skeleton and a single
`get_today_spend` tool. Real implementation tracked separately:

- `get_period_spend(period)` — full report for a window
- `get_top_sessions(n)` — most expensive sessions
- `get_optimize_findings()` — waste detector output
- `get_provider_breakdown()` — cost per AI tool
- `get_quota_status()` — Claude/Codex live quota %

## Wire it up (once published)

```jsonc
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "codeburn": {
      "command": "npx",
      "args": ["-y", "@codeburn/mcp"]
    }
  }
}
```

## Local dev

```bash
cd mcp
node server.mjs
```

Speaks MCP over stdio; pipe through any compatible client.
