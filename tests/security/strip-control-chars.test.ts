import { describe, it, expect } from 'vitest'

import { stripControlChars } from '../../src/format.js'

// stripControlChars() is the shared chokepoint that sanitizes untrusted,
// transcript-derived strings (model / tool / MCP-server / project names) before
// they reach a terminal: the Ink dashboard (via fit()), the compare view (via
// shortName()), and CSV exports (via escCsv()). It must remove every class of
// terminal-escape injection — cursor moves, screen clears, OSC window-title /
// hyperlink spoofing, and the bell — while leaving ordinary text intact.
//
// Control bytes are built with String.fromCharCode so this source file contains
// no literal escape bytes.
const ch = (code: number) => String.fromCharCode(code)
const ESC = ch(0x1b)
const BEL = ch(0x07)

describe('stripControlChars', () => {
  it('strips CSI cursor-move and screen-clear sequences', () => {
    expect(stripControlChars(`a${ESC}[2J${ESC}[10Ab`)).toBe('ab')
    expect(stripControlChars(`${ESC}[1;1Hclaude`)).toBe('claude')
  })

  it('strips OSC window-title spoofing (OSC 0/2 ... BEL)', () => {
    expect(stripControlChars(`m${ESC}]0;HIJACKED-TITLE${BEL}x`)).toBe('mx')
    expect(stripControlChars(`${ESC}]2;owned${BEL}Sonnet`)).toBe('Sonnet')
  })

  it('strips OSC-8 hyperlink phishing wrappers', () => {
    expect(
      stripControlChars(`${ESC}]8;;http://creds.evil/login${BEL}Sonnet 4.5${ESC}]8;;${BEL}`),
    ).toBe('Sonnet 4.5')
  })

  it('strips a lone BEL, a lone ESC, and C1 / DEL control bytes', () => {
    expect(stripControlChars(`a${BEL}b`)).toBe('ab')
    expect(stripControlChars(`a${ESC}b`)).toBe('ab')
    // C1 CSI (0x9b), NEL (0x85), DEL (0x7f)
    expect(stripControlChars(`a${ch(0x9b)}b${ch(0x85)}c${ch(0x7f)}d`)).toBe('abcd')
  })

  it('strips C0 whitespace controls (tab/newline/CR) from single-line cells', () => {
    expect(stripControlChars('a\tb\nc\rd')).toBe('abcd')
  })

  it('leaves ordinary text, punctuation, and unicode untouched', () => {
    expect(stripControlChars('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(stripControlChars('mcp__server__tool (v2)')).toBe('mcp__server__tool (v2)')
    expect(stripControlChars('café — 日本語 — 🚀')).toBe('café — 日本語 — 🚀')
  })

  it('is idempotent', () => {
    const dirty = `${ESC}]0;x${BEL}model${ESC}[31m`
    expect(stripControlChars(stripControlChars(dirty))).toBe(stripControlChars(dirty))
  })
})
