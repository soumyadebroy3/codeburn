# Open Design

Open Design — a desktop agentic-coding app that makes its own LLM API calls and records per-run token usage natively as a JSONL event stream, so codeburn reads it directly.

- **Source:** `src/providers/open-design.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/open-design.test.ts`

## Where it reads from

| Order | Path |
|---|---|
| 1 | `$CODEBURN_OPEN_DESIGN_DIR` (codeburn-only override) |
| 2 | `~/Library/Application Support/Open Design` (macOS) |
| 2 | `%APPDATA%\Open Design` (Windows) |
| 2 | `~/.config/Open Design` (Linux) |

Session files: `<base>/namespaces/<namespace>/data/runs/<runId>/events.jsonl`. The override may point at any level of that tree — a `namespaces/` dir, a single namespace's `data/` dir, or a bare `runs/` dir — and discovery normalizes accordingly (see Quirks). The project label is the `<namespace>` directory name; when discovery is rooted below the namespace level the label falls back to the nearest meaningful directory name (or `open-design`).

## Storage format

JSONL, one event per line. Each line is `{ id, event, timestamp, data }`. The parser tracks the active model across the run and emits one call per usage event:

- `event: "start"` with `data.model` seeds the initial model.
- `event: "agent"` with `data.type === "status"` and `data.model` switches the active model mid-run.
- `event: "agent"` with `data.type === "usage"` carries `data.usage` (`{ input_tokens, output_tokens, cached_read_tokens, thought_tokens }`) and is attributed to the currently active model.

Timestamps are either ISO strings or numeric epoch milliseconds; numeric values are normalized to ISO via `new Date(ms).toISOString()`.

## Pricing

Cost is recomputed locally via `calculateCost` from the LiteLLM snapshot. `input_tokens` is treated as **inclusive** of cache reads, so the uncached input passed to pricing is `input_tokens − cached_read_tokens`. Reasoning (`thought_tokens`) bills at the output rate, so it is folded into the output arg (`output_tokens + thought_tokens`).

On-disk model strings can be `provider:modelId` (e.g. `openai-codex:gpt-5.5`). codeburn's canonicalizer (`getCanonicalName`) only strips slash-style prefixes, so a colon-prefixed id would price at $0 unless it is registered as a `BUILTIN_ALIASES` entry mapping to the bare LiteLLM id (`openai-codex:gpt-5.5` → `gpt-5.5`).

## Caching

None at the provider level.

## Deduplication

Per `open-design:<runId>:<event.id>`. `<runId>` is the run directory name. For id-less lines the key falls back to a per-run event counter. The `seenKeys` set is shared across parser runs, so re-parsing the same run emits nothing the second time.

## Quirks

- **Flexible discovery root.** `$CODEBURN_OPEN_DESIGN_DIR` may point at a `namespaces/` dir, a namespace's `data/` dir, or a `runs/` dir directly; discovery detects the level from the basename and walks down to per-run `events.jsonl` files, deduping paths.
- **Active-model tracking.** Usage events do not carry the model; the model comes from the preceding `start` or `status` event, so a mixed-model run yields separate per-model calls.
- **No tools / user prompt / web search.** The event stream captured here records only usage, so `tools`, `bashCommands`, `userMessage` are empty and `webSearchRequests` is always `0`.

## When fixing a bug here

1. Confirm whether the bug is in **discovery** (runs not picked up — `discoverOpenDesignSessions`/`discoverRunsDir`/`discoverNamespacesDir`) or **parsing** (`createParser`).
2. `data.usage` field names (`input_tokens`, `output_tokens`, `cached_read_tokens`, `thought_tokens`) come straight from the on-disk stream; validate against a real `events.jsonl` sample.
3. Add a fixture-driven case to `tests/providers/open-design.test.ts` under `tests/fixtures/open-design/...`. Do not mock the filesystem; write a temp namespaces/runs layout like the existing fixtures and point `CODEBURN_OPEN_DESIGN_DIR` at it.
