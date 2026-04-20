import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ParsedProviderCall, Provider, SessionSource } from '../src/providers/types.js'

let root = ''
let sourcePath = ''
let parseCalls = 0
let claudeRoot = ''
let claudeSessionPath = ''

function makeCall(index: number): ParsedProviderCall {
  const second = String(index).padStart(2, '0')
  return {
    provider: 'fake',
    model: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.01,
    tools: ['Edit'],
    bashCommands: [],
    timestamp: `2026-04-20T09:00:${second}.000Z`,
    speed: 'standard',
    deduplicationKey: `fake:${index}`,
    userMessage: `prompt ${index}`,
    sessionId: 'fake-session',
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-parser-cache-'))
  sourcePath = join(root, 'fake.jsonl')
  claudeRoot = join(root, '.claude')
  claudeSessionPath = join(claudeRoot, 'projects', 'demo-project', 'session.jsonl')
  parseCalls = 0
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = claudeRoot
  await writeFile(sourcePath, 'one\n', 'utf-8')
  await mkdir(join(claudeRoot, 'projects', 'demo-project'), { recursive: true })
  await writeFile(claudeSessionPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-04-20T09:00:00.000Z',
      sessionId: 'sess-1',
      message: { role: 'user', content: 'first' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-04-20T09:00:01.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        type: 'message',
        content: [],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ].join('\n') + '\n', 'utf-8')
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CLAUDE_CONFIG_DIR']
  await rm(root, { recursive: true, force: true })
  vi.resetModules()
  vi.clearAllMocks()
})

describe('parseAllSessions source cache', () => {
  it('uses one global progress lifecycle across provider refreshes', async () => {
    const fakeSource = {
      path: sourcePath,
      fingerprintPath: sourcePath,
      project: 'fake-project',
      provider: 'fake',
      cacheStrategy: 'full-reparse',
    } as SessionSource
    const claudeSource = {
      path: join(claudeRoot, 'projects', 'demo-project'),
      project: 'demo-project',
      provider: 'claude',
    } as SessionSource

    const fakeProvider: Provider = {
      name: 'fake',
      displayName: 'Fake',
      modelDisplayName: model => model,
      toolDisplayName: tool => tool,
      discoverSessions: async () => [fakeSource],
      createSessionParser() {
        return {
          async *parse() {
            parseCalls += 1
            const lineCount = (await readFile(sourcePath, 'utf-8')).trim().split('\n').filter(Boolean).length
            for (let i = 0; i < lineCount; i += 1) yield makeCall(i)
          },
        }
      },
    }

    vi.doMock('../src/providers/index.js', () => ({
      discoverAllSessions: async (providerFilter?: string) => {
        if (providerFilter === 'fake') return [fakeSource]
        return [claudeSource, fakeSource]
      },
      getProvider: async () => fakeProvider,
    }))

    const { parseAllSessions } = await import('../src/parser.js')

    const progress = {
      start: vi.fn(),
      advance: vi.fn(),
      finish: vi.fn(),
    }

    const first = await parseAllSessions(undefined, undefined, { progress })
    expect(first).toEqual(expect.any(Array))
    expect(parseCalls).toBe(1)
    expect(progress.start).toHaveBeenCalledTimes(1)
    expect(progress.start).toHaveBeenCalledWith(2)
    expect(progress.advance).toHaveBeenCalledWith('claude')
    expect(progress.advance).toHaveBeenCalledWith('fake')
    expect(progress.finish).toHaveBeenCalledTimes(1)
    expect(progress.finish).toHaveBeenCalledWith('fake')

    const second = await parseAllSessions(undefined, 'fake')
    expect(second[0]?.totalApiCalls).toBe(1)
    expect(parseCalls).toBe(1)

    await writeFile(sourcePath, 'one\ntwo\n', 'utf-8')
    const third = await parseAllSessions(undefined, 'fake')
    expect(third[0]?.totalApiCalls).toBe(2)
    expect(parseCalls).toBe(2)

    const rebuilt = await parseAllSessions(undefined, 'fake', { noCache: true })
    expect(rebuilt[0]?.totalApiCalls).toBe(2)
    expect(parseCalls).toBe(3)
  })

  it('reuses a broader cached window for a narrower date range', async () => {
    const providerName = 'fake-range-reuse'
    const fakeSource = {
      path: sourcePath,
      fingerprintPath: sourcePath,
      project: 'fake-project',
      provider: providerName,
      cacheStrategy: 'full-reparse',
    } as SessionSource

    const fakeProvider: Provider = {
      name: providerName,
      displayName: 'Fake',
      modelDisplayName: model => model,
      toolDisplayName: tool => tool,
      discoverSessions: async () => [fakeSource],
      createSessionParser() {
        return {
          async *parse() {
            parseCalls += 1
            yield { ...makeCall(0), timestamp: '2026-04-20T10:00:00.000Z', deduplicationKey: `${providerName}:day1` }
            yield { ...makeCall(1), timestamp: '2026-04-21T10:00:00.000Z', deduplicationKey: `${providerName}:day2` }
          },
        }
      },
    }

    vi.doMock('../src/providers/index.js', () => ({
      discoverAllSessions: async () => [fakeSource],
      getProvider: async () => fakeProvider,
    }))

    vi.resetModules()
    const { parseAllSessions: parseWithCache } = await import('../src/parser.js')

    const wide = {
      start: new Date('2026-04-19T00:00:00.000Z'),
      end: new Date('2026-04-21T23:59:59.999Z'),
    }
    const narrow = {
      start: new Date('2026-04-20T00:00:00.000Z'),
      end: new Date('2026-04-20T23:59:59.999Z'),
    }

    const wideProjects = await parseWithCache(wide, providerName)
    expect(wideProjects[0]?.totalApiCalls).toBe(2)
    expect(parseCalls).toBe(1)

    const narrowProjects = await parseWithCache(narrow, providerName)
    expect(narrowProjects[0]?.totalApiCalls).toBe(1)
    expect(parseCalls).toBe(1)
  })

  it('does not deduplicate claude turns across different session files', async () => {
    const sharedMsgId = 'msg_shared_duplicate_123'
    const secondSessionPath = join(claudeRoot, 'projects', 'demo-project', 'session-2.jsonl')
    await Promise.all([
      writeFile(claudeSessionPath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-20T09:00:00.000Z',
          sessionId: 'sess-1',
          message: { role: 'user', content: 'first' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-20T09:00:01.000Z',
          message: {
            id: sharedMsgId,
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            type: 'message',
            content: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        }),
      ].join('\n') + '\n'),
      writeFile(secondSessionPath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-20T09:05:00.000Z',
          sessionId: 'sess-2',
          message: { role: 'user', content: 'second' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-20T09:05:01.000Z',
          message: {
            id: sharedMsgId,
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            type: 'message',
            content: [],
            usage: { input_tokens: 11, output_tokens: 21 },
          },
        }),
      ].join('\n') + '\n'),
    ])

    vi.doUnmock('../src/providers/index.js')
    vi.resetModules()
    const { parseAllSessions } = await import('../src/parser.js')

    const first = await parseAllSessions(undefined, 'claude')
    const project = first.find(project => project.project === 'demo-project')
    expect(project?.totalApiCalls).toBe(2)

    const second = await parseAllSessions(undefined, 'claude')
    const cachedProject = second.find(project => project.project === 'demo-project')
    expect(cachedProject?.totalApiCalls).toBe(2)
  })

  it('filters cached full sessions down to the requested date range', async () => {
    const fakeSource = {
      path: sourcePath,
      fingerprintPath: sourcePath,
      project: 'fake-project',
      provider: 'fake',
      cacheStrategy: 'full-reparse',
      progressLabel: 'fake.jsonl',
    } as SessionSource

    const fakeProvider: Provider = {
      name: 'fake',
      displayName: 'Fake',
      modelDisplayName: model => model,
      toolDisplayName: tool => tool,
      discoverSessions: async () => [fakeSource],
      createSessionParser() {
        return {
          async *parse() {
            yield makeCall(0)
            yield { ...makeCall(1), timestamp: '2026-04-21T10:00:00.000Z', deduplicationKey: 'fake:next-day' }
          },
        }
      },
    }

    vi.doMock('../src/providers/index.js', () => ({
      discoverAllSessions: async () => [fakeSource],
      getProvider: async () => fakeProvider,
    }))

    const { parseAllSessions } = await import('../src/parser.js')
    await parseAllSessions(undefined, 'fake')

    const onlyFirstDay = await parseAllSessions({
      start: new Date('2026-04-20T00:00:00.000Z'),
      end: new Date('2026-04-20T23:59:59.999Z'),
    }, 'fake')

    expect(onlyFirstDay[0]?.totalApiCalls).toBe(1)
  })

  it('refreshes appended Claude log entries on the next run', async () => {
    vi.doUnmock('../src/providers/index.js')
    vi.resetModules()
    const { parseAllSessions } = await import('../src/parser.js')

    const first = await parseAllSessions(undefined, 'claude')
    expect(first.find(project => project.project === 'demo-project')?.totalApiCalls).toBe(1)

    await appendFile(claudeSessionPath, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-20T09:05:00.000Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'second' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-20T09:05:01.000Z',
        message: {
          id: 'msg-2',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          type: 'message',
          content: [],
          usage: { input_tokens: 11, output_tokens: 21 },
        },
      }),
    ].join('\n') + '\n', 'utf-8')

    const second = await parseAllSessions(undefined, 'claude')
    expect(second.find(project => project.project === 'demo-project')?.totalApiCalls).toBe(2)
  })

  it('falls back to a full Claude reparse when cached tail verification fails', async () => {
    vi.doUnmock('../src/providers/index.js')
    vi.resetModules()
    const { parseAllSessions } = await import('../src/parser.js')
    await parseAllSessions(undefined, 'claude')

    const cacheRoot = join(root, 'cache', 'source-cache-v1')
    const manifest = JSON.parse(await readFile(join(cacheRoot, 'manifest.json'), 'utf-8')) as {
      entries: Record<string, { file: string }>
    }
    const entryPath = join(cacheRoot, 'entries', manifest.entries[`claude:${claudeSessionPath}`]!.file)
    const entry = JSON.parse(await readFile(entryPath, 'utf-8')) as {
      appendState?: { tailHash?: string }
    }
    entry.appendState = { ...entry.appendState, tailHash: 'broken-tail-hash' }
    await writeFile(entryPath, JSON.stringify(entry), 'utf-8')

    await appendFile(claudeSessionPath, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-20T09:05:00.000Z',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'second' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-20T09:05:01.000Z',
        message: {
          id: 'msg-2',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          type: 'message',
          content: [],
          usage: { input_tokens: 11, output_tokens: 21 },
        },
      }),
    ].join('\n') + '\n', 'utf-8')

    vi.resetModules()
    const readSessionFileCalls: string[] = []
    const readSessionLinesFromOffsetCalls: Array<[string, number]> = []
    vi.doMock('../src/fs-utils.js', async () => {
      const actual = await vi.importActual<typeof import('../src/fs-utils.js')>('../src/fs-utils.js')
      return {
        ...actual,
        readSessionFile: vi.fn(async (filePath: string) => {
          readSessionFileCalls.push(filePath)
          return actual.readSessionFile(filePath)
        }),
        readSessionLinesFromOffset: vi.fn(async function* (filePath: string, startOffset: number) {
          readSessionLinesFromOffsetCalls.push([filePath, startOffset])
          for await (const line of actual.readSessionLinesFromOffset(filePath, startOffset)) {
            yield line
          }
        }),
      }
    })

    const { parseAllSessions: reparsedParseAllSessions } = await import('../src/parser.js')
    const reparsed = await reparsedParseAllSessions(undefined, 'claude')

    expect(reparsed.find(project => project.project === 'demo-project')?.totalApiCalls).toBe(2)
    expect(readSessionFileCalls).toContain(claudeSessionPath)
    expect(readSessionLinesFromOffsetCalls).toHaveLength(0)
  })

  it('keeps appended assistant-only Claude entries inside the existing turn', async () => {
    vi.doUnmock('../src/providers/index.js')
    vi.resetModules()
    const { parseAllSessions } = await import('../src/parser.js')

    const first = await parseAllSessions(undefined, 'claude')
    const initialSession = first.find(project => project.project === 'demo-project')?.sessions[0]
    expect(initialSession?.turns).toHaveLength(1)

    await appendFile(claudeSessionPath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-04-20T09:05:01.000Z',
      message: {
        id: 'msg-2',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        type: 'message',
        content: [],
        usage: { input_tokens: 11, output_tokens: 21 },
      },
    }) + '\n', 'utf-8')

    const second = await parseAllSessions(undefined, 'claude')
    const session = second.find(project => project.project === 'demo-project')?.sessions[0]

    expect(session?.apiCalls).toBe(2)
    expect(session?.turns).toHaveLength(1)
    expect(session?.turns[0]?.userMessage).toBe('first')
    expect(session?.turns[0]?.assistantCalls).toHaveLength(2)
  })

  it('caches Claude session files that contain no turns', async () => {
    await writeFile(claudeSessionPath, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-20T09:00:00.000Z',
        sessionId: 'sess-empty',
        message: { role: 'user', content: 'no assistant response' },
      }),
    ].join('\n') + '\n', 'utf-8')

    const readSessionFileCalls: string[] = []
    vi.doMock('../src/fs-utils.js', async () => {
      const actual = await vi.importActual<typeof import('../src/fs-utils.js')>('../src/fs-utils.js')
      return {
        ...actual,
        readSessionFile: vi.fn(async (filePath: string) => {
          readSessionFileCalls.push(filePath)
          return actual.readSessionFile(filePath)
        }),
      }
    })

    vi.resetModules()
    const { parseAllSessions } = await import('../src/parser.js')

    const first = await parseAllSessions(undefined, 'claude')
    const cacheRoot = join(root, 'cache', 'source-cache-v1')
    const manifest = JSON.parse(await readFile(join(cacheRoot, 'manifest.json'), 'utf-8')) as {
      entries: Record<string, { file: string }>
    }
    const entryKey = `claude:${claudeSessionPath}`
    expect(manifest.entries[entryKey]).toBeDefined()
    const cacheEntry = JSON.parse(await readFile(join(cacheRoot, 'entries', manifest.entries[entryKey]!.file), 'utf-8')) as { sessions: unknown[] }

    expect(first.find(project => project.project === 'demo-project')?.totalApiCalls).toBeUndefined()
    expect(readSessionFileCalls.filter(path => path === claudeSessionPath)).toHaveLength(1)
    expect(cacheEntry.sessions).toHaveLength(0)

    const second = await parseAllSessions(undefined, 'claude')
    expect(second.find(project => project.project === 'demo-project')?.totalApiCalls).toBeUndefined()
    expect(readSessionFileCalls.filter(path => path === claudeSessionPath)).toHaveLength(1)
  })
})
