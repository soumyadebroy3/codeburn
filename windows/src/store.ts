import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Period, ReportData } from './types'

// Tiny observable store. We don't pull in zustand — five fields and a
// listener set keep the binary trivially small.
//
// CRITICAL: useSyncExternalStore detects change via Object.is on the
// snapshot returned by getSnapshot. If we return the same `state` object
// reference every time, React thinks nothing changed and skips re-render
// even after we mutated fields and called emit(). The earlier version of
// this file did exactly that — the popover rendered once on mount, then
// ignored every subsequent state change (period clicks, fetched data,
// loading flag). Symptom: tabs appeared unresponsive, loading state
// stuck. Fix: maintain a separate `snapshot` reference and replace it
// (shallow clone) on every emit, so getSnapshot returns a new object
// when state has actually changed.
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

let snapshot: State = { ...state }
const listeners = new Set<() => void>()

function emit(): void {
  // Fresh reference so useSyncExternalStore's Object.is comparison sees
  // a change and triggers a re-render. Shallow clone is enough — none of
  // our state fields are nested objects we'd want React to walk into.
  snapshot = { ...state }
  for (const l of listeners) l()
}

export function getState(): State {
  return snapshot
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
