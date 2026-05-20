import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

// Keep in lockstep with the CLI provider keys (`provider.name` on each
// Provider export in src/providers/) AND the Swift ProviderFilter enum in
// mac/Sources/CodeBurnMenubar/AppStore.swift. Missing entries here mean
// the tray won't render a tab for that provider even when the CLI emits
// cost for it.
export type Provider =
  | 'all'
  | 'antigravity'
  | 'claude'
  | 'cline'
  | 'codebuff'
  | 'codex'
  | 'copilot'
  | 'crush'
  | 'cursor'
  | 'cursor-agent'
  | 'droid'
  | 'gemini'
  | 'goose'
  | 'ibm-bob'
  | 'kimi'
  | 'kilo-code'
  | 'kiro'
  | 'mistral-vibe'
  | 'omp'
  | 'openclaw'
  | 'opencode'
  | 'pi'
  | 'qwen'
  | 'roo-code'

const ALL_PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'all',           label: 'All'          },
  { id: 'antigravity',   label: 'Antigravity'  },
  { id: 'claude',        label: 'Claude'       },
  { id: 'cline',         label: 'Cline'        },
  { id: 'codebuff',      label: 'Codebuff'     },
  { id: 'codex',         label: 'Codex'        },
  { id: 'copilot',       label: 'Copilot'      },
  { id: 'crush',         label: 'Crush'        },
  { id: 'cursor',        label: 'Cursor'       },
  { id: 'cursor-agent',  label: 'Cursor Agent' },
  { id: 'droid',         label: 'Droid'        },
  { id: 'gemini',        label: 'Gemini'       },
  { id: 'goose',         label: 'Goose'        },
  { id: 'ibm-bob',       label: 'IBM Bob'      },
  { id: 'kimi',          label: 'Kimi'         },
  { id: 'kilo-code',     label: 'KiloCode'     },
  { id: 'kiro',          label: 'Kiro'         },
  { id: 'mistral-vibe',  label: 'Mistral Vibe' },
  { id: 'omp',           label: 'OMP'          },
  { id: 'openclaw',      label: 'OpenClaw'     },
  { id: 'opencode',      label: 'OpenCode'     },
  { id: 'pi',            label: 'Pi'           },
  { id: 'qwen',          label: 'Qwen'         },
  { id: 'roo-code',      label: 'Roo Code'     },
]

type Props = Readonly<{
  selected: Provider
  onSelect: (p: Provider) => void
  payload: MenubarPayload
  currency: CurrencyState
}>

export function AgentTabStrip({ selected, onSelect, payload, currency }: Props) {
  const detected = payload.current.providers
  const visible = ALL_PROVIDERS.filter(
    p => p.id === 'all' || p.id in detected,
  )

  if (visible.length <= 1) return null

  return (
    <nav className="agent-tabs">
      {visible.map(p => {
        const cost = p.id === 'all' ? 0 : (detected[p.id] ?? 0)
        return (
          <button
            key={p.id}
            className={`tab ${selected === p.id ? 'tab-active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="tab-label">{p.label}</span>
            {cost > 0 && (
              <span className="tab-cost">{formatCompactCurrency(cost, currency)}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
