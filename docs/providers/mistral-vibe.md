# Mistral Vibe

Mistral Vibe CLI.

- **Source:** `src/providers/mistral-vibe.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/mistral-vibe.test.ts`

## Where it reads from

`$VIBE_HOME/logs/session/` when `VIBE_HOME` is set, otherwise `~/.vibe/logs/session/`.

## Storage format

Vibe 2.x stores each session as a directory:

- `meta.json` contains session metadata, cumulative token totals, active model config, model prices, timestamps, working directory, and available tools.
- `messages.jsonl` contains non-system messages and assistant `tool_calls`.

Subagent traces are stored under a parent session's `agents/` folder with the same `meta.json` / `messages.jsonl` shape, so CodeBurn scans those one level down as separate sessions.

## Caching

None.

## Deduplication

Per `mistral-vibe:<session_id>`.

## Quirks

- **Usage is cumulative per session.** Vibe does not write per-assistant-message token usage into `messages.jsonl`; token counts come from `meta.json.stats.session_prompt_tokens` and `session_completion_tokens`. CodeBurn emits one usage record per Vibe session.
- **Cost prefers Vibe's own model prices.** `meta.json.stats.input_price_per_million` and `output_price_per_million` are used first, with the active model config as a fallback. LiteLLM pricing is only used when Vibe provides no price data.
- **Project names come from metadata.** Discovery uses `meta.json.environment.working_directory` and falls back to the session directory name if that field is missing.
- **Tool calls come from messages.** Assistant `tool_calls[*].function.name` is normalized to the standard CodeBurn names (`bash` to `Bash`, `search_replace` to `Edit`, etc.). Bash commands are extracted from `function.arguments.command`.

## When fixing a bug here

1. Reproduce with a fixture that has both `meta.json` and `messages.jsonl`; both files are required for current Vibe sessions.
2. If the bug is "wrong total", check `meta.json.stats` first. `messages.jsonl` is only for prompts and tool calls.
3. If a future Vibe release adds per-turn usage, add tests before changing the one-record-per-session behavior so historical sessions continue to parse correctly.
