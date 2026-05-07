import { describe, it, expect } from 'vitest'
import { safeRecord, safeString, safeUint, safeNumber, safeBoolean, parseJsonlObject, isPlainObject } from '../src/schema.js'

describe('safeRecord', () => {
  it('strips __proto__ / prototype / constructor', () => {
    // `{ __proto__: {...} }` in source code is sugar for setPrototypeOf, NOT
    // an own property. Use JSON.parse so __proto__ becomes a regular own key,
    // which is the real attack vector codeburn faces (parsed-from-JSONL data).
    const r = safeRecord(JSON.parse('{"a":1,"__proto__":{"polluted":true},"prototype":2,"constructor":3}'))
    expect(r.a).toBe(1)
    expect(Object.keys(r).sort()).toEqual(['a'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('uses a null prototype', () => {
    const r = safeRecord({ a: 1 })
    expect(Object.getPrototypeOf(r)).toBeNull()
  })

  it('returns empty record for non-objects', () => {
    expect(Object.keys(safeRecord(null))).toEqual([])
    expect(Object.keys(safeRecord('hi'))).toEqual([])
    expect(Object.keys(safeRecord(42))).toEqual([])
    expect(Object.keys(safeRecord([1, 2, 3]))).toEqual([])
  })
})

describe('safeString', () => {
  it('reads strings', () => {
    expect(safeString({ k: 'hello' }, 'k')).toBe('hello')
  })
  it('returns undefined for missing/non-string', () => {
    expect(safeString({ k: 1 }, 'k')).toBeUndefined()
    expect(safeString({}, 'k')).toBeUndefined()
  })
  it('caps length', () => {
    const big = 'a'.repeat(1000)
    expect(safeString({ k: big }, 'k', 100)).toHaveLength(100)
  })
})

describe('safeUint', () => {
  it('returns positive integers verbatim', () => {
    expect(safeUint({ k: 5 }, 'k')).toBe(5)
  })
  it('floors floats', () => {
    expect(safeUint({ k: 3.7 }, 'k')).toBe(3)
  })
  it('returns 0 for negatives, NaN, Infinity, non-numbers', () => {
    expect(safeUint({ k: -1 }, 'k')).toBe(0)
    expect(safeUint({ k: NaN }, 'k')).toBe(0)
    expect(safeUint({ k: Infinity }, 'k')).toBe(0)
    expect(safeUint({ k: '5' }, 'k')).toBe(0)
    expect(safeUint({}, 'k')).toBe(0)
  })
})

describe('safeNumber', () => {
  it('rejects non-finite', () => {
    expect(safeNumber({ k: NaN }, 'k')).toBeUndefined()
    expect(safeNumber({ k: Infinity }, 'k')).toBeUndefined()
    expect(safeNumber({ k: -Infinity }, 'k')).toBeUndefined()
  })
  it('accepts finite including negative and zero', () => {
    expect(safeNumber({ k: 0 }, 'k')).toBe(0)
    expect(safeNumber({ k: -1.5 }, 'k')).toBe(-1.5)
  })
})

describe('safeBoolean', () => {
  it('only returns booleans', () => {
    expect(safeBoolean({ k: true }, 'k')).toBe(true)
    expect(safeBoolean({ k: false }, 'k')).toBe(false)
    expect(safeBoolean({ k: 'true' }, 'k')).toBeUndefined()
    expect(safeBoolean({ k: 1 }, 'k')).toBeUndefined()
  })
})

describe('parseJsonlObject', () => {
  it('parses valid object', () => {
    expect(parseJsonlObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects non-objects', () => {
    expect(parseJsonlObject('null')).toBeNull()
    expect(parseJsonlObject('42')).toBeNull()
    expect(parseJsonlObject('"hi"')).toBeNull()
    expect(parseJsonlObject('[1,2]')).toBeNull()
  })
  it('returns null on parse error', () => {
    expect(parseJsonlObject('{not valid')).toBeNull()
  })
  it('strips __proto__', () => {
    const r = parseJsonlObject('{"a":1,"__proto__":{"x":1}}')
    expect(r).not.toBeNull()
    expect(r!.a).toBe(1)
    expect(Object.keys(r!)).toEqual(['a'])
  })
})

describe('isPlainObject', () => {
  it('accepts plain literals and Object.create(null)', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })
  it('rejects null/array/primitive/class instances', () => {
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(0)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
  })
})
