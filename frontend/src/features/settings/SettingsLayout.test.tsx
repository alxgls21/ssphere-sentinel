import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { createFakeAuth, renderApp } from '@/test/render'
import SettingsLayout from './SettingsLayout'
import { can } from './testing'

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

function page(route: string, capabilities = can()) {
  return renderApp(
    <>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="notifications" element={<p>notifications section</p>} />
          <Route path="alert-rules/*" element={<p>alert rules section</p>} />
          <Route path="system" element={<p>system section</p>} />
        </Route>
      </Routes>
      <Where />
    </>,
    { route, auth: createFakeAuth({ capabilities }) },
  )
}

const sections = () => screen.getByRole('navigation', { name: 'Settings sections' })
const where = () => screen.getByTestId('where').textContent

describe('Settings', () => {
  it('is headed Settings, with the section under its links', () => {
    page('/settings/notifications', can('manageOwnNotifications'))
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText('notifications section')).toBeInTheDocument()
  })

  it('links the three sections to an account that is offered all of them, and no General', () => {
    page(
      '/settings/notifications',
      can('manageOwnNotifications', 'viewAlertRules', 'viewSystemStatus'),
    )
    expect(
      within(sections())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Notifications', 'Alert rules', 'System'])
    expect(screen.queryByRole('link', { name: 'General' })).not.toBeInTheDocument()
  })

  it('links only what the account is offered', () => {
    page('/settings/notifications', can('manageOwnNotifications'))
    expect(
      within(sections())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Notifications'])
  })

  it('offers Alert rules to an account that may create rules but not view them', () => {
    page('/settings/notifications', can('createAlertRules'))
    expect(within(sections()).getByRole('link', { name: 'Alert rules' })).toBeInTheDocument()
  })

  it('marks the current section, and a page inside it, for a screen reader', () => {
    page('/settings/alert-rules/abc', can('manageOwnNotifications', 'viewAlertRules'))
    expect(within(sections()).getByRole('link', { name: 'Alert rules' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(sections()).getByRole('link', { name: 'Notifications' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('says there is nothing to offer an account with no permission, with no links', () => {
    page('/settings/notifications', can())
    expect(screen.getByText('No settings for this account')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument()
  })

  it('goes from /settings to the first section the account is offered', () => {
    page('/settings', can('viewAlertRules', 'viewSystemStatus'))
    expect(where()).toBe('/settings/alert-rules')
    expect(screen.getByText('alert rules section')).toBeInTheDocument()
  })

  it('goes from /settings/ (a trailing slash) the same way', () => {
    page('/settings/', can('viewSystemStatus'))
    expect(where()).toBe('/settings/system')
  })

  it('goes to Notifications when nothing is offered, where the page says so itself', () => {
    page('/settings', can())
    expect(where()).toBe('/settings/notifications')
  })

  it('keeps the view’s scope and range when a section is opened', async () => {
    page(
      '/settings/notifications?customer=acme&range=6h',
      can('manageOwnNotifications', 'viewSystemStatus'),
    )
    await userEvent.click(within(sections()).getByRole('link', { name: 'System' }))
    const url = new URL(where() ?? '', 'http://x')
    expect(url.pathname).toBe('/settings/system')
    expect(Object.fromEntries(url.searchParams)).toEqual({ customer: 'acme', range: '6h' })
  })

  it('moves between the links with the keyboard: they are links, in order', async () => {
    const user = userEvent.setup()
    page('/settings/notifications', can('manageOwnNotifications', 'viewAlertRules'))
    await user.tab()
    expect(within(sections()).getByRole('link', { name: 'Notifications' })).toHaveFocus()
    await user.tab()
    expect(within(sections()).getByRole('link', { name: 'Alert rules' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(where()).toBe('/settings/alert-rules')
  })
})
