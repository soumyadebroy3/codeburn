import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { setTimeout as delay } from 'timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const outPath = join(repoRoot, 'src', 'data', 'litellm-snapshot.json')
const pinPath = join(__dirname, 'litellm-pin.json')

const printShaOnly = process.argv.includes('--print-sha')

const MANUAL_ENTRIES = {
  'MiniMax-M2.7':           [0.3e-6, 1.2e-6, 0.375e-6, 0.06e-6],
  'MiniMax-M2.7-highspeed': [0.6e-6, 2.4e-6, 0.375e-6, 0.06e-6],
}

// =============================================================================
// 1. Read pin config
// =============================================================================
const pin = JSON.parse(readFileSync(pinPath, 'utf-8'))
const sha = String(pin.commitSha || '').trim()
if (!sha) {
  console.error('litellm-pin.json: commitSha is empty')
  process.exit(1)
}

// During development the pin can be left as `main` (intentional drift). The
// build refuses to use a floating ref outside CODEBURN_DEV so the npm tarball
// is always reproducible.
if (sha === 'main' && process.env.CODEBURN_DEV !== '1' && !printShaOnly) {
  console.error(
    'litellm-pin.json: commitSha is "main" — refusing to build a non-reproducible bundle. ' +
    'Either pin to a 40-char SHA or set CODEBURN_DEV=1 for local-only builds.',
  )
  process.exit(1)
}

if (sha !== 'main' && !/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`litellm-pin.json: commitSha must be a 40-char hex SHA or "main", got: ${sha}`)
  process.exit(1)
}

const LITELLM_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${sha}/model_prices_and_context_window.json`

// =============================================================================
// 2. Fetch with timeout + retry
// =============================================================================
async function fetchWithTimeout(url, ms = 30_000) {
  const ctrl = new AbortController()
  const timer = global.setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'codeburn-bundle-litellm (+https://github.com/getagentseal/codeburn)',
        'Accept': 'application/json',
      },
    })
  } finally {
    global.clearTimeout(timer)
  }
}

let res
let lastErr
for (let i = 0; i < 3; i++) {
  try {
    res = await fetchWithTimeout(LITELLM_URL)
    if (res.ok) break
    lastErr = new Error(`HTTP ${res.status}`)
  } catch (e) {
    lastErr = e
  }
  if (i < 2) await delay(1000 * (i + 1))
}
if (!res || !res.ok) {
  console.error(`Failed to fetch ${LITELLM_URL}: ${lastErr?.message ?? 'unknown'}`)
  process.exit(1)
}

const rawText = await res.text()
const actualSha256 = createHash('sha256').update(rawText).digest('hex')

if (printShaOnly) {
  console.log(actualSha256)
  process.exit(0)
}

// =============================================================================
// 3. Verify SHA-256 against pin (skip when pin is "main" + CODEBURN_DEV=1)
// =============================================================================
const expectedSha = (pin.expectedSha256 ?? '').toLowerCase().trim()
if (sha !== 'main' && expectedSha) {
  if (actualSha256 !== expectedSha) {
    console.error(
      `litellm-pin.json: SHA-256 mismatch for commit ${sha}.\n` +
      `  expected: ${expectedSha}\n` +
      `  got:      ${actualSha256}\n` +
      `If the upstream content has changed deliberately, update expectedSha256 in litellm-pin.json. ` +
      `If not, this is a supply-chain anomaly — investigate before bumping.`,
    )
    process.exit(1)
  }
} else if (sha !== 'main') {
  console.error(
    `litellm-pin.json: expectedSha256 is empty but commitSha is pinned. ` +
    `Run \`node scripts/bundle-litellm.mjs --print-sha\` and paste the result into the pin file.`,
  )
  process.exit(1)
}

// =============================================================================
// 4. Parse + shape-validate
// =============================================================================
let data
try {
  data = JSON.parse(rawText)
} catch (e) {
  console.error(`Upstream returned non-JSON: ${e.message}`)
  process.exit(1)
}

if (typeof data !== 'object' || data === null || Array.isArray(data)) {
  console.error('Upstream payload is not a JSON object')
  process.exit(1)
}

const entries = Object.entries(data).filter(([k]) => k !== 'sample_spec')
if (entries.length < (pin.minEntries ?? 200)) {
  console.error(`Refusing to bundle: upstream has only ${entries.length} entries (min ${pin.minEntries}).`)
  process.exit(1)
}
if (entries.length > (pin.maxEntries ?? 50_000)) {
  console.error(`Refusing to bundle: upstream has ${entries.length} entries (max ${pin.maxEntries}).`)
  process.exit(1)
}

function toVal(entry) {
  const inp = entry.input_cost_per_token
  const out = entry.output_cost_per_token
  if (inp == null || out == null) return null
  // Reject negative or absurdly high prices ($10/token would mean someone broke the upstream).
  if (typeof inp !== 'number' || typeof out !== 'number') return null
  if (!Number.isFinite(inp) || !Number.isFinite(out)) return null
  if (inp < 0 || out < 0) return null
  if (inp > 1e-2 || out > 1e-2) return null
  const cwt = entry.cache_creation_input_token_cost
  const crt = entry.cache_read_input_token_cost
  return [inp, out, typeof cwt === 'number' && Number.isFinite(cwt) ? cwt : null,
                     typeof crt === 'number' && Number.isFinite(crt) ? crt : null]
}

const snapshot = {}

// Pass 1: direct entries (no prefix) get priority
for (const [name, entry] of entries) {
  if (typeof name !== 'string' || name.includes('/')) continue
  const val = toVal(entry)
  if (val) snapshot[name] = val
}

// Pass 2: prefixed entries - store full key + stripped (first-write-wins)
for (const [name, entry] of entries) {
  if (typeof name !== 'string' || !name.includes('/')) continue
  const val = toVal(entry)
  if (!val) continue
  if (!snapshot[name]) snapshot[name] = val
  const stripped = name.replace(/^[^/]+\//, '')
  if (stripped !== name && !snapshot[stripped]) snapshot[stripped] = val
}

Object.assign(snapshot, MANUAL_ENTRIES)

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(snapshot))
console.log(`Bundled ${Object.keys(snapshot).length} models from litellm@${sha.slice(0, 12)} (sha256 ${actualSha256.slice(0, 16)}…) → src/data/litellm-snapshot.json`)
