/**
 * Provider plugin API (scaffold). Loads `~/.config/codeburn/providers/*.js`
 * at startup and registers any default-exported `Provider` with the discovery
 * pipeline. Lets users add support for new AI tools without forking the
 * codeburn npm package.
 *
 * Status: SCAFFOLD. The loader works, but plugins run with full Node
 * privileges in-process — no isolated worker, no sandbox. Production-grade
 * isolation is tracked under issue: harden via `worker_threads` with a
 * locked-down `process.exit`/`require` shim and an explicit allowlist of
 * filesystem roots.
 *
 * Plugin contract:
 *
 *   // ~/.config/codeburn/providers/my-tool.js
 *   export default {
 *     name: 'mytool',
 *     displayName: 'My Tool',
 *     modelDisplayName: (m) => m,
 *     toolDisplayName: (t) => t,
 *     async discoverSessions() { return [...] },
 *     createSessionParser(source, seenKeys) { ... },
 *   }
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Provider } from './providers/types.js'

function pluginDir(): string {
  return process.env.CODEBURN_PLUGIN_DIR
    ?? join(homedir(), '.config', 'codeburn', 'providers')
}

function isProvider(v: unknown): v is Provider {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<Provider>
  return typeof p.name === 'string'
    && typeof p.displayName === 'string'
    && typeof p.discoverSessions === 'function'
    && typeof p.createSessionParser === 'function'
}

export type LoadedPlugin = {
  path: string
  provider: Provider
}

export type PluginLoadResult = {
  loaded: LoadedPlugin[]
  errors: Array<{ path: string; error: string }>
}

export async function loadPlugins(): Promise<PluginLoadResult> {
  const dir = pluginDir()
  const result: PluginLoadResult = { loaded: [], errors: [] }
  if (!existsSync(dir)) return result

  // Refuse to load plugins from a world-writable parent directory: a global
  // /tmp/codeburn-plugins symlink would otherwise be a code-injection vector
  // for any other local user. We only load from $HOME-rooted dirs unless
  // CODEBURN_PLUGIN_DIR is explicitly opted into.
  if (process.env.CODEBURN_PLUGIN_DIR) {
    if (!dir.startsWith(homedir() + sep)) {
      result.errors.push({
        path: dir,
        error: 'CODEBURN_PLUGIN_DIR points outside $HOME — refusing to load',
      })
      return result
    }
  }

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    result.errors.push({ path: dir, error: (e as Error).message ?? 'unknown' })
    return result
  }

  for (const entry of entries) {
    if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue
    const full = join(dir, entry)
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: unknown }
      const candidate = mod.default
      if (!isProvider(candidate)) {
        result.errors.push({ path: full, error: 'default export is not a Provider' })
        continue
      }
      result.loaded.push({ path: full, provider: candidate })
    } catch (e) {
      result.errors.push({ path: full, error: (e as Error).message ?? 'unknown' })
    }
  }

  return result
}
