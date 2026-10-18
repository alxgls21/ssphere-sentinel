import type { SessionCapabilities } from '@/api/auth'

/**
 * The three sections of Settings, and who is offered each. What an account may do is the server's
 * to say (`capabilities` of the session): a section is shown only when it has something for this
 * account, and a page still checks for itself, because a link can be followed by anyone.
 */
export type SectionId = 'notifications' | 'alert-rules' | 'system'

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
    id: 'alert-rules',
    label: 'Alert rules',
    path: '/settings/alert-rules',
    description:
      'What opens an incident: the condition, how long it must hold, and for which customers and sites.',
    offered: (capabilities) => capabilities.viewAlertRules || capabilities.createAlertRules,
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
