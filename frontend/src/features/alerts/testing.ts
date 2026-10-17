import type {
  EngineState,
  EngineStatus,
  IncidentDetail,
  IncidentItem,
  IncidentList,
  IncidentOverview,
  IncidentStatus,
  IncidentStep,
} from '@/api/types'

/** Test fixtures only: incidents, their lists, details and the engine, at one fixed moment. */
export const NOW = Date.parse('2026-10-18T10:00:00Z')
export const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

interface ItemOptions {
  id?: string
  status?: IncidentStatus
  severity?: IncidentItem['severity']
  kind?: IncidentItem['entity']['kind']
  ref?: string
  label?: string
  rule?: string
  reason?: string | null
  health?: IncidentItem['condition']['health']
  canAcknowledge?: boolean
  site?: boolean
  closeReason?: IncidentItem['closeReason']
  acknowledgedBy?: string | null
  openedSecondsAgo?: number
}

/** One incident, with the times its status implies. The permission follows the status unless a test says. */
export function incident({
  id = 'inc-1',
  status = 'active',
  severity = 'critical',
  kind = 'device',
  ref = 'dev-1',
  label = 'ath-core-sw',
  rule = 'Device unreachable',
  reason = 'unreachable',
  health = 'critical',
  canAcknowledge = status === 'active',
  site = true,
  closeReason = status === 'closed' ? 'entity_removed' : null,
  acknowledgedBy = status === 'acknowledged' ? 'maria' : null,
  openedSecondsAgo = 600,
}: ItemOptions = {}): IncidentItem {
  const acknowledged = status === 'acknowledged'
  return {
    id,
    status,
    severity,
    condition: { health, reason },
    entity: { kind, ref, label },
    rule: { id: 'rule-1', name: rule },
    siteId: site ? 'site-ath' : null,
    ...(site ? { customerName: 'Meridian', siteName: 'Athens DC' } : {}),
    startedAt: iso(openedSecondsAgo + 120),
    openedAt: iso(openedSecondsAgo),
    acknowledgedAt: acknowledged ? iso(openedSecondsAgo - 60) : null,
    acknowledgedBy: acknowledged ? acknowledgedBy : null,
    recoveredAt: status === 'recovered' ? iso(60) : null,
    closedAt: status === 'recovered' || status === 'closed' ? iso(30) : null,
    closeReason,
    canAcknowledge,
  }
}

export function list(items: IncidentItem[], over: Partial<IncidentList> = {}): IncidentList {
  const counts = { active: 0, acknowledged: 0, recovered: 0, closed: 0 }
  for (const item of items) counts[item.status] += 1
  return {
    generatedAt: new Date(NOW).toISOString(),
    items,
    page: { number: 1, size: 50, total: items.length, pages: 1 },
    counts,
    scopeTotal: items.length,
    ...over,
  }
}

const step = (
  kind: IncidentStep['kind'],
  secondsAgo: number,
  over: Partial<IncidentStep> = {},
) => ({
  at: iso(secondsAgo),
  kind,
  health: null,
  reason: null,
  actor: null,
  ...over,
})

/** The steps an incident of that status has recorded. */
export function stepsOf(item: IncidentItem): IncidentStep[] {
  const opened = Math.round((NOW - Date.parse(item.openedAt)) / 1000)
  const steps: IncidentStep[] = [
    step('opened', opened, { health: item.condition.health, reason: item.condition.reason }),
  ]
  if (item.acknowledgedAt) {
    steps.push(step('acknowledged', opened - 60, { actor: item.acknowledgedBy }))
  }
  if (item.status === 'recovered') {
    steps.push(step('recovery_started', 90, { health: 'healthy', reason: 'ok' }))
    steps.push(step('recovered', 60, { health: 'healthy', reason: 'ok' }))
  }
  if (item.status === 'closed') steps.push(step('closed', 30))
  return steps
}

export function detail(
  item: IncidentItem = incident(),
  over: Partial<Omit<IncidentDetail, 'item'>> = {},
): IncidentDetail {
  return {
    generatedAt: new Date(NOW).toISOString(),
    item,
    rule: {
      id: item.rule.id,
      name: item.rule.name,
      description: 'Opens when a polled device stops answering for a minute.',
      enabled: true,
    },
    entityVisible: true,
    timeline: stepsOf(item),
    ...over,
  }
}

export function engine(
  state: EngineState = 'running',
  over: Partial<EngineStatus> = {},
): EngineStatus {
  const base: EngineStatus = {
    generatedAt: new Date(NOW).toISOString(),
    state,
    stale: state === 'stale' || state === 'never_started',
    staleAfterSeconds: 180,
    intervalSeconds: 60,
    startedAt: iso(86_400),
    lastSuccessAt: iso(12),
    lastAttemptAt: iso(12),
    lastCycleMs: 140,
    lastError: null,
    monitoringSince: iso(86_000),
  }
  switch (state) {
    case 'running':
      return { ...base, ...over }
    case 'failed':
      return {
        ...base,
        lastError: { at: iso(20), category: 'database' },
        lastAttemptAt: iso(20),
        lastSuccessAt: iso(500),
        ...over,
      }
    case 'stale':
      return { ...base, lastSuccessAt: iso(900), lastAttemptAt: iso(900), ...over }
    case 'never_started':
      return {
        ...base,
        intervalSeconds: null,
        startedAt: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastCycleMs: null,
        monitoringSince: null,
        ...over,
      }
  }
}

export function overview(over: Partial<IncidentOverview> = {}): IncidentOverview {
  const recent = [
    incident({ id: 'inc-1', label: 'pir-core', severity: 'critical' }),
    incident({
      id: 'inc-2',
      label: 'cdn-edge',
      severity: 'critical',
      status: 'acknowledged',
      kind: 'target',
      ref: 'tgt-1',
      rule: 'Probe failing',
      reason: 'failing',
    }),
    incident({
      id: 'inc-3',
      label: 'api-02',
      severity: 'warning',
      kind: 'server',
      ref: 'srv-1',
      rule: 'Server resources',
      reason: 'resources',
      health: 'warning',
    }),
  ]
  return {
    generatedAt: new Date(NOW).toISOString(),
    open: 7,
    active: 5,
    acknowledged: 2,
    critical: 3,
    recent,
    ...over,
  }
}
