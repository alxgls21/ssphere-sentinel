import type {
  Account,
  AccountDetail,
  AccountList,
  AgentOption,
  AgentOptionList,
  AuditEntry,
  AuditLog,
  CustomerDetail,
  CustomerList,
  CustomerRecord,
  DeliveryItem,
  DeliveryList,
  DomainDetail,
  DomainList,
  DomainRecord,
  DomainVerification,
  InventoryDevice,
  InventoryDeviceDetail,
  InventoryDeviceList,
  PreferenceChange,
  ScopeOptions,
  SiteDetail,
  SiteList,
  SiteRecord,
  UserNotifications,
  VerificationAnswer,
} from '@/api/types'

/** Test fixtures only: the records the administration pages show, at one fixed moment. */
export const NOW = Date.parse('2026-10-18T10:00:00Z')
export const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

export const SCOPE: ScopeOptions = {
  customers: [
    { id: 'c1', name: 'Meridian' },
    { id: 'c2', name: 'Globex' },
  ],
  sites: [
    { id: 's1', customerId: 'c1', name: 'Athens DC' },
    { id: 's2', customerId: 'c2', name: 'Plant' },
  ],
}

const page = (total: number) => ({ number: 1, size: 50, total, pages: 1 })

export function customer(over: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: 'c1',
    name: 'Meridian',
    notes: 'first customer',
    sites: 1,
    servers: 2,
    devices: 0,
    targets: 1,
    domains: 0,
    createdAt: iso(86_400 * 30),
    updatedAt: iso(3600),
    ...over,
  }
}

export function site(over: Partial<SiteRecord> = {}): SiteRecord {
  return {
    id: 's1',
    customerId: 'c1',
    customerName: 'Meridian',
    name: 'Athens DC',
    description: 'the data centre',
    servers: 2,
    devices: 0,
    targets: 1,
    createdAt: iso(86_400 * 30),
    updatedAt: iso(3600),
    ...over,
  }
}

export const customerList = (items: CustomerRecord[], scopeTotal = items.length): CustomerList => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
  scopeTotal,
})

export const siteList = (items: SiteRecord[]): SiteList => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
  scopeTotal: items.length,
})

export const customerDetail = (item: CustomerRecord, sites: SiteRecord[] = []): CustomerDetail => ({
  generatedAt: iso(0),
  item,
  sites,
})

export const siteDetail = (item: SiteRecord): SiteDetail => ({ generatedAt: iso(0), item })

export function account(over: Partial<Account> = {}): Account {
  return {
    id: 7,
    username: 'maria',
    firstName: 'Maria',
    lastName: 'Papadopoulou',
    displayName: 'Maria Papadopoulou',
    email: 'maria@example.com',
    role: 'viewer',
    allCustomers: false,
    active: true,
    lastLoginAt: iso(7200),
    createdAt: iso(86_400 * 60),
    locked: false,
    lockedUntil: null,
    failedSignIns: 0,
    maxFailedSignIns: 5,
    notifications: { enabled: false, minSeverity: null, receiving: false },
    self: false,
    customers: [{ id: 'c1', name: 'Meridian' }],
    sites: [],
    ...over,
  }
}

export const accountList = (items: Account[]): AccountList => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
  scopeTotal: items.length,
  counts: {
    active: items.filter((item) => item.active).length,
    inactive: items.filter((item) => !item.active).length,
    locked: items.filter((item) => item.locked).length,
    notified: items.filter((item) => item.notifications.enabled).length,
  },
})

export const accountDetail = (item: Account): AccountDetail => ({ generatedAt: iso(0), item })

export function agent(over: Partial<AgentOption> = {}): AgentOption {
  return {
    id: 'a1',
    name: 'ath-probe',
    enabled: true,
    status: 'online',
    lastSeenAt: iso(30),
    serverId: 'srv-1',
    serverName: 'ath-probe-01',
    ...over,
  }
}

export const agentList = (items: AgentOption[]): AgentOptionList => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
})

export function device(over: Partial<InventoryDevice> = {}): InventoryDevice {
  return {
    id: 'd1',
    name: 'core-sw',
    type: 'switch',
    address: 'core.example.net',
    enabled: true,
    description: '',
    siteId: 's1',
    customerName: 'Meridian',
    siteName: 'Athens DC',
    agentAssigned: true,
    agent: {
      id: 'a1',
      name: 'ath-probe',
      status: 'online',
      lastSeenAt: iso(30),
      serverId: 'srv-1',
      serverName: 'ath-probe-01',
    },
    snmp: { version: '3', port: 161, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 },
    hasHistory: false,
    createdAt: iso(86_400 * 30),
    updatedAt: iso(3600),
    ...over,
  }
}

export const deviceList = (items: InventoryDevice[]): InventoryDeviceList => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
  scopeTotal: items.length,
})

export const deviceDetail = (item: InventoryDevice): InventoryDeviceDetail => ({
  generatedAt: iso(0),
  item,
})

export function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 42,
    at: iso(600),
    actor: { id: 1, username: 'admin' },
    action: 'customer_changed',
    actionLabel: 'Customer changed',
    targetType: 'customer',
    targetTypeLabel: 'Customer',
    targetId: 'c1',
    targetName: 'Meridian',
    changes: { notes: { before: '', after: 'first customer' } },
    ...over,
  }
}

export const auditLog = (items: AuditEntry[], scopeTotal = items.length): AuditLog => ({
  generatedAt: iso(0),
  items,
  page: page(items.length),
  scopeTotal,
  actions: [
    { value: 'customer_changed', label: 'Customer changed' },
    { value: 'user_created', label: 'User created' },
  ],
  targetTypes: [
    { value: 'customer', label: 'Customer' },
    { value: 'user', label: 'User' },
  ],
})

/** A monitored domain, a pending one of Acme unless a test says otherwise. */
export function domain(over: Partial<DomainRecord> = {}): DomainRecord {
  return {
    id: 'd1',
    name: 'acme.example',
    displayName: 'acme.example',
    customer: { id: 'c1', name: 'Acme' },
    status: 'pending',
    verifiedAt: null,
    lastVerifiedAt: null,
    lastCheckedAt: null,
    lastOutcome: null,
    createdAt: iso(86400),
    createdBy: 'maria',
    version: 1,
    ...over,
  }
}

export const domainList = (items: DomainRecord[], scopeTotal = items.length): DomainList => ({
  generatedAt: iso(0),
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  scopeTotal,
  counts: {
    pending: items.filter((entry) => entry.status === 'pending').length,
    verified: items.filter((entry) => entry.status === 'verified').length,
    degraded: items.filter((entry) => entry.status === 'degraded').length,
    suspended: items.filter((entry) => entry.status === 'suspended').length,
  },
})

export function verification(over: Partial<DomainVerification> = {}): DomainVerification {
  return {
    id: 'v1',
    domainId: 'd1',
    status: 'pending',
    outcome: null,
    detail: null,
    requestedBy: 'maria',
    createdAt: iso(5),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    startedAt: null,
    finishedAt: null,
    evidence: null,
    ...over,
  }
}

export const verificationAnswer = (
  item: DomainVerification,
  state: VerificationAnswer['verifier']['state'] = 'running',
): VerificationAnswer => ({ generatedAt: iso(0), item, verifier: { state } })

export function domainDetail(
  item: DomainRecord,
  latest: DomainVerification | null = null,
): DomainDetail {
  return {
    generatedAt: iso(0),
    item,
    record: {
      type: 'TXT',
      name: `_ssphere-sentinel.${item.name}`,
      value: 'ssphere-verification=abc123',
    },
    latestVerification: latest,
  }
}

/** Another account's incident email preferences: off, with an address, able to receive, unless a test says otherwise. */
export function userNotifications(
  over: {
    enabled?: boolean
    minSeverity?: 'critical' | 'warning'
    sendRecovery?: boolean
    email?: string | null
    available?: boolean
    blockedBy?: UserNotifications['receivingBlockedBy']
    changedBy?: PreferenceChange | null
    active?: boolean
  } = {},
): UserNotifications {
  const enabled = over.enabled ?? false
  const blockedBy = over.blockedBy ?? null
  const email = over.email === undefined ? 'maria@example.com' : over.email
  return {
    generatedAt: iso(0),
    user: {
      id: 7,
      username: 'maria',
      displayName: 'Maria Papadopoulou',
      active: over.active ?? true,
    },
    preferences: {
      enabled,
      minSeverity: over.minSeverity ?? 'critical',
      sendRecovery: over.sendRecovery ?? false,
      updatedAt: over.changedBy ? over.changedBy.at : null,
      changedBy: over.changedBy ?? null,
    },
    account: { email },
    email: {
      available: over.available ?? true,
      deliverable: (over.available ?? true) && email !== null,
    },
    receiving: enabled && blockedBy === null,
    receivingBlockedBy: blockedBy,
  }
}

export function delivery(over: Partial<DeliveryItem> = {}): DeliveryItem {
  return {
    id: 1,
    kind: 'opened',
    status: 'sent',
    failure: null,
    recipient: { id: 7, username: 'maria' },
    incident: {
      id: 'i1',
      ruleName: 'Server resources',
      entityKind: 'server',
      entityLabel: 'ath-db-01',
      severity: 'critical',
    },
    attempts: 1,
    createdAt: iso(600),
    lastAttemptAt: iso(590),
    nextAttemptAt: null,
    sentAt: iso(590),
    ...over,
  }
}

export const deliveryList = (items: DeliveryItem[], scopeTotal = items.length): DeliveryList => ({
  generatedAt: iso(0),
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  scopeTotal,
  counts: {
    pending: items.filter((entry) => entry.status === 'pending').length,
    sending: items.filter((entry) => entry.status === 'sending').length,
    sent: items.filter((entry) => entry.status === 'sent').length,
    failed: items.filter((entry) => entry.status === 'failed').length,
    cancelled: items.filter((entry) => entry.status === 'cancelled').length,
  },
  retentionDays: 90,
})
