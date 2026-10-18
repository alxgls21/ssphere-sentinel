import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AlertRule, AlertRuleDetail, ScopeOptions } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import RuleEditorPage from './RuleEditorPage'
import { can, CHANGE_EFFECTS, iso, options, rule } from './testing'

const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

const SCOPE: ScopeOptions = {
  customers: [
    { id: 'c1', name: 'Meridian' },
    { id: 'c2', name: 'Harbor' },
  ],
  sites: [
    { id: 's1', customerId: 'c1', name: 'Athens DC' },
    { id: 's2', customerId: 'c2', name: 'Piraeus' },
  ],
}

const detailOf = (item: AlertRule): AlertRuleDetail => ({
  generatedAt: iso(0),
  item,
  changeEffects: CHANGE_EFFECTS,
})

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

interface Served {
  rule?: AlertRule | Error
  options?: ReturnType<typeof options> | Error
}

function setup(
  route: string,
  capabilities = can('viewAlertRules', 'editAlertRules', 'createAlertRules'),
  served: Served = {},
) {
  const current = { rule: served.rule ?? rule({ id: 'r1', openIncidents: 0 }) }
  const getAlertRuleOptions = vi.fn<SentinelApi['getAlertRuleOptions']>(async () => {
    if (served.options instanceof Error) throw served.options
    return served.options ?? options()
  })
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const getAlertRule = vi.fn<SentinelApi['getAlertRule']>(async (id) => {
    if (current.rule instanceof Error) throw current.rule
    return detailOf({ ...current.rule, id })
  })
  const createAlertRule = vi.fn<SentinelApi['createAlertRule']>(async (input) => ({
    generatedAt: iso(0),
    item: rule({ id: 'new-1', name: input.name, version: 1, openIncidents: 0 }),
    changeEffects: CHANGE_EFFECTS,
  }))
  const updateAlertRule = vi.fn<SentinelApi['updateAlertRule']>(async (id, patch) => ({
    generatedAt: iso(0),
    item: {
      ...(current.rule instanceof Error ? rule() : current.rule),
      id,
      name: patch.name ?? (current.rule instanceof Error ? '' : current.rule.name),
      version: patch.version + 1,
    },
    effects: { openIncidents: 0, closes: [], closesAll: false },
  }))
  const api = createTestApi({
    source: 'http',
    getAlertRuleOptions,
    getScopeOptions,
    getAlertRule,
    createAlertRule,
    updateAlertRule,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/alert-rules/new" element={<RuleEditorPage />} />
        <Route path="/settings/alert-rules/:id" element={<RuleEditorPage />} />
        <Route path="/settings/alert-rules" element={<p>the list</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return {
    current,
    getAlertRuleOptions,
    getScopeOptions,
    getAlertRule,
    createAlertRule,
    updateAlertRule,
  }
}

const where = () => screen.getByTestId('where').textContent
const nameField = () => screen.findByLabelText('Name')
const field = (label: string) => screen.getByLabelText(label)
const choices = (label: string) =>
  within(field(label))
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value)
const save = () => screen.getByRole('button', { name: /^(Save changes|Create rule)$/ })

async function fillValid(user: ReturnType<typeof userEvent.setup>, name = 'Core down') {
  await user.clear(await nameField())
  await user.type(field('Name'), name)
}

describe('who may open it', () => {
  it('says so, and asks the server for nothing, when a new rule is not permitted', () => {
    const served = setup('/settings/alert-rules/new', can('viewAlertRules'))
    expect(screen.getByText('Not permitted to create alert rules')).toBeInTheDocument()
    expect(served.getAlertRuleOptions).not.toHaveBeenCalled()
    expect(served.getScopeOptions).not.toHaveBeenCalled()
  })

  it('says so, and asks the server for nothing, when a rule is not permitted to be seen', () => {
    const served = setup('/settings/alert-rules/r1', can('createAlertRules'))
    expect(screen.getByText('Not permitted to see alert rules')).toBeInTheDocument()
    expect(served.getAlertRule).not.toHaveBeenCalled()
    expect(served.getAlertRuleOptions).not.toHaveBeenCalled()
  })

  it('shows a rule to an account that may only view it, with every field locked and no Save', async () => {
    setup('/settings/alert-rules/r1', can('viewAlertRules'))
    expect(await nameField()).toBeDisabled()
    for (const label of [
      'Description',
      'Kind of object',
      'Fires when the health is',
      'Only for this reason',
      'Severity of the incident',
      'Activation delay (seconds)',
      'Recovery delay (seconds)',
    ]) {
      expect(field(label), label).toBeDisabled()
    }
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'All customers and sites' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByText('You may view this rule but not change it.')).toBeInTheDocument()
  })

  it('shows a rule the account may not change as read-only, even with the edit capability', async () => {
    setup('/settings/alert-rules/r1', can('viewAlertRules', 'editAlertRules'), {
      rule: rule({ id: 'r1', canEdit: false }),
    })
    expect(await nameField()).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('says the server refused when it answers 403, whatever the session said', async () => {
    setup('/settings/alert-rules/r1', undefined, {
      rule: new ApiError('Forbidden.', 403, 'forbidden'),
    })
    expect(await screen.findByText('Not permitted')).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('says a rule that is not there is not found', async () => {
    setup('/settings/alert-rules/gone', undefined, {
      rule: new ApiError('Not found.', 404, 'not_found'),
    })
    expect(await screen.findByText('Alert rule not found')).toBeInTheDocument()
  })

  it('says a failed read, with Retry that reads again', async () => {
    const served = setup('/settings/alert-rules/new', undefined, {
      options: new ApiError('The database is down.', 503, 'unavailable'),
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('The database is down.')
    served.getAlertRuleOptions.mockResolvedValueOnce(options())
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await nameField()).toBeInTheDocument()
  })
})

describe('a new rule', () => {
  it('starts from what the API offers: the first kind and condition, the defaults, enabled', async () => {
    setup('/settings/alert-rules/new')
    expect(await nameField()).toHaveValue('')
    expect(screen.getByRole('heading', { name: 'New alert rule' })).toBeInTheDocument()
    expect(field('Kind of object')).toHaveValue('server')
    expect(field('Kind of object')).toBeEnabled()
    expect(field('Fires when the health is')).toHaveValue('critical')
    expect(field('Only for this reason')).toHaveValue('')
    expect(field('Severity of the incident')).toHaveValue('critical')
    expect(field('Activation delay (seconds)')).toHaveValue('60')
    expect(field('Recovery delay (seconds)')).toHaveValue('120')
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'All customers and sites' })).toBeChecked()
  })

  it('offers only the kinds, conditions and reasons of the options, nothing of its own', async () => {
    setup('/settings/alert-rules/new')
    await nameField()
    expect(choices('Kind of object')).toEqual(['server', 'device'])
    expect(choices('Fires when the health is')).toEqual(['critical', 'warning'])
    expect(choices('Only for this reason')).toEqual(['', 'offline', 'resources'])
    expect(choices('Severity of the incident')).toEqual(['critical', 'warning'])
  })

  it('changes the conditions and starts the reason over for another kind', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/new')
    await nameField()
    await user.selectOptions(field('Only for this reason'), 'offline')
    await user.selectOptions(field('Kind of object'), 'device')
    expect(choices('Fires when the health is')).toEqual(['critical', 'unknown'])
    expect(field('Fires when the health is')).toHaveValue('critical')
    expect(choices('Only for this reason')).toEqual(['', 'unreachable', 'no_poll'])
    expect(field('Only for this reason')).toHaveValue('')
  })

  it('keeps a reason only for a condition that can fire it', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/new')
    await nameField()
    await user.selectOptions(field('Only for this reason'), 'resources')
    await user.selectOptions(field('Fires when the health is'), 'warning')
    expect(field('Only for this reason')).toHaveValue('resources')
    await user.selectOptions(field('Fires when the health is'), 'critical')
    await user.selectOptions(field('Only for this reason'), 'offline')
    await user.selectOptions(field('Fires when the health is'), 'warning')
    expect(field('Only for this reason')).toHaveValue('')
  })

  it('says the delay as a duration beside its field', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/new')
    await nameField()
    await user.clear(field('Activation delay (seconds)'))
    await user.type(field('Activation delay (seconds)'), '3600')
    expect(field('Activation delay (seconds)')).toHaveAccessibleDescription(/1h 0m/)
    expect(field('Recovery delay (seconds)')).toHaveAccessibleDescription(/2m 0s/)
  })

  it('says what is wrong before anything is sent, under each field, and sends nothing', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await nameField()
    await user.clear(field('Activation delay (seconds)'))
    await user.type(field('Activation delay (seconds)'), 'soon')
    await user.click(save())
    expect(field('Name')).toHaveAccessibleDescription(/Give the rule a name\./)
    expect(field('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(field('Activation delay (seconds)')).toHaveAccessibleDescription(
      /Enter a whole number of seconds from 0 to 86400\./,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('NOT SAVED')
    expect(alert).toHaveTextContent('Some values are not valid: name, activationSeconds')
    expect(served.createAlertRule).not.toHaveBeenCalled()
    expect(shell.announce).toHaveBeenCalledWith('Some values are not valid.')
  })

  it('takes the name length from the options', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await nameField()
    await user.type(field('Name'), 'x'.repeat(81))
    await user.click(save())
    expect(field('Name')).toHaveAccessibleDescription(/At most 80 characters\./)
    expect(served.createAlertRule).not.toHaveBeenCalled()
  })

  it('creates the rule with exactly what was entered, then opens it with a created notice', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await fillValid(user, '  Core down ')
    await user.selectOptions(field('Kind of object'), 'device')
    await user.selectOptions(field('Only for this reason'), 'unreachable')
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.clear(field('Recovery delay (seconds)'))
    await user.type(field('Recovery delay (seconds)'), '300')
    await user.type(field('Description'), 'Core switch')
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }))
    await user.click(save())
    await waitFor(() =>
      expect(served.createAlertRule).toHaveBeenCalledWith({
        name: 'Core down',
        description: 'Core switch',
        enabled: false,
        kind: 'device',
        health: 'critical',
        reason: 'unreachable',
        severity: 'warning',
        activationSeconds: 60,
        recoverySeconds: 300,
        customerId: null,
        siteId: null,
      }),
    )
    await waitFor(() => expect(where()).toBe('/settings/alert-rules/new-1'))
    expect(await screen.findByText('CREATED')).toBeInTheDocument()
    expect(screen.getByText(/The engine starts to apply it at its next cycle/)).toBeInTheDocument()
    expect(shell.announce).toHaveBeenCalledWith('Alert rule created.')
  })

  it('creates with the Enter key from a field: it is a form', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await fillValid(user)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(served.createAlertRule).toHaveBeenCalledTimes(1))
  })

  it('asks for a customer for a customer scope, listing the customers from the API', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await fillValid(user)
    await user.click(screen.getByRole('radio', { name: 'One customer' }))
    expect(choices('Customer')).toEqual(['', 'c1', 'c2'])
    await user.click(save())
    expect(field('Customer')).toHaveAccessibleDescription(/Choose a customer\./)
    expect(served.createAlertRule).not.toHaveBeenCalled()
    await user.selectOptions(field('Customer'), 'c2')
    await user.click(save())
    await waitFor(() =>
      expect(served.createAlertRule).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'c2', siteId: null }),
      ),
    )
  })

  it('asks for a site for a site scope, each named with its customer, and sends the site alone', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    await fillValid(user)
    await user.click(screen.getByRole('radio', { name: 'One site' }))
    expect(screen.queryByLabelText('Customer')).not.toBeInTheDocument()
    const labels = within(field('Site'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(labels).toEqual(['Choose a site…', 'Meridian / Athens DC', 'Harbor / Piraeus'])
    await user.selectOptions(field('Site'), 's1')
    await user.click(save())
    await waitFor(() =>
      expect(served.createAlertRule).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: null, siteId: 's1' }),
      ),
    )
  })

  it('shows the server’s own words under the field they are about, and keeps what was typed', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    served.createAlertRule.mockRejectedValueOnce(
      new ApiError('Invalid request.', 400, 'validation_error', {
        fields: { name: ['A rule with this name already exists.'] },
      }),
    )
    await fillValid(user, 'Taken')
    await user.click(save())
    await waitFor(() =>
      expect(field('Name')).toHaveAccessibleDescription(/A rule with this name already exists\./),
    )
    expect(field('Name')).toHaveValue('Taken')
    expect(where()).toBe('/settings/alert-rules/new')
    expect(shell.announce).toHaveBeenCalledWith('The alert rule was not saved.')
  })

  it('lists a problem of the whole, and of a field the form does not show, on top', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    served.createAlertRule.mockRejectedValueOnce(
      new ApiError('Invalid request.', 400, 'validation_error', {
        fields: { nonField: ['This combination can never fire.'], condition: ['Unknown.'] },
      }),
    )
    await fillValid(user)
    await user.click(save())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This combination can never fire.')
    expect(alert).toHaveTextContent('condition: Unknown.')
  })

  it('says a refused creation is refused', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    served.createAlertRule.mockRejectedValueOnce(new ApiError('Forbidden.', 403, 'forbidden'))
    await fillValid(user)
    await user.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account may not make this change.',
    )
  })

  it('sends once while a save is in flight', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/new')
    let finish: () => void = () => {}
    served.createAlertRule.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () =>
          resolve({
            generatedAt: iso(0),
            item: rule({ id: 'new-1', version: 1 }),
            changeEffects: CHANGE_EFFECTS,
          })
      }),
    )
    await fillValid(user)
    await user.click(save())
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(field('Name')).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(served.createAlertRule).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(where()).toBe('/settings/alert-rules/new-1'))
  })
})

describe('a rule that exists', () => {
  it('shows it as it is, with its state and its open incidents', async () => {
    setup('/settings/alert-rules/r1', undefined, {
      rule: rule({ id: 'r1', name: 'Device unreachable', openIncidents: 3, enabled: false }),
    })
    expect(await nameField()).toHaveValue('Device unreachable')
    expect(screen.getByRole('heading', { name: 'Device unreachable' })).toBeInTheDocument()
    expect(screen.getByText('DISABLED')).toBeInTheDocument()
    expect(screen.getByText('3 open incidents')).toBeInTheDocument()
    expect(field('Kind of object')).toHaveValue('device')
    expect(field('Fires when the health is')).toHaveValue('critical')
    expect(field('Only for this reason')).toHaveValue('unreachable')
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()
  })

  it('says one open incident in the singular', async () => {
    setup('/settings/alert-rules/r1', undefined, { rule: rule({ id: 'r1', openIncidents: 1 }) })
    expect(await screen.findByText('1 open incident')).toBeInTheDocument()
  })

  it('cannot change the kind: it is locked, and says why', async () => {
    setup('/settings/alert-rules/r1')
    await nameField()
    expect(field('Kind of object')).toBeDisabled()
    expect(field('Kind of object')).toHaveAccessibleDescription(
      /A rule’s kind cannot be changed: disable it and add a new rule\./,
    )
    expect(field('Name')).toBeEnabled()
  })

  it('shows the key of a default rule, read-only, and has no field to change it', async () => {
    setup('/settings/alert-rules/r1', undefined, {
      rule: rule({ id: 'r1', key: 'device-unreachable' }),
    })
    await nameField()
    expect(screen.getByText('device-unreachable').tagName).toBe('CODE')
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          /its key device-unreachable\s+is read-only/.test(element.textContent ?? ''),
      ),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/key/i)).not.toBeInTheDocument()
  })

  it('shows no key note for a rule an operator made', async () => {
    setup('/settings/alert-rules/r1')
    await nameField()
    expect(screen.queryByText(/is read-only/)).not.toBeInTheDocument()
  })

  it('offers Save only once something changed', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/r1')
    await nameField()
    expect(save()).toBeDisabled()
    expect(screen.getByText('Nothing changed yet.')).toBeInTheDocument()
    await user.type(field('Name'), ' 2')
    expect(save()).toBeEnabled()
    expect(screen.queryByText('Nothing changed yet.')).not.toBeInTheDocument()
  })

  it.each(
    ['Activation delay (seconds)', 'Recovery delay (seconds)'].flatMap((label) =>
      ['', '-1', 'soon', '86401'].map((value) => ({ label, value })),
    ),
  )('explains an invalid timing-only edit: $label = "$value"', async ({ label, value }) => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1')
    await nameField()
    await user.clear(field(label))
    if (value) await user.type(field(label), value)
    expect(save()).toBeEnabled()
    expect(screen.queryByText('Nothing changed yet.')).not.toBeInTheDocument()
    await user.click(save())
    expect(field(label)).toHaveAttribute('aria-invalid', 'true')
    expect(field(label)).toHaveAccessibleDescription(
      /Enter a whole number of seconds from 0 to 86400\./,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('NOT SAVED')
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('sends only what changed, the version that was read and never the kind', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: rule({ id: 'r1', version: 7, openIncidents: 0 }),
    })
    await nameField()
    await user.clear(field('Name'))
    await user.type(field('Name'), 'Renamed')
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await waitFor(() =>
      expect(served.updateAlertRule).toHaveBeenCalledWith('r1', {
        name: 'Renamed',
        severity: 'warning',
        version: 7,
      }),
    )
    expect(served.updateAlertRule.mock.calls[0]?.[1]).not.toHaveProperty('kind')
  })

  it('says what a saved change did, shows the rule the server kept, and sends its new version next', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: rule({ id: 'r1', version: 7 }),
    })
    await nameField()
    await user.type(field('Name'), ' 2')
    await user.click(save())
    expect(await screen.findByText('SAVED')).toBeInTheDocument()
    expect(screen.getByText(/ends no incident/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Device unreachable 2' })).toBeInTheDocument()
    expect(shell.announce).toHaveBeenCalledWith('Alert rule saved.')
    expect(save()).toBeDisabled()
    await user.type(field('Name'), '3')
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(2))
    expect(served.updateAlertRule.mock.calls[1]?.[1]).toMatchObject({ version: 8 })
  })

  it('shows the server’s words under the field, and does not close anything on a refusal', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1')
    served.updateAlertRule.mockRejectedValueOnce(
      new ApiError('Invalid request.', 400, 'validation_error', {
        fields: { activationSeconds: ['Expected a whole number of seconds from 0 to 86400.'] },
      }),
    )
    await nameField()
    await user.type(field('Name'), ' 2')
    await user.click(save())
    await waitFor(() =>
      expect(field('Activation delay (seconds)')).toHaveAccessibleDescription(
        /Expected a whole number/,
      ),
    )
    expect(field('Name')).toHaveValue('Device unreachable 2')
  })

  it('goes back to the list it came from, with its search and filters', async () => {
    setup('/settings/alert-rules/r1')
    await nameField()
    expect(screen.getByRole('link', { name: 'Alert rules' })).toHaveAttribute(
      'href',
      '/settings/alert-rules',
    )
  })
})

describe('a change that ends open incidents', () => {
  const withOpen = (over: Partial<AlertRule> = {}) =>
    rule({ id: 'r1', openIncidents: 4, version: 3, ...over })

  it('warns, from the API’s contract, before a new severity ends the incidents opened under the old one', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    const warning = await screen.findByRole('alertdialog')
    expect(warning).toHaveTextContent('ENDS INCIDENTS')
    expect(warning).toHaveTextContent('This change to “Device unreachable” ends open incidents.')
    expect(warning).toHaveTextContent('ends its 4 open incidents, all of them')
    expect(
      within(warning).getByRole('button', { name: 'Save and end incidents' }),
    ).toBeInTheDocument()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })

  it('puts the focus on the safe button, and Cancel changes nothing and keeps the form', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    const warning = await screen.findByRole('alertdialog')
    expect(within(warning).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(warning).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
    expect(field('Severity of the incident')).toHaveValue('warning')
  })

  it('saves only when confirmed, and says what the API says it does', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    served.updateAlertRule.mockResolvedValueOnce({
      generatedAt: iso(0),
      item: withOpen({ severity: 'warning', version: 4 }),
      effects: { openIncidents: 4, closes: ['rule_changed'], closesAll: true },
    })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Save and end incidents',
      }),
    )
    await waitFor(() =>
      expect(served.updateAlertRule).toHaveBeenCalledWith('r1', {
        severity: 'warning',
        version: 3,
      }),
    )
    expect(
      await screen.findByText(/as its condition or severity changed \(4 open incidents/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('words the button for disabling when the change disables the rule', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }))
    await user.click(save())
    const warning = await screen.findByRole('alertdialog')
    expect(warning).toHaveTextContent('Disabling the rule ends its 4 open incidents, all of them')
    expect(
      within(warning).getByRole('button', { name: 'Disable and end incidents' }),
    ).toBeInTheDocument()
  })

  it('warns that a new condition does too', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/r1', undefined, {
      rule: withOpen({ kind: 'server', health: 'critical', reason: null }),
    })
    await nameField()
    await user.selectOptions(field('Fires when the health is'), 'warning')
    await user.click(save())
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'A new condition or severity ends',
    )
  })

  it('warns that a narrower scope ends the incidents outside it, in the API’s words', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.click(screen.getByRole('radio', { name: 'One customer' }))
    await user.selectOptions(field('Customer'), 'c1')
    await user.click(save())
    const warning = await screen.findByRole('alertdialog')
    expect(warning).toHaveTextContent(
      'A new scope ends the open incidents of objects outside the new scope',
    )
    expect(
      within(warning).getByRole('button', { name: 'Save and end incidents' }),
    ).toBeInTheDocument()
  })

  it('does not warn for a change that ends nothing, whatever is open: a name, a description, the delays', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.type(field('Name'), ' 2')
    await user.type(field('Description'), ' more')
    await user.clear(field('Activation delay (seconds)'))
    await user.type(field('Activation delay (seconds)'), '90')
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not warn when the rule has no open incident', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: withOpen({ openIncidents: 0 }),
    })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not warn when switching a rule on', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: withOpen({ enabled: false }),
    })
    await nameField()
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }))
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('follows the contract it is given: where it names nothing, nothing is warned', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: withOpen(),
      options: options({ changeEffects: {} }),
    })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('drops the warning when the form is edited again, so it never confirms a stale change', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await screen.findByRole('alertdialog')
    await user.type(field('Name'), ' 2')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not let the form be saved again while the warning is waiting for an answer', async () => {
    const user = userEvent.setup()
    const served = setup('/settings/alert-rules/r1', undefined, { rule: withOpen() })
    await nameField()
    await user.selectOptions(field('Severity of the incident'), 'warning')
    await user.click(save())
    await screen.findByRole('alertdialog')
    expect(save()).toBeDisabled()
    expect(served.updateAlertRule).not.toHaveBeenCalled()
  })
})

describe('a rule changed elsewhere', () => {
  async function conflicted(user: ReturnType<typeof userEvent.setup>) {
    const served = setup('/settings/alert-rules/r1', undefined, {
      rule: rule({ id: 'r1', name: 'Old name', version: 3 }),
    })
    served.updateAlertRule.mockRejectedValueOnce(
      new ApiError('The rule changed.', 409, 'version_conflict'),
    )
    await nameField()
    await user.clear(field('Name'))
    await user.type(field('Name'), 'My edit')
    await user.click(save())
    await screen.findByText('CHANGED ELSEWHERE')
    return served
  }

  it('says the rule changed since it was opened, and that nothing was overwritten', async () => {
    const user = userEvent.setup()
    const served = await conflicted(user)
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('This rule was changed since you opened it.')
    expect(notice).toHaveTextContent(
      'Your changes have not been saved, and nothing was overwritten.',
    )
    expect(served.updateAlertRule).toHaveBeenCalledTimes(1)
  })

  it('does not retry on its own, and does not let the stale form be saved again', async () => {
    const user = userEvent.setup()
    const served = await conflicted(user)
    expect(save()).toBeDisabled()
    expect(field('Name')).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(served.updateAlertRule).toHaveBeenCalledTimes(1)
  })

  it('offers to load the latest version, reads it again, and starts the form from it', async () => {
    const user = userEvent.setup()
    const served = await conflicted(user)
    served.current.rule = rule({ id: 'r1', name: 'Name from elsewhere', version: 4 })
    const before = served.getAlertRule.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Load the latest version' }))
    await waitFor(() => expect(field('Name')).toHaveValue('Name from elsewhere'))
    expect(served.getAlertRule.mock.calls.length).toBeGreaterThan(before)
    expect(screen.queryByText('CHANGED ELSEWHERE')).not.toBeInTheDocument()
    expect(field('Name')).toBeEnabled()
    await user.type(field('Name'), ' again')
    await user.click(save())
    await waitFor(() => expect(served.updateAlertRule).toHaveBeenCalledTimes(2))
    expect(served.updateAlertRule.mock.calls[1]?.[1]).toMatchObject({
      name: 'Name from elsewhere again',
      version: 4,
    })
  })
})

describe('keyboard and labels', () => {
  it('names every field by a label a screen reader can read', async () => {
    setup('/settings/alert-rules/new')
    await nameField()
    for (const label of [
      'Name',
      'Description',
      'Kind of object',
      'Fires when the health is',
      'Only for this reason',
      'Severity of the incident',
      'Activation delay (seconds)',
      'Recovery delay (seconds)',
    ]) {
      expect(screen.getByLabelText(label), label).toBeInTheDocument()
    }
    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeInTheDocument()
  })

  it('goes back to the list from the back link, with the keyboard or the pointer', async () => {
    const user = userEvent.setup()
    setup('/settings/alert-rules/new')
    await nameField()
    await user.click(screen.getByRole('link', { name: 'Alert rules' }))
    expect(await screen.findByText('the list')).toBeInTheDocument()
  })
})
