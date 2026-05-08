// Currency formatter. Tray-side mirror of src/currency.ts on the CLI; we
// trust the CLI's already-converted numbers and just format for display.
export function formatUSD(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}
