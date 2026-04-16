import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export type CodeburnConfig = {
  currency?: {
    code: string
    symbol?: string
  }
  modelAliases?: Record<string, string>
}

function getConfigDir(): string {
  return join(homedir(), '.config', 'codeburn')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export async function readConfig(): Promise<CodeburnConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as CodeburnConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: CodeburnConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function getConfigFilePath(): string {
  return getConfigPath()
}
