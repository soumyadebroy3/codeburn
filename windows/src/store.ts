import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Period, ReportData } from './types'

// Tiny observable store. We don't pull in zustand — three fields and a
// listener set keep the binary trivially small (every dependency is bytes
// in the WebView shell).
type State = {
  period: Period
  data: ReportData | null
  loading: boolean
  error: string | null
  lastFetched: number | null
}

const state: State = {
  period: 'week',
  data: null,
  loading: false,
  error: null,
  lastFetched: null,
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function getState(): State {
  return state
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useStore(): State {
  return useSyncExternalStore(
    (cb) => subscribe(cb),
    getState,
    getState,
  )
}

export async function setPeriod(period: Period): Promise<void> {
  if (state.period === period) return
  state.period = period
  emit()
  await fetchReport()
}

export async function fetchReport(): Promise<void> {
  state.loading = true
  state.error = null
  emit()
  try {
    const result = await invoke<ReportData>('fetch_report', { period: state.period })
    state.data = result
    state.lastFetched = Date.now()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    state.loading = false
    emit()
  }
}

// 30-second auto-refresh. Tied to React lifecycle so we don't keep polling
// after the popover hides — Tauri can suspend the WebView on hide and we
// don't want a leaked interval to keep firing.
export function useAutoRefresh(intervalMs = 30_000): void {
  useEffect(() => {
    fetchReport().catch(() => {})
    const handle = setInterval(() => { fetchReport().catch(() => {}) }, intervalMs)
    return () => clearInterval(handle)
  }, [intervalMs])
}
