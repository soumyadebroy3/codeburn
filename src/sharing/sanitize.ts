import type { MenubarPayload } from '../menubar-json.js'

// The fork's menubar payload is aggregate-only: cost/token/call totals plus
// fixed category labels, vendor model names, and provider names — none of which
// identify what you are working on. Unlike upstream's payload it carries no
// topProjects / topSessions / history.timeline.sessionSeries, so there is
// structurally nothing project- or session-identifying to strip today.
//
// This function is nonetheless the single ENFORCED egress boundary for usage
// leaving the device. It is applied sender-side before transmit AND again on
// receipt (an older/newer peer is not trusted to have stripped its own data).
// It defensively neutralizes the upstream identifying shapes should they ever
// be ported into the fork payload, so introducing one of those fields can never
// silently start leaking it off the machine. On today's payload it is a no-op.
type Identifying = MenubarPayload & {
  current: MenubarPayload['current'] & { topProjects?: unknown; topSessions?: unknown }
  history: MenubarPayload['history'] & {
    timeline?: { sessionSeries?: unknown; points?: Array<{ sessions?: unknown }> } & Record<string, unknown>
  }
}

export function sanitizeForSharing(payload: MenubarPayload): MenubarPayload {
  const p = payload as Identifying
  const current: Identifying['current'] = { ...p.current }
  // Only touch fields that are actually present, so this stays a clean no-op on
  // the fork payload and a real scrub if the identifying shapes are ever ported.
  if ('topProjects' in current) current.topProjects = []
  if ('topSessions' in current) current.topSessions = []

  const timeline = p.history?.timeline
  const history: Identifying['history'] = {
    ...p.history,
    ...(timeline
      ? {
          timeline: {
            ...timeline,
            sessionSeries: [],
            points: (timeline.points ?? []).map((pt) => ({ ...pt, sessions: [] })),
          },
        }
      : {}),
  }

  return { ...p, current, history }
}
