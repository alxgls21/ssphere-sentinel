import { describe, expect, it } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import { can } from './testing'
import { defaultSection, NEW_RULE_PATH, rulePath, SECTIONS, sectionOffered } from './sections'

describe('the sections of Settings', () => {
  it('are Notifications, Alert rules and System, and no General', () => {
    expect(SECTIONS.map((section) => section.label)).toEqual([
      'Notifications',
      'Alert rules',
      'System',
    ])
    expect(SECTIONS.map((section) => section.path)).toEqual([
      '/settings/notifications',
      '/settings/alert-rules',
      '/settings/system',
    ])
  })

  it('offers nothing to an account with no capability', () => {
    for (const section of SECTIONS) expect(section.offered(NO_CAPABILITIES), section.id).toBe(false)
  })

  it('offers Notifications to an account that manages its own', () => {
    expect(sectionOffered('notifications', can('manageOwnNotifications'))).toBe(true)
    expect(sectionOffered('alert-rules', can('manageOwnNotifications'))).toBe(false)
    expect(sectionOffered('system', can('manageOwnNotifications'))).toBe(false)
  })

  it('offers Alert rules to an account that may view or create them, not to one that may only edit', () => {
    expect(sectionOffered('alert-rules', can('viewAlertRules'))).toBe(true)
    expect(sectionOffered('alert-rules', can('createAlertRules'))).toBe(true)
    expect(sectionOffered('alert-rules', can('editAlertRules'))).toBe(false)
  })

  it('offers System only to an account that may see the system status', () => {
    expect(sectionOffered('system', can('viewSystemStatus'))).toBe(true)
    expect(sectionOffered('system', can('viewAlertRules', 'sendTestEmail'))).toBe(false)
  })

  it('opens the first section the account is offered, or Notifications when none', () => {
    expect(defaultSection(can('viewSystemStatus', 'viewAlertRules')).id).toBe('alert-rules')
    expect(defaultSection(can('viewSystemStatus')).id).toBe('system')
    expect(defaultSection(NO_CAPABILITIES).id).toBe('notifications')
  })

  it('encodes a rule id into its path, and keeps the form for a new rule apart', () => {
    expect(rulePath('a/b c')).toBe('/settings/alert-rules/a%2Fb%20c')
    expect(NEW_RULE_PATH).toBe('/settings/alert-rules/new')
  })
})
