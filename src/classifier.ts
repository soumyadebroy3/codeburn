import type { ClassifiedTurn, ParsedTurn, TaskCategory } from './types.js'

// Each pattern group is split into multiple smaller regexes so each individual
// literal stays well under Sonar's S5843 cognitive-complexity-of-regex
// threshold (20). Behaviour of the predicate is unchanged: anyMatch returns
// true if ANY of the regexes matches, which is identical to a single
// alternation regex.
function anyMatch(patterns: RegExp[], s: string): boolean {
  for (const p of patterns) {
    if (p.test(s)) return true
  }
  return false
}

const TEST_PATTERNS: RegExp[] = [
  /\b(?:test|pytest|vitest|jest|mocha|spec|coverage)\b/i,
  /\bnpm\s+test\b/i,
  /\bnpx\s+(?:vitest|jest)\b/i,
]
const GIT_PATTERNS: RegExp[] = [
  /\bgit\s+(?:push|pull|commit|merge|rebase|checkout|branch|stash)\b/i,
  /\bgit\s+(?:log|diff|status|add|reset|cherry-pick|tag)\b/i,
]
const BUILD_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:run\s+(?:build|dev)|publish|start)\b/i,
  /\b(?:pip\s+install|cargo\s+build|make\s+build|brew)\b/i,
  /\b(?:docker|deploy|pm2|systemctl)\b/i,
]
const INSTALL_PATTERNS: RegExp[] = [
  /\b(?:npm|pip|brew|apt)\s+install\b/i,
  /\bcargo\s+add\b/i,
]

const DEBUG_KEYWORDS: RegExp[] = [
  /\b(?:fix|bug|error|broken|failing|crash|issue|debug)\b/i,
  /\b(?:traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|status\s+code)\b/i,
  /\b(?:404|500|401|403)\b/i,
]
const FEATURE_KEYWORDS: RegExp[] = [
  /\b(?:add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate)\b/i,
  /\b(?:make|write)\s+(?:a|me|the)\b/i,
]
const REFACTOR_KEYWORDS: RegExp[] = [
  /\b(?:refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i,
]
const BRAINSTORM_KEYWORDS: RegExp[] = [
  /\b(?:brainstorm|idea|explore|think\s+about|approach|strategy|design|consider|opinion|suggest|recommend)\b/i,
  /\bwhat\s+(?:if|would)\b/i,
  /\bhow\s+should\b/i,
]
const RESEARCH_KEYWORDS: RegExp[] = [
  /\b(?:research|investigate|check|search|analyze|review|understand|explain|list|compare)\b/i,
  /\b(?:look\s+into|find\s+out|show\s+me)\b/i,
  /\b(?:how\s+does|what\s+is)\b/i,
]

const FILE_PATTERNS: RegExp[] = [
  /\.(?:py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh)\b/i,
  /\.(?:go|rs|java|rb|php|css|html|md|csv|xml)\b/i,
]
const SCRIPT_PATTERNS: RegExp[] = [
  /\brun\s+\S+\.\w+\b/i,
  /\b(?:execute|scrip?t|curl|endpoint|query|database)\b/i,
  /\b(?:api|fetch|db)\s+\S+/i,
  /\brequest\s+url\b/i,
]
const URL_PATTERN: RegExp[] = [
  /https?:\/\/\S+/i,
]

const EDIT_TOOLS = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit', 'cursor:edit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
export const BASH_TOOLS = new Set(['Bash', 'BashTool', 'PowerShellTool'])
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TodoWrite'])
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'ToolSearch'])

function hasEditTools(tools: string[]): boolean {
  return tools.some(t => EDIT_TOOLS.has(t))
}

function hasReadTools(tools: string[]): boolean {
  return tools.some(t => READ_TOOLS.has(t))
}

function hasBashTool(tools: string[]): boolean {
  return tools.some(t => BASH_TOOLS.has(t))
}

function hasTaskTools(tools: string[]): boolean {
  return tools.some(t => TASK_TOOLS.has(t))
}

function hasSearchTools(tools: string[]): boolean {
  return tools.some(t => SEARCH_TOOLS.has(t))
}

function hasMcpTools(tools: string[]): boolean {
  return tools.some(t => t.startsWith('mcp__'))
}

function hasSkillTool(tools: string[]): boolean {
  return tools.some(t => t === 'Skill')
}

function getAllTools(turn: ParsedTurn): string[] {
  return turn.assistantCalls.flatMap(c => c.tools)
}

function getAllSkills(turn: ParsedTurn): string[] {
  return turn.assistantCalls.flatMap(c => c.skills ?? [])
}

function classifyByToolPattern(turn: ParsedTurn): TaskCategory | null {
  const tools = getAllTools(turn)
  if (tools.length === 0) return null

  if (turn.assistantCalls.some(c => c.hasPlanMode)) return 'planning'
  if (turn.assistantCalls.some(c => c.hasAgentSpawn)) return 'delegation'

  const hasEdits = hasEditTools(tools)
  const hasReads = hasReadTools(tools)
  const hasBash = hasBashTool(tools)
  const hasTasks = hasTaskTools(tools)
  const hasSearch = hasSearchTools(tools)
  const hasMcp = hasMcpTools(tools)
  const hasSkill = hasSkillTool(tools)

  if (hasBash && !hasEdits) {
    const userMsg = turn.userMessage
    if (anyMatch(TEST_PATTERNS, userMsg)) return 'testing'
    if (anyMatch(GIT_PATTERNS, userMsg)) return 'git'
    if (anyMatch(BUILD_PATTERNS, userMsg)) return 'build/deploy'
    if (anyMatch(INSTALL_PATTERNS, userMsg)) return 'build/deploy'
  }

  if (hasEdits) return 'coding'

  if (hasBash && hasReads) return 'exploration'
  if (hasBash) return 'coding'

  if (hasSearch || hasMcp) return 'exploration'
  if (hasReads && !hasEdits) return 'exploration'
  if (hasTasks && !hasEdits) return 'planning'
  if (hasSkill) return 'general'

  return null
}

function refineByKeywords(category: TaskCategory, userMessage: string): TaskCategory {
  if (category === 'coding') {
    if (anyMatch(DEBUG_KEYWORDS, userMessage)) return 'debugging'
    if (anyMatch(REFACTOR_KEYWORDS, userMessage)) return 'refactoring'
    if (anyMatch(FEATURE_KEYWORDS, userMessage)) return 'feature'
    return 'coding'
  }

  if (category === 'exploration') {
    if (anyMatch(RESEARCH_KEYWORDS, userMessage)) return 'exploration'
    if (anyMatch(DEBUG_KEYWORDS, userMessage)) return 'debugging'
    return 'exploration'
  }

  return category
}

function classifyConversation(userMessage: string): TaskCategory {
  if (anyMatch(BRAINSTORM_KEYWORDS, userMessage)) return 'brainstorming'
  if (anyMatch(RESEARCH_KEYWORDS, userMessage)) return 'exploration'
  if (anyMatch(DEBUG_KEYWORDS, userMessage)) return 'debugging'
  if (anyMatch(FEATURE_KEYWORDS, userMessage)) return 'feature'
  if (anyMatch(FILE_PATTERNS, userMessage)) return 'coding'
  if (anyMatch(SCRIPT_PATTERNS, userMessage)) return 'coding'
  if (anyMatch(URL_PATTERN, userMessage)) return 'exploration'
  return 'conversation'
}

function countRetries(turn: ParsedTurn): number {
  let sawEditBeforeBash = false
  let sawBashAfterEdit = false
  let retries = 0

  for (const call of turn.assistantCalls) {
    const hasEdit = call.tools.some(t => EDIT_TOOLS.has(t))
    const hasBash = call.tools.some(t => BASH_TOOLS.has(t))

    if (hasEdit) {
      if (sawBashAfterEdit) retries++
      sawEditBeforeBash = true
      sawBashAfterEdit = false
    }
    if (hasBash && sawEditBeforeBash) {
      sawBashAfterEdit = true
    }
  }

  return retries
}

function turnHasEdits(turn: ParsedTurn): boolean {
  return turn.assistantCalls.some(c => c.tools.some(t => EDIT_TOOLS.has(t)))
}

export function classifyTurn(turn: ParsedTurn): ClassifiedTurn {
  const tools = getAllTools(turn)

  let category: TaskCategory

  if (tools.length === 0) {
    category = classifyConversation(turn.userMessage)
  } else {
    const toolCategory = classifyByToolPattern(turn)
    if (toolCategory) {
      category = refineByKeywords(toolCategory, turn.userMessage)
    } else {
      category = classifyConversation(turn.userMessage)
    }
  }

  const result: ClassifiedTurn = { ...turn, category, retries: countRetries(turn), hasEdits: turnHasEdits(turn) }

  if (category === 'general') {
    const skills = getAllSkills(turn)
    if (skills.length > 0) result.subCategory = skills[0]
  }

  return result
}
