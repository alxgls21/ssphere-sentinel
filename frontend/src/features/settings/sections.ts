import type { SessionCapabilities } from '@/api/auth'

/**
 * The sections of Settings, and who is offered each. What an account may do is the server's to say
 * (`capabilities` of the session): a section is shown only when it has something for this account,
 * and a page still checks for itself, because a link can be followed by anyone.
 */
export type SectionId =
  | 'notifications'
  | 'account'
  | 'alert-rules'
  | 'customers'
  | 'targets'
  | 'devices'
  | 'users'
  | 'audit-log'
  | 'system'

export interface Section {
  id: SectionId
  label: string
  path: string
  /** One line for the section's own header. */
  description: string
  offered: (capabilities: SessionCapabilities) => boolean
}

export const SECTIONS: readonly Section[] = [
  {
    id: 'notifications',
    label: 'Notifications',
    path: '/settings/notifications',
    description: 'When Sentinel emails you about incidents, and a test email to check that it can.',
    offered: (capabilities) => capabilities.manageOwnNotifications,
  },
  {
    id: 'account',
    label: 'Account',
    path: '/settings/account',
    description: 'Your own password.',
    offered: (capabilities) => capabilities.manageOwnAccount,
  },
  {
    id: 'alert-rules',
    label: 'Alert rules',
    path: '/settings/alert-rules',
    description:
      'What opens an incident: the condition, how long it must hold, and for which customers and sites.',
    offered: (capabilities) => capabilities.viewAlertRules || capabilities.createAlertRules,
  },
  {
    id: 'customers',
    label: 'Customers & sites',
    path: '/settings/customers',
    description:
      'The customers and their sites: what every monitored thing belongs to, and who sees it.',
    offered: (capabilities) => capabilities.manageCustomers,
  },
  {
    id: 'targets',
    label: 'Network targets',
    path: '/settings/targets',
    description:
      'The ICMP and TCP targets the agents probe, and the entry each needs in an agent’s targets file.',
    offered: (capabilities) => capabilities.manageTargets,
  },
  {
    id: 'devices',
    label: 'Devices',
    path: '/settings/devices',
    description: 'The devices of the inventory and how they are polled by SNMP.',
    offered: (capabilities) => capabilities.manageDevices,
  },
  {
    id: 'users',
    label: 'Users & access',
    path: '/settings/users',
    description:
      'The accounts, their roles, which customers and sites they see, their passwords and lockouts.',
    offered: (capabilities) => capabilities.manageUsers,
  },
  {
    id: 'audit-log',
    label: 'Audit log',
    path: '/settings/audit-log',
    description: 'Who changed what, and when. Read-only.',
    offered: (capabilities) => capabilities.viewAuditLog,
  },
  {
    id: 'system',
    label: 'System',
    path: '/settings/system',
    description:
      'The alert engine, the notifier, the email outbox and what the deployment sets. Read-only.',
    offered: (capabilities) => capabilities.viewSystemStatus,
  },
]

export const sectionOffered = (id: SectionId, capabilities: SessionCapabilities): boolean =>
  SECTIONS.find((section) => section.id === id)?.offered(capabilities) ?? false

/** Where /settings goes: the first section this account is offered, or notifications. */
export function defaultSection(capabilities: SessionCapabilities): Section {
  return (SECTIONS.find((section) => section.offered(capabilities)) ?? SECTIONS[0]) as Section
}

/** The page of one rule, or the form for a new one. A path segment, so the id is encoded. */
export const rulePath = (id: string): string => `/settings/alert-rules/${encodeURIComponent(id)}`
export const NEW_RULE_PATH = '/settings/alert-rules/new'

/** The pages of the administration: one record, or the form for a new one. Ids are path segments, encoded. */
export const customerPath = (id: string): string => `/settings/customers/${encodeURIComponent(id)}`
export const NEW_CUSTOMER_PATH = '/settings/customers/new'
export const sitePath = (id: string): string => `/settings/sites/${encodeURIComponent(id)}`
export const NEW_SITE_PATH = '/settings/sites/new'
export const targetEditorPath = (id: string): string =>
  `/settings/targets/${encodeURIComponent(id)}`
export const NEW_TARGET_PATH = '/settings/targets/new'
export const deviceEditorPath = (id: string): string =>
  `/settings/devices/${encodeURIComponent(id)}`
export const NEW_DEVICE_PATH = '/settings/devices/new'
export const userPath = (id: number): string => `/settings/users/${id}`
export const NEW_USER_PATH = '/settings/users/new'

/** The monitoring pages of a target and of a device, where what the agents measure is shown. */
export const networkTargetPath = (id: string): string => `/network/${encodeURIComponent(id)}`
export const snmpDevicePath = (id: string): string => `/snmp/${encodeURIComponent(id)}`
