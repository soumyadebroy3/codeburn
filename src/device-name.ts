import { hostname } from 'node:os'
import { execFileSync } from 'node:child_process'

// A clean, human-readable name for THIS machine, for display in the web
// dashboard's device list. Node's hostname() returns the noisy Bonjour/mDNS
// form (e.g. "soumyas-MacBook-Air-3.local" — a ".local" suffix plus an "-N"
// collision digit). On macOS the user-facing ComputerName ("Soumya's MacBook
// Air") is far nicer, so prefer it. Memoized: the name doesn't change within a
// process and scutil is a subprocess.
let cached: string | null = null

export function getDeviceName(): string {
  if (cached === null) cached = computeDeviceName()
  return cached
}

function computeDeviceName(): string {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim()
      // Strip a trailing " (2)" network-collision marker macOS appends when two
      // devices share a ComputerName — noise for a single-device dashboard.
      if (out) return out.replace(/\s*\(\d+\)$/, '')
    } catch {
      // scutil missing or sandboxed — fall through to the hostname fallback.
    }
  }
  // Non-macOS / fallback: drop a trailing ".local" and a small "-N" collision
  // suffix (kept to 1–2 digits so a legitimate name like "mac-mini-2020" is
  // preserved).
  return hostname().replace(/\.local$/i, '').replace(/-\d{1,2}$/, '')
}
