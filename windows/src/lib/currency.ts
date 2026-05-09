/// Currency formatting that mirrors the macOS app's Double.asCurrency / asCompactCurrency.
/// The Rust backend hands us { code, symbol, rate } so the frontend stays dumb about FX --
/// it just multiplies and renders.

export type CurrencyState = {
  code: string
  symbol: string
  rate: number
}

export const USD: CurrencyState = { code: 'USD', symbol: '$', rate: 1 }

const FIXED_OPTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const

/// Wider format with thousands separators. Used for the hero value.
export function formatCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  return `${currency.symbol}${converted.toLocaleString('en-US', FIXED_OPTS)}`
}

/// Compact form (no thousands separators) used in dense tables where the monospace font
/// already gives visual grouping.
export function formatCompactCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  return `${currency.symbol}${converted.toFixed(2)}`
}
