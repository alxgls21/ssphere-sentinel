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
  InventoryDevice,
  InventoryDeviceDetail,
  InventoryDeviceList,
  ScopeOptions,
  SiteDetail,
  SiteList,
  SiteRecord,
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
