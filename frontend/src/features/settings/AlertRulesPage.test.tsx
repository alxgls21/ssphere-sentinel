import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AlertRule, AlertRuleList, AlertRuleListOptions, AlertRuleOptions } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import AlertRulesPage from './AlertRulesPage'
import { can, CHANGE_EFFECTS, iso, options, rule, ruleList } from './testing'

/** jsdom has no viewport: every media query answers the same, so a test picks "desktop" or "phone". */
function stubViewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}
const realMatchMedia = window.matchMedia
beforeEach(() => stubViewport(true))
afterEach(() => {
  window.matchMedia = realMatchMedia
})

const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

const RULES: AlertRule[] = [
  rule({
    id: 'r-down',
    name: 'Device unreachable',
    key: 'device-unreachable',
    openIncidents: 2,
    version: 5,
  }),
  rule({
    id: 'r-disk',
    name: 'Server resources',
    kind: 'server',
    health: 'warning',
    reason: 'resources',
    severity: 'warning',
    openIncidents: 0,
    version: 2,
    scope: {
      type: 'site',
      customerId: 'c1',
      customerName: 'Meridian',
      siteId: 's1',
      siteName: 'Athens DC',
    },
  }),
  rule({
    id: 'r-off',
    name: 'Container unhealthy',
    kind: 'container',
    reason: null,
    enabled: false,
    openIncidents: 0,
    canEdit: true,
    version: 1,
  }),
  rule({ id: 'r-locked', name: 'Probe failing', kind: 'target', canEdit: false, version: 9 }),
]

interface Served {
  list?: AlertRuleList | Error | ((request: AlertRuleListOptions | undefined) => AlertRuleList)
  options?: AlertRuleOptions | Error
}

function setup(
  capabilities = can('viewAlertRules', 'editAlertRules', 'createAlertRules'),
  served: Served = {},
  route = '/settings/alert-rules',
) {
  const listAlertRules = vi.fn<SentinelApi['listAlertRules']>(async (request) => {
    const answer = served.list ?? ruleList(RULES)
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(request) : answer
  })
  const getAlertRuleOptions = vi.fn<SentinelApi['getAlertRuleOptions']>(async () => {
    const answer = served.options ?? options()
    if (answer instanceof Error) throw answer
    return answer
  })
  const updateAlertRule = vi.fn<SentinelApi['updateAlertRule']>(async (id, patch) => ({
    generatedAt: iso(0),
    item: rule({ id, enabled: patch.enabled ?? true, version: patch.version + 1 }),
    effects: { openIncidents: 0, closes: [], closesAll: false },
  }))
  const api = createTestApi({
    source: 'http',
    listAlertRules,
    getAlertRuleOptions,
    updateAlertRule,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/alert-rules" element={<AlertRulesPage />} />
        <Route path="/settings/alert-rules/:id" element={<p>rule page</p>} />
        <Route path="/settings/alert-rules/new" element={<p>new rule page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { api, listAlertRules, getAlertRuleOptions, updateAlertRule }
}

const where = () => screen.getByTestId('where').textContent
const table = () => screen.findByRole('table', { name: 'Alert rules' })
const rowOf = (name: string) =>
  within(screen.getByRole('table', { name: 'Alert rules' }))
    .getByRole('link', { name: new RegExp(name) })
    .closest('tr') as HTMLElement
const lastRequest = (served: ReturnType<typeof setup>) =>
  served.listAlertRules.mock.calls.at(-1)?.[0]
const toggleButton = (verb: 'Enable' | 'Disable', name: string) =>
  screen.getByRole('button', { name: `${verb} rule ${name}` })

describe('who may see the list', () => {
  it('says so, and asks the server for nothing, to an account without the permission', () => {
    const served = setup(can('manageOwnNotifications'))
    expect(screen.getByText('Not permitted to see alert rules')).toBeInTheDocument()
    expect(served.listAlertRules).not.toHaveBeenCalled()
    expect(served.getAlertRuleOptions).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'New rule' })).not.toBeInTheDocument()
  })

  it('offers an account that may only create a rule the form, and lists nothing', () => {
    const served = setup(can('createAlertRules'))
    expect(screen.getByText('The rules cannot be listed')).toBeInTheDocument()
    expect(served.listAlertRules).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'New rule' })).toHaveAttribute(
      'href',
      '/settings/alert-rules/new',
    )
  })

  it('shows the list to an account that may only view: no toggle, no New rule, no options asked for', async () => {
    const served = setup(can('viewAlertRules'))
    await table()
    expect(screen.queryByRole('button', { name: /^(Enable|Disable) rule/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New rule' })).not.toBeInTheDocument()
    expect(served.getAlertRuleOptions).not.toHaveBeenCalled()
  })

  it('offers the toggle only for a rule the account and the rule both allow changing', async () => {
    setup(can('viewAlertRules', 'editAlertRules'))
    await table()
    expect(toggleButton('Disable', 'Device unreachable')).toBeInTheDocument()
    expect(toggleButton('Enable', 'Container unhealthy')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rule Probe failing/ })).not.toBeInTheDocument()
  })

  it('offers no toggle for any rule when the account may not edit, whatever a rule says', async () => {
    setup(can('viewAlertRules'))
    await table()
    expect(screen.queryAllByRole('button', { name: /^(Enable|Disable) rule/ })).toHaveLength(0)
  })

  it('offers New rule to an account that may create', async () => {
    setup(can('viewAlertRules', 'createAlertRules'))
    await table()
    await userEvent.click(screen.getByRole('link', { name: 'New rule' }))
    expect(where()).toBe('/settings/alert-rules/new')
  })

  it('says the server refused, with no Retry, when it answers 403 whatever the session said', async () => {
    setup(can('viewAlertRules'), { list: new ApiError('Forbidden.', 403, 'forbidden') })
    expect(await screen.findByText('Not permitted to see alert rules')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})

describe('the list', () => {
  it('lists the rules as the API ordered them, and says how many it shows of every rule', async () => {
    setup()
    const t = await table()
    const names = within(t)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('a')?.textContent)
    expect(names).toEqual([
      'Device unreachabledefault',
      'Server resources',
      'Container unhealthy',
      'Probe failing',
    ])
    expect(screen.getByText('4 of 4 shown')).toBeInTheDocument()
  })

  it('says each rule’s state by word, the rule Sentinel installed as default, and the open incidents', async () => {
    setup()
    await table()
    const down = rowOf('Device unreachable')
    expect(within(down).getByText('ENABLED')).toBeInTheDocument()
    expect(within(down).getByText('default')).toHaveAttribute(
      'title',
      'Installed by Sentinel: device-unreachable',
    )
    expect(within(down).getByText('CRIT')).toBeInTheDocument()
    expect(down).toHaveTextContent('Critical · no response to polls')
    expect(down).toHaveTextContent('1m 0s → 2m 0s')
    expect(down).toHaveTextContent('All customers and sites')
    expect(within(rowOf('Container unhealthy')).getByText('DISABLED')).toBeInTheDocument()
    expect(rowOf('Server resources')).toHaveTextContent('Meridian / Athens DC')
    expect(rowOf('Server resources')).toHaveTextContent('WARN')
  })

  it('links every name to its rule, and opens it from the row too', async () => {
    setup()
    await table()
    expect(within(rowOf('Server resources')).getByRole('link')).toHaveAttribute(
      'href',
      '/settings/alert-rules/r-disk',
    )
    await userEvent.click(within(rowOf('Server resources')).getByText('WARN'))
    expect(await screen.findByText('rule page')).toBeInTheDocument()
    expect(where()).toBe('/settings/alert-rules/r-disk')
  })

  it('asks for the first page of fifty, by name, with no filter', async () => {
    const served = setup()
    await table()
    expect(lastRequest(served)).toMatchObject({
      q: '',
      enabled: 'all',
      kind: 'all',
      severity: 'all',
      scope: 'all',
      sort: 'name',
      dir: 'asc',
      page: 1,
      pageSize: 50,
    })
  })

  it('reads a link someone shared: the filters in the URL are the request', async () => {
    const served = setup(
      undefined,
      {},
      '/settings/alert-rules?enabled=disabled&kind=device&sort=updated',
    )
    await table()
    expect(lastRequest(served)).toMatchObject({
      enabled: 'disabled',
      kind: 'device',
      sort: 'updated',
      dir: 'desc',
    })
  })

  it('counts the state chips from the API’s own counts', async () => {
    setup(undefined, { list: ruleList(RULES, { counts: { enabled: 7, disabled: 3 } }) })
    await table()
    const chips = within(screen.getByRole('group', { name: 'Filter by state' }))
    expect(chips.getByRole('button', { name: /^ALL/ })).toHaveTextContent('10')
    expect(chips.getByRole('button', { name: /^ENABLED/ })).toHaveTextContent('7')
    expect(chips.getByRole('button', { name: /^DISABLED/ })).toHaveTextContent('3')
  })

  it('says it is loading, then shows the rules', async () => {
    setup()
    expect(screen.getByText('Loading Rules')).toBeInTheDocument()
    await table()
  })

  it('says a failed read, with Retry that reads again', async () => {
    const served = setup(undefined, {
      list: new ApiError('The database is down.', 503, 'unavailable'),
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('The database is down.')
    served.listAlertRules.mockResolvedValueOnce(ruleList(RULES))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await table()
    expect(served.listAlertRules.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('says there is no rule at all, and that no incident can open', async () => {
    setup(undefined, { list: ruleList([]) })
    expect(await screen.findByText('No alert rules')).toBeInTheDocument()
    expect(screen.getByText(/no incident can open/)).toBeInTheDocument()
  })

  it('says nothing matches, and Clear filters puts the list back', async () => {
    const user = userEvent.setup()
    setup(
      undefined,
      {
        list: (request) =>
          request?.kind === 'device'
            ? ruleList([], { scopeTotal: 4, counts: { enabled: 0, disabled: 0 } })
            : ruleList(RULES),
      },
      '/settings/alert-rules?kind=device',
    )
    expect(await screen.findByText('No rule matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    await table()
    expect(where()).toBe('/settings/alert-rules')
  })
})

describe('search, filters, sort and pages', () => {
  it('searches after the typing settles, and holds the search in the URL', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.type(screen.getByRole('searchbox', { name: 'Search alert rules' }), 'athens')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ q: 'athens', page: 1 }))
    expect(where()).toBe('/settings/alert-rules?q=athens')
    expect(
      served.listAlertRules.mock.calls.filter(([request]) => request?.q === 'athens'),
    ).toHaveLength(1)
  })

  it('filters by severity with a chip, and by state', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    const severity = within(screen.getByRole('group', { name: 'Filter by severity' }))
    await user.click(severity.getByRole('button', { name: 'CRIT' }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ severity: 'critical' }))
    expect(where()).toBe('/settings/alert-rules?severity=critical')
    await user.click(
      within(screen.getByRole('group', { name: 'Filter by state' })).getByRole('button', {
        name: /^DISABLED/,
      }),
    )
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ enabled: 'disabled' }))
  })

  it('filters by kind and by scope from the selects', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.selectOptions(screen.getByLabelText('Kind'), 'device')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ kind: 'device' }))
    await user.selectOptions(screen.getByLabelText('Scope'), 'site')
    await waitFor(() =>
      expect(lastRequest(served)).toMatchObject({ kind: 'device', scope: 'site' }),
    )
    expect(where()).toBe('/settings/alert-rules?kind=device&scope=site')
  })

  it('sorts by a column, and turns the order round on a second click', async () => {
    const user = userEvent.setup()
    const served = setup()
    const t = await table()
    await user.click(within(t).getByRole('button', { name: /^SEVERITY/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'severity', dir: 'asc' }))
    await user.click(
      within(screen.getByRole('table', { name: 'Alert rules' })).getByRole('button', {
        name: /^SEVERITY/,
      }),
    )
    await waitFor(() =>
      expect(lastRequest(served)).toMatchObject({ sort: 'severity', dir: 'desc' }),
    )
    expect(
      within(screen.getByRole('table', { name: 'Alert rules' })).getByRole('columnheader', {
        name: /SEVERITY/,
      }),
    ).toHaveAttribute('aria-sort', 'descending')
  })

  it('pages: a second page is asked for by number, and the pager says where it is', async () => {
    const user = userEvent.setup()
    const served = setup(undefined, {
      list: (request) =>
        ruleList(RULES, {
          page: { number: request?.page ?? 1, size: 50, total: 120, pages: 3 },
          scopeTotal: 120,
        }),
    })
    await screen.findByRole('navigation', { name: 'Pages' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ page: 2 }))
    expect(where()).toBe('/settings/alert-rules?page=2')
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Pages' })).toHaveTextContent('page 2 of 3'),
    )
  })

  it('shows no pager for a single page', async () => {
    setup()
    await table()
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument()
  })

  it('goes back to the last page when the one asked for is past the end', async () => {
    setup(
      undefined,
      {
        list: (request) =>
          ruleList(RULES, {
            page: { number: request?.page ?? 1, size: 50, total: 60, pages: 2 },
            scopeTotal: 60,
          }),
      },
      '/settings/alert-rules?page=9',
    )
    await waitFor(() => expect(where()).toBe('/settings/alert-rules?page=2'))
  })
})

describe('on a phone', () => {
  beforeEach(() => stubViewport(false))

  it('lists the same rules as cards, each a link, with no table', async () => {
    setup()
    const list = await screen.findByRole('list', { name: 'Alert rules' })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(within(list).getByRole('link', { name: /Server resources/ })).toHaveAttribute(
      'href',
      '/settings/alert-rules/r-disk',
    )
    expect(list).toHaveTextContent('delays 1m 0s → 2m 0s')
  })

  it('offers the toggle outside the link, only where it may be used', async () => {
    setup()
    const list = await screen.findByRole('list', { name: 'Alert rules' })
    const toggle = within(list).getByRole('button', { name: 'Disable rule Device unreachable' })
    expect(toggle.closest('a')).toBeNull()
    expect(
      within(list).queryByRole('button', { name: /rule Probe failing/ }),
    ).not.toBeInTheDocument()
  })

  it('offers the sort as a select, since there are no column heads', async () => {
    const user = userEvent.setup()
    const served = setup()
    await screen.findByRole('list', { name: 'Alert rules' })
    await user.selectOptions(screen.getByLabelText('Sort by'), 'updated')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'updated', dir: 'desc' }))
  })
})

describe('switching a rule on or off', () => {
  it('enables a disabled rule at once, with the version that was read', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.click(toggleButton('Enable', 'Container unhealthy'))
    await waitFor(() =>
      expect(served.updateAlertRule).toHaveBeenCalledWith('r-off', { enabled: true, version: 1 }),
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await screen.findByText(/“Container unhealthy” is enabled\./)).toBeInTheDocument()
    expect(shell.announce).toHaveBeenCalledWith(expect.stringMatching(/is enabled/))
  })

  it('disables a rule with no open incident at once: nothing would end', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.click(toggleButton('Disable', 'Server resources'))
    await waitFor(() =>
      expect(served.updateAlertRule).toHaveBeenCalledWith('r-disk', { enabled: false, version: 2 }),
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('warns, and changes nothing, before disabling a rule that has open incidents', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.click(toggleButton('Disable', 'Device unreachable'))
    const warning = await screen.findByRole('alertdialog')
    expect(warning).toHaveTextContent('ENDS INCIDENTS')
    expect(warning).toHaveTextContent('This change to “Device unreachable” ends open incidents.')
    expect(warning).toHaveTextContent('Disabling the rule ends its 2 open incidents, all of them')
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('puts the focus on the safe button, and Cancel changes nothing', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.click(toggleButton('Disable', 'Device unreachable'))
    const warning = await screen.findByRole('alertdialog')
    expect(within(warning).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(warning).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('cancels with Escape', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    await user.click(toggleButton('Disable', 'Device unreachable'))
    await screen.findByRole('alertdialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('disables only when the warning is confirmed, and says what the API says it does', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.updateAlertRule.mockResolvedValueOnce({
      generatedAt: iso(0),
      item: rule({ id: 'r-down', enabled: false, version: 6 }),
      effects: { openIncidents: 2, closes: ['rule_disabled'], closesAll: true },
    })
    await table()
    await user.click(toggleButton('Disable', 'Device unreachable'))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Disable and end incidents',
      }),
    )
    await waitFor(() =>
      expect(served.updateAlertRule).toHaveBeenCalledWith('r-down', { enabled: false, version: 5 }),
    )
    const saved = await screen.findByText(/“Device unreachable” is disabled\./)
    expect(saved).toHaveTextContent('the rule’s incidents end, as it is disabled (2 open incidents')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('follows the API’s contract, not its own idea: where it says disabling ends nothing, there is no warning', async () => {
    const user = userEvent.setup()
    const served = setup(undefined, { options: options({ changeEffects: {} }) })
    await table()
    await waitFor(() => expect(served.getAlertRuleOptions).toHaveBeenCalled())
    await user.click(toggleButton('Disable', 'Device unreachable'))
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('warns from what it has known since the first release until the contract arrives, never unwarned', async () => {
    const user = userEvent.setup()
    const served = setup(undefined, { options: new ApiError('Busy.', 503, 'unavailable') })
    await table()
    await waitFor(() => expect(served.getAlertRuleOptions).toHaveBeenCalled())
    await user.click(toggleButton('Disable', 'Device unreachable'))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('reads the contract once, and only for an account that may change rules', async () => {
    const served = setup()
    await table()
    await waitFor(() => expect(served.getAlertRuleOptions).toHaveBeenCalledTimes(1))
    expect(CHANGE_EFFECTS.enabled?.closes).toBe('rule_disabled')
  })

  it('says the rule changed elsewhere, never overwrites, and reads the list again', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.updateAlertRule.mockRejectedValueOnce(
      new ApiError('The rule changed.', 409, 'version_conflict'),
    )
    await table()
    const before = served.listAlertRules.mock.calls.length
    await user.click(toggleButton('Enable', 'Container unhealthy'))
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('CHANGED ELSEWHERE')
    expect(notice).toHaveTextContent(
      /was changed elsewhere since this list was read, so nothing was changed/,
    )
    expect(served.updateAlertRule).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(served.listAlertRules.mock.calls.length).toBeGreaterThan(before))
  })

  it('says a refused change is refused, and another failure in the server’s own words', async () => {
    const user = userEvent.setup()
    const served = setup()
    await table()
    served.updateAlertRule.mockRejectedValueOnce(new ApiError('Forbidden.', 403, 'forbidden'))
    await user.click(toggleButton('Enable', 'Container unhealthy'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account may not make this change.',
    )
    served.updateAlertRule.mockRejectedValueOnce(
      new ApiError('The queue is full.', 500, 'internal'),
    )
    await user.click(await screen.findByRole('button', { name: 'Enable rule Container unhealthy' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The queue is full.'))
    expect(shell.announce).toHaveBeenCalledWith('The alert rule was not changed.')
  })

  it('lets the notice be dismissed', async () => {
    const user = userEvent.setup()
    setup()
    await table()
    await user.click(toggleButton('Enable', 'Container unhealthy'))
    await screen.findByText(/is enabled\./)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/is enabled\./)).not.toBeInTheDocument()
  })

  it('disables that rule’s button while its change is in flight', async () => {
    const user = userEvent.setup()
    const served = setup()
    let finish: () => void = () => {}
    served.updateAlertRule.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () =>
          resolve({
            generatedAt: iso(0),
            item: rule({ id: 'r-off', version: 2 }),
            effects: { openIncidents: 0, closes: [], closesAll: false },
          })
      }),
    )
    await table()
    await user.click(toggleButton('Enable', 'Container unhealthy'))
    expect(toggleButton('Enable', 'Container unhealthy')).toBeDisabled()
    expect(toggleButton('Disable', 'Server resources')).toBeEnabled()
    finish()
    await screen.findByText(/is enabled\./)
  })
})
