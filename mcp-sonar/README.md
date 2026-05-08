# @codeburn/mcp-sonar

MCP server that wraps a SonarQube instance. Lets an AI agent push a working
tree for analysis, then query the resulting issues / quality gate / metrics
without leaving the chat.

## Tools

| Name | Purpose |
|---|---|
| `sonar_scan` | Run `sonar-scanner` (via Docker) and push to `SONAR_HOST_URL` |
| `sonar_issues` | Fetch CODE_SMELL / BUG / VULNERABILITY issues |
| `sonar_quality_gate` | Project quality-gate status |
| `sonar_metrics` | Arbitrary metrics (code_smells, complexity, ncloc, …) |
| `sonar_hotspots` | Security hotspots |

## Configuration

Set in `.mcp.json` (preferred) or the shell environment:

```jsonc
// codeburn/.mcp.json
{
  "mcpServers": {
    "sonarqube": {
      "command": "node",
      "args": ["mcp-sonar/server.mjs"],
      "type": "stdio",
      "env": {
        "SONAR_HOST_URL": "https://sonar.1channel.co",
        "SONAR_TOKEN": "${SONAR_TOKEN}",
        "SONAR_PROJECT_KEY": "codeburn"
      }
    }
  }
}
```

`${SONAR_TOKEN}` is read from the parent shell at MCP-server spawn time.
Generate one at `https://sonar.1channel.co` → My Account → Security.

## Local dev

```bash
SONAR_HOST_URL=https://sonar.1channel.co \
SONAR_TOKEN=xxx \
SONAR_PROJECT_KEY=codeburn \
node mcp-sonar/server.mjs
```

Speaks MCP-over-stdio.

## Quick ad-hoc scan (no MCP, just docker)

```bash
docker run --rm \
  -v "$PWD":/usr/src \
  -e SONAR_HOST_URL=https://sonar.1channel.co \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  sonarsource/sonar-scanner-cli \
  -Dsonar.projectKey=codeburn \
  -Dsonar.sources=src,gnome,mac/Sources,scripts \
  -Dsonar.tests=tests \
  -Dsonar.exclusions=node_modules/**,dist/**,**/.code-review-graph/**,src/data/litellm-snapshot.json
```
