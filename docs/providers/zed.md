# Zed

Zed's built-in agent (the Assistant / Agent panel in the Zed editor).

- **Source:** `src/providers/zed.ts`
- **Loading:** lazy (`src/providers/index.ts`). Lazy because Zed stores threads in a single SQLite database that we read with `node:sqlite`, and the blobs are zstd-compressed (needs Node's `zlib.zstdDecompressSync`, added in Node 22.15 / 23.8).
- **Test:** `tests/providers/zed.test.ts` (fixture-based; skipped on Node builds without `node:sqlite` or without `zlib` zstd support).

## Where it reads from

A single threads database, one row per thread.

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Zed/threads/threads.db` |
| Windows | `~/AppData/Local/Zed/threads/threads.db` |
| Linux | `~/.local/share/zed/threads/threads.db` |

## Storage format

SQLite. The `threads` table has a `data` BLOB column whose contents are decided by `data_type`:

- `zstd` — the current save path; the blob is zstd-compressed JSON.
- `json` — legacy uncompressed rows; the blob is plain UTF-8 JSON.

Any other `data_type` is treated as unknown and skipped.

The decompressed JSON carries the thread's model and its token accounting:

```jsonc
{
  "model": { "provider": "anthropic", "model": "claude-opus-4-8" },
  "request_token_usage": {
    "<user-message-key>": {
      "input_tokens": 1200,
      "output_tokens": 300,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 90000
    }
  },
  "cumulative_token_usage": { "input_tokens": 2000, "output_tokens": 450 }
}
```

Token fields are already Anthropic-shaped, so they map straight onto codeburn's cache/reasoning-exclusive convention with no decomposition.

## Caching

None at the provider level.

## Deduplication

Per `zed:<threadId>:<requestKey>` (`zed.ts`). `requestKey` is either a key from `request_token_usage` or the synthetic `cumulative-remainder`. The `seenKeys` set is shared across parses so repeat scans do not double-count.

## What we extract

| codeburn field | Zed source |
|---|---|
| `inputTokens` | `request_token_usage[key].input_tokens` |
| `outputTokens` | `request_token_usage[key].output_tokens` |
| `cacheCreationInputTokens` | `cache_creation_input_tokens` |
| `cacheReadInputTokens` / `cachedInputTokens` | `cache_read_input_tokens` |
| `model` | `model.model` (falls back to `unknown`) |
| `timestamp` | `threads.updated_at` |
| `userMessage` | `threads.summary` |
| `sessionId` | `threads.id` |

`reasoningTokens`, `webSearchRequests`, `tools`, and `bashCommands` are all left as zero / empty. Zed does not record per-tool calls in a form we read.

## Quirks worth knowing

- **The per-request map undercounts.** `request_token_usage` is keyed by user message and does not cover every request (verified on a real thread: `cumulative_token_usage` was ~3x the map sum). The parser emits one call per non-empty map entry, then adds a synthetic `cumulative-remainder` call so the thread's totals match the exact `cumulative_token_usage` counter without double-counting.
- **Empty maps degrade to one cumulative call.** A thread whose `request_token_usage` is empty but whose `cumulative_token_usage` is non-empty produces a single `cumulative-remainder` call.
- **Zero-usage threads are skipped.** Entries whose token counts are all zero never produce a call.
- **zstd support is required.** `zlib.zstdDecompressSync` landed in Node 22.15 / 23.8. On older Node the provider writes a notice to stderr and yields nothing rather than crashing (the package floor is 22.13).
- **Unreadable rows are skipped, not fatal.** Rows with an unknown `data_type` or a blob that fails to decompress/parse are counted and reported (`skipped N unreadable Zed threads`) but do not drop healthy threads.

## When fixing a bug here

1. Confirm the issue against a real Zed install; check the `threads` table shape (`data_type`, `data`) before assuming the schema changed.
2. If totals look ~3x too low, the `cumulative-remainder` top-up is likely broken; verify the sum of per-request entries against `cumulative_token_usage`.
3. If Zed sessions show timestamps from 1970, check that `updated_at` is still an ISO-8601 string (the parser feeds it straight into `new Date`).
4. If the model shows `unknown`, the thread JSON has no `model.model`; confirm the field path is still `model.model`.
5. New fixtures go under the inline `CREATE TABLE threads` schema in `tests/providers/zed.test.ts`; keep it synchronized with Zed's actual columns.
