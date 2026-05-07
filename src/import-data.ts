/**
 * `codeburn import` — multi-machine roll-up. Merges JSONL exports written by
 * other machines (typically synced via Dropbox/iCloud/etc.) into the local
 * daily-cache so a single `codeburn report` reflects all of them.
 *
 * Format: dated JSONL, one DailyEntry per line. Files are ordered by date
 * suffix in the filename (e.g. `codeburn-2026-04-15-laptop.jsonl`); the
 * importer sorts by date then merges by max-cost-wins so re-imports are
 * idempotent.
 */

import { readdir } from 'fs/promises'
import { join } from 'path'
import { readSessionLines } from './fs-utils.js'
import {
  loadDailyCache, saveDailyCache, addNewDays,
  type DailyEntry, type DailyCache, toDateString,
} from './daily-cache.js'

export type ImportReport = {
  filesScanned: number
  daysImported: number
  daysReplaced: number
  daysSkipped: number
  errors: string[]
}

const FILE_PATTERN = /^codeburn-(\d{4}-\d{2}-\d{2})-.*\.jsonl$/

function isDailyEntry(v: unknown): v is DailyEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Partial<DailyEntry>
  return typeof o.date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(o.date)
    && typeof o.cost === 'number'
    && typeof o.calls === 'number'
}

function mergeDailyEntry(existing: DailyEntry | undefined, incoming: DailyEntry): DailyEntry {
  if (!existing) return incoming
  // Pick the higher-cost record so re-imports don't accidentally undercount
  // when one machine has incomplete data. This is intentionally conservative;
  // a future flag can switch to sum-mode when users want roll-up across
  // machines that ran on the same day.
  if (incoming.cost >= existing.cost) return incoming
  return existing
}

export async function runImport(syncDir: string): Promise<ImportReport> {
  const report: ImportReport = {
    filesScanned: 0,
    daysImported: 0,
    daysReplaced: 0,
    daysSkipped: 0,
    errors: [],
  }

  let entries
  try {
    entries = await readdir(syncDir)
  } catch (e) {
    report.errors.push(`cannot read ${syncDir}: ${(e as Error).message ?? 'unknown'}`)
    return report
  }

  const candidates = entries.filter(f => FILE_PATTERN.test(f)).sort()

  const cache: DailyCache = await loadDailyCache()
  const existingByDate = new Map<string, DailyEntry>(cache.days.map(d => [d.date, d]))
  const newEntries: DailyEntry[] = []
  let newestDate = cache.lastComputedDate ?? toDateString(new Date(0))

  for (const file of candidates) {
    report.filesScanned += 1
    const path = join(syncDir, file)
    try {
      for await (const line of readSessionLines(path)) {
        if (!line.trim()) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { report.daysSkipped += 1; continue }
        if (!isDailyEntry(parsed)) { report.daysSkipped += 1; continue }
        const existing = existingByDate.get(parsed.date)
        const merged = mergeDailyEntry(existing, parsed)
        existingByDate.set(parsed.date, merged)
        if (existing) report.daysReplaced += 1
        else report.daysImported += 1
        if (parsed.date > newestDate) newestDate = parsed.date
      }
    } catch (e) {
      report.errors.push(`failed to read ${file}: ${(e as Error).message ?? 'unknown'}`)
    }
  }

  for (const e of existingByDate.values()) newEntries.push(e)

  const updated = addNewDays(
    { ...cache, days: [] },                  // start with existing days cleared so addNewDays picks our merged values
    newEntries,
    newestDate,
  )
  await saveDailyCache(updated)
  return report
}

export function formatImportReport(r: ImportReport): string {
  const lines = [
    '',
    `Imported ${r.daysImported} new day(s), replaced ${r.daysReplaced} existing day(s) from ${r.filesScanned} file(s).`,
    `Skipped ${r.daysSkipped} malformed line(s).`,
  ]
  if (r.errors.length > 0) {
    lines.push('')
    lines.push('Errors:')
    for (const e of r.errors) lines.push(`  ${e}`)
  }
  lines.push('')
  return lines.join('\n')
}
