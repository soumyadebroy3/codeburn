/**
 * Lightweight runtime schema validation for the JSONL boundaries that every
 * provider parser crosses. The goal is not zod-level richness; it is to give
 * parser code a single helper that turns a `JSON.parse(line)` (a hostile
 * `unknown`) into a typed shape with the obvious bad-actor paths killed:
 *
 *   - keys named `__proto__`, `prototype`, `constructor` are dropped from
 *     every record we materialise.
 *   - top-level non-objects, arrays, and `null` are rejected.
 *   - string fields enforce a max length to bound memory.
 *
 * Use at the line level. The provider then narrows further with its own
 * type guards.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const DEFAULT_MAX_STRING = 64 * 1024

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  // Reject objects whose prototype is something other than null or Object.
  // A future change in node:sqlite or fast-json-parse that returns custom
  // Map-like objects would otherwise sneak through.
  const proto = Object.getPrototypeOf(v)
  return proto === null || proto === Object.prototype
}

/**
 * Coerce arbitrary JSON-parse output into a Record<string, T> with the three
 * pollution keys filtered out. Non-object inputs return an empty (null-prototype)
 * record. Use as the entry point when you need to iterate keys/values from
 * untrusted JSON without allowing `__proto__` to leak.
 */
export function safeRecord<T = unknown>(input: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>
  if (!isPlainObject(input)) return out
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    out[key] = input[key] as T
  }
  return out
}

/**
 * Read a string field from an arbitrary record with a length cap. Returns
 * undefined on missing/non-string. The cap defends against a malicious JSONL
 * line containing a 200 MB single string blowing memory inside the parser.
 */
export function safeString(
  obj: Record<string, unknown>,
  key: string,
  maxLength: number = DEFAULT_MAX_STRING,
): string | undefined {
  const v = obj[key]
  if (typeof v !== 'string') return undefined
  if (v.length > maxLength) return v.slice(0, maxLength)
  return v
}

/**
 * Read a finite number from an arbitrary record. NaN/Infinity are rejected.
 */
export function safeNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return v
}

/**
 * Read a finite, non-negative integer (rounding floats down). Returns 0 on
 * missing/invalid. Use for token counts that must never go negative.
 */
export function safeUint(obj: Record<string, unknown>, key: string): number {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return Math.floor(v)
}

export function safeBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  return typeof v === 'boolean' ? v : undefined
}

/**
 * Parse one JSONL line with hostile-input safety: rejects non-object roots
 * and applies safeRecord. Returns null on parse failure or non-object root.
 */
export function parseJsonlObject(line: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  return safeRecord(parsed)
}
