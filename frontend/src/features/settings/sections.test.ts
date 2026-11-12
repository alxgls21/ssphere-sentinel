import { describe, expect, it } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import { can } from './testing'
import {
  customerPath,
  defaultSection,
  deviceEditorPath,
  NEW_RULE_PATH,
  rulePath,
  SECTIONS,
  sectionOffered,
  sitePath,
  targetEditorPath,
  userPath,
} from './sections'

describe('the sections of Settings', () => {
  it('are, in order: Notifications, Account, Alert rules, Customers & sites, Network targets, Devices, Users & access, Audit log, System', () => {
    expect(SECTIONS.map((section) => section.label)).toEqual([
      'Notifications',
      'Account',
      'Alert rules',
      'Customers & sites',
      'Network targets',
      'Devices',
      'Users & access',
      'Audit log',
      'System',
    ])
    expect(SECTIONS.map((section) => section.path)).toEqual([
      '/settings/notifications',
      '/settings/account',
      '/settings/alert-rules',
      '/settings/customers',
      '/settings/targets',
      '/settings/devices',
      '/settings/users',
      '/settings/audit-log',
      '/settings/system',
    ])
  })

  it('offers nothing to an account with no capability', () => {
    for (const section of SECTIONS) expect(section.offered(NO_CAPABILITIES), section.id).toBe(false)
  })

  it('offers Notifications to an account that manages its own, and Account to one that manages its own account', () => {
    expect(sectionOffered('notifications', can('manageOwnNotifications'))).toBe(true)
    expect(sectionOffered('alert-rules', can('manageOwnNotifications'))).toBe(false)
    expect(sectionOffered('system', can('manageOwnNotifications'))).toBe(false)
    expect(sectionOffered('account', can('manageOwnAccount'))).toBe(true)
    expect(sectionOffered('account', can('manageOwnNotifications'))).toBe(false)
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

  it('offers each administration section only for its own capability', () => {
    expect(sectionOffered('customers', can('manageCustomers'))).toBe(true)
    expect(sectionOffered('targets', can('manageTargets'))).toBe(true)
    expect(sectionOffered('devices', can('manageDevices'))).toBe(true)
    expect(sectionOffered('users', can('manageUsers'))).toBe(true)
    expect(sectionOffered('audit-log', can('viewAuditLog'))).toBe(true)
    const editor = can('manageCustomers', 'manageTargets', 'manageDevices', 'manageServers')
    expect(sectionOffered('users', editor)).toBe(false)
    expect(sectionOffered('audit-log', editor)).toBe(false)
    expect(sectionOffered('customers', can('manageUsers'))).toBe(false)
  })

  it('opens the first section the account is offered, or Notifications when none', () => {
    expect(defaultSection(can('viewSystemStatus', 'viewAlertRules')).id).toBe('alert-rules')
    expect(defaultSection(can('viewSystemStatus')).id).toBe('system')
    expect(defaultSection(can('manageUsers', 'viewAuditLog')).id).toBe('users')
    expect(defaultSection(NO_CAPABILITIES).id).toBe('notifications')
  })

  it('encodes a rule id into its path, and keeps the form for a new rule apart', () => {
    expect(rulePath('a/b c')).toBe('/settings/alert-rules/a%2Fb%20c')
    expect(NEW_RULE_PATH).toBe('/settings/alert-rules/new')
  })

  it('encodes the ids of the administration pages', () => {
    expect(customerPath('c/1')).toBe('/settings/customers/c%2F1')
    expect(sitePath('s 1')).toBe('/settings/sites/s%201')
    expect(targetEditorPath('t?')).toBe('/settings/targets/t%3F')
    expect(deviceEditorPath('d#')).toBe('/settings/devices/d%23')
    expect(userPath(7)).toBe('/settings/users/7')
  })
})
