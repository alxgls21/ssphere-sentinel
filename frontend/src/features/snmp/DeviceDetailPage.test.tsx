import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { DeviceDetail, DeviceInterface, DeviceSeries, InterfaceSeries } from '@/api/types'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import DeviceDetailPage from './DeviceDetailPage'
import {
  detail,
  deviceSeries,
  iface,
  interfaceSeries,
  item,
  iso,
  noRates,
  poll,
  rates,
} from './testing'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const overrides = registryOverrides()
beforeEach(() => resetFakeCharts())
afterEach(() => overrides.restore())

interface Served {
  detail?: DeviceDetail | Error
  device?: DeviceSeries | Error
  iface?: InterfaceSeries | Error
}

function apiFor(
  { detail: d, device = deviceSeries(), iface: i = interfaceSeries() }: Served,
  source: 'http' | 'mock' = 'http',
) {
  const getDevice = vi.fn<SentinelApi['getDevice']>(async () => {
    if (d instanceof Error) throw d
    return d as DeviceDetail
  })
  const getDeviceSeries = vi.fn<SentinelApi['getDeviceSeries']>(async () => {
    if (device instanceof Error) throw device
    return device
  })
  const getInterfaceSeries = vi.fn<SentinelApi['getInterfaceSeries']>(async () => {
    if (i instanceof Error) throw i
    return i
  })
  return {
    api: createTestApi({ getDevice, getDeviceSeries, getInterfaceSeries, source }),
    getDevice,
    getDeviceSeries,
    getInterfaceSeries,
  }
}

function Where() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

const page = (api: SentinelApi, search = '', id = 'dev-1', state?: unknown) =>
  renderApp(
    <>
      <Routes>
        <Route path="/snmp" element={<p>snmp list</p>} />
        <Route path="/snmp/:id" element={<DeviceDetailPage />} />
        <Route path="/servers/:id" element={<p>server page</p>} />
      </Routes>
      <Where />
    </>,
    {
      api,
      route:
        state === undefined ? `/snmp/${id}${search}` : { pathname: `/snmp/${id}`, search, state },
    },
  )

const showing = (d: DeviceDetail, extra: Omit<Served, 'detail'> = {}) =>
  apiFor({ detail: d, ...extra })
const summary = () => screen.findByRole('region', { name: 'Summary' })
const interfaces = () => screen.findByRole('table', { name: 'Interfaces' })
const row = (table: HTMLElement, name: string) =>
  within(table).getByText(name).closest('tr') as HTMLElement

describe('identity', () => {
  it('names the device, its status word, type, address, SNMP and where it is, and links back keeping the view', async () => {
    const { api } = showing(detail(item()))
    page(api, '?range=6h')
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })).toBeVisible()
    const header = screen.getByRole('heading', { level: 1 }).parentElement
      ?.parentElement as HTMLElement
    expect(within(header).getByText('REACHABLE')).toBeInTheDocument()
    expect(within(header).getByText('Switch')).toBeInTheDocument()
    expect(within(header).getByText('10.20.0.250')).toBeInTheDocument()
    expect(within(header).getByText('SNMPv2c port 161')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SNMP' })).toHaveAttribute('href', '/snmp?range=6h')
  })

  it('goes back to the list as it was left: search, filter and sort', async () => {
    const { api } = showing(detail(item()))
    page(api, '', 'dev-1', { list: '?status=critical&sort=name' })
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(screen.getByRole('link', { name: 'SNMP' })).toHaveAttribute(
      'href',
      '/snmp?status=critical&sort=name',
    )
  })

  it('shows the configuration, the system information and no credential of any kind', async () => {
    const { api } = showing(detail(item()))
    page(api)
    const panel = await summary()
    const fact = (label: string) =>
      within(panel).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement
    expect(fact('SNMP')).toHaveTextContent('SNMPv2c port 161')
    expect(fact('Polling')).toHaveTextContent('every 60 s, timeout 5 s, 2 retries')
    expect(fact('Site')).toHaveTextContent('Athens DC')
    expect(fact('sysName')).toHaveTextContent('ath-core-sw.example.net')
    expect(fact('Uptime at the last poll')).toHaveTextContent('3d')
    expect(fact('sysObjectID')).toHaveTextContent('1.3.6.1.4.1.9.1.1')
    expect(within(panel).getByText('Example OS 12.4 on a 48-port switch')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/credential|community|password|secret|auth key/i)
  })

  it('says polling is switched off for a disabled device', async () => {
    const { api } = showing(detail(item({ reason: 'disabled' })))
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('Polling', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('switched off')
  })
})

describe('the agent', () => {
  it('names the agent, its status and last heartbeat, and links to its server', async () => {
    const user = userEvent.setup()
    const { api } = showing(detail(item()))
    page(api)
    const panel = await summary()
    const link = within(panel).getByRole('link', { name: 'ath-probe' })
    expect(link).toHaveAttribute('href', '/servers/srv-ath-probe')
    expect(link).toHaveAttribute('title', 'Open ath-probe-01')
    expect(within(panel).getByText('online', { selector: 'dd' })).toBeInTheDocument()
    expect(within(panel).getByText('30s ago')).toBeInTheDocument()
    await user.click(link)
    expect(await screen.findByText('server page')).toBeInTheDocument()
  })

  it('gives no link where the API gave no server id: an agent the user may not see', async () => {
    const { api } = showing(detail(item({ agent: 'hidden' })))
    page(api)
    const panel = await summary()
    expect(within(panel).queryByRole('link', { name: 'ath-probe' })).toBeNull()
    expect(
      within(panel).getByText('Agent', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('assigned')
  })

  it('says none is assigned, and links nothing', async () => {
    const { api } = showing(detail(item({ agent: 'none', reason: 'no_agent' })))
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('Agent', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('none assigned')
    expect(within(panel).queryByRole('link')).toBeNull()
  })
})

describe('current state and history are told apart', () => {
  it('says the API’s reason beside the status for an unreachable device, with its error in words', async () => {
    const { api } = showing(detail(item({ reason: 'unreachable', error: 'auth_failure' })))
    page(api)
    const panel = await summary()
    expect(within(panel).getByText('UNREACHABLE')).toBeInTheDocument()
    expect(
      within(panel).getByText(
        'The latest poll could not reach the device: authentication failure.',
      ),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('region', { name: 'Current poll' })).toBeInTheDocument()
    expect(
      within(panel).getByText('Last successful poll', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('10m ago')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([
    ['disabled', 'DISABLED', /switched off/],
    ['no_agent', 'NO AGENT', /No agent is assigned/],
    ['agent_offline', 'AGENT OFFLINE', /disabled or has stopped reporting/],
    ['no_poll', 'NOT POLLED', /not been polled yet/],
    ['stale', 'STALE', /too old to describe the present/],
  ] as const)(
    'puts a notice above everything for a %s device, in its own words',
    async (reason, word, sentence) => {
      const { api } = showing(
        detail(item({ reason, agent: reason === 'no_agent' ? 'none' : 'online' })),
      )
      page(api)
      const notice = await screen.findByRole('status')
      expect(within(notice).getByText(word)).toBeInTheDocument()
      expect(notice).toHaveTextContent(sentence)
    },
  )

  it('shows a stale poll as the last one, not current, with its own age and no present response time', async () => {
    const { api } = showing(detail(item({ reason: 'stale', responseMs: 9 })))
    page(api)
    const panel = await summary()
    const last = within(panel).getByRole('region', { name: 'Last poll' })
    expect(within(last).getByText('NOT CURRENT')).toBeInTheDocument()
    expect(within(last).getAllByText('2h ago').length).toBeGreaterThan(0)
    expect(within(panel).queryByRole('region', { name: 'Current poll' })).toBeNull()
    expect(screen.getByText('LAST POLL')).toBeInTheDocument()
  })

  it('says it has not been polled, with no poll block, for a device never polled', async () => {
    const { api } = showing(detail(item({ reason: 'no_poll' }), []))
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('It has not been polled yet.', { selector: 'p:not(:first-child)' }),
    ).toBeInTheDocument()
    expect(within(panel).queryByRole('region', { name: /poll/ })).toBeNull()
    expect(await screen.findByText('No polls')).toBeInTheDocument()
    expect(await screen.findByText('No interfaces listed')).toBeInTheDocument()
  })

  it('lists the recent polls newest first, with an unreachable one and its error in words', async () => {
    const d = detail(item(), [iface(1)], {
      polls: [
        poll(20, { responseMs: 11 }),
        poll(80, { reachable: false, responseMs: null, error: 'timeout' }),
      ],
    })
    const { api } = showing(d)
    page(api)
    const table = await screen.findByRole('table', { name: 'Recent polls' })
    const body = within(table).getAllByRole('row').slice(1)
    expect(body[0]).toHaveTextContent('reached')
    expect(body[0]).toHaveTextContent('11 ms')
    expect(body[1]).toHaveTextContent('unreachable: timeout')
    expect(body[1]).toHaveTextContent('—')
  })
})

describe('the interface inventory', () => {
  const INTERFACES = [
    iface(1, 'up', { alias: 'uplink to core' }),
    iface(2, 'down'),
    iface(3, 'admin_down', { rates: noRates('delta_state', 'first') }),
    iface(4, 'other', { operStatus: 'dormant' }),
    iface(5, 'absent'),
  ]

  it('lists the present interfaces with index, name, alias, admin and oper words, and the speed', async () => {
    const { api } = showing(detail(item(), INTERFACES))
    page(api)
    const t = await interfaces()
    const one = row(t, 'Gi1/0/1 (uplink to core)')
    expect(within(one).getByText('1', { selector: 'td' })).toBeInTheDocument()
    expect(within(one).getByText('admin up · oper up')).toBeInTheDocument()
    expect(within(one).getByText('1 Gbps')).toBeInTheDocument()
  })

  it('tells up, operationally down, admin down, unknown, absent and device unavailable apart, by word', async () => {
    const { api } = showing(detail(item(), [...INTERFACES, iface(6, 'device_unavailable')]))
    page(api)
    const t = await interfaces()
    expect(row(t, 'Gi1/0/1 (uplink to core)')).toHaveTextContent('UP')
    expect(row(t, 'Gi1/0/2')).toHaveTextContent('DOWN')
    expect(row(t, 'Gi1/0/2')).toHaveTextContent('admin up · oper down')
    expect(row(t, 'Gi1/0/3')).toHaveTextContent('ADMIN DOWN')
    expect(row(t, 'Gi1/0/4')).toHaveTextContent('UNKNOWN')
    expect(row(t, 'Gi1/0/4')).toHaveTextContent('oper dormant')
    expect(row(t, 'Gi1/0/5')).toHaveTextContent('ABSENT')
    expect(row(t, 'Gi1/0/6')).toHaveTextContent('DEVICE N/A')
    // Colour agrees with the word, and an interface down is a warning, never a critical.
    expect(row(t, 'Gi1/0/2').querySelector('span.w-0\\.5')).toHaveClass('bg-warning')
    expect(row(t, 'Gi1/0/6').querySelector('span.w-0\\.5')).not.toHaveClass('bg-critical')
  })

  it('does not call the device unhealthy because an interface is down', async () => {
    const { api } = showing(detail(item(), INTERFACES))
    page(api)
    const header = (await screen.findByRole('heading', { level: 1 })).parentElement
      ?.parentElement as HTMLElement
    expect(within(header).getByText('REACHABLE')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('table', { name: 'Interfaces' })).toBeInTheDocument()
  })

  it('shows the inbound and outbound rates, utilization, errors and discards, as the API calculated them', async () => {
    const { api } = showing(detail(item(), [iface(1)]))
    page(api)
    const r = row(await interfaces(), 'Gi1/0/1')
    expect(r).toHaveTextContent('420.0 Mbps')
    expect(r).toHaveTextContent('85.0 Mbps')
    expect(r).toHaveTextContent('42.0%')
    expect(r).toHaveTextContent('8.5%')
    expect(r).toHaveTextContent('0.00/s')
    expect(r).toHaveTextContent('0.05/s')
    expect(r).toHaveTextContent('1.5/s'.replace('1.5', '1.50'))
  })

  it('shows the last sample’s age, with its time on hover, and "never" for an interface never sampled', async () => {
    const { api } = showing(detail(item(), [iface(1), iface(2, 'up', { rates: null })]))
    page(api)
    const t = await interfaces()
    expect(within(row(t, 'Gi1/0/1')).getByText('20s ago')).toBeInTheDocument()
    expect(within(row(t, 'Gi1/0/2')).getByText('never')).toBeInTheDocument()
  })

  it('never shows an invalid sample’s rate as zero: dashes with the reason, for each reason', async () => {
    const withRates = [
      iface(1, 'up', { rates: noRates('delta_state', 'first') }),
      iface(2, 'up', { rates: noRates('delta_state', 'reboot') }),
      iface(3, 'up', { rates: noRates('delta_state', 'reset') }),
      iface(4, 'up', { rates: noRates('delta_state', 'gap') }),
      iface(5, 'up', { rates: noRates('interval') }),
      iface(6, 'up', { rates: noRates('implausible') }),
      iface(7, 'up', { rates: noRates('stale') }),
    ]
    const { api } = showing(detail(item(), withRates))
    page(api)
    const t = await interfaces()
    const expected: Record<string, RegExp> = {
      'Gi1/0/1': /first sample/,
      'Gi1/0/2': /device restarted/,
      'Gi1/0/3': /counter was reset/,
      'Gi1/0/4': /previous sample was too old/,
      'Gi1/0/5': /no valid time interval/,
      'Gi1/0/6': /1\.5 times the interface speed/,
      'Gi1/0/7': /older than the device’s stale limit/,
    }
    for (const [name, reason] of Object.entries(expected)) {
      const r = row(t, name)
      expect(within(r).getAllByLabelText(/^No rate: /).length, name).toBeGreaterThanOrEqual(8)
      expect(within(r).getAllByLabelText(reason).length, name).toBeGreaterThan(0)
      // No traffic figure of any kind in an invalid row.
      expect((r.textContent ?? '').replace('1 Gbps', ''), name).not.toMatch(
        /\d(\.\d)? ?[KMG]?bps|\d%|\/s/,
      )
    }
  })

  it('shows the bps and says utilization is unavailable when the speed is unknown', async () => {
    const unknownSpeed = iface(1, 'up', {
      speedBps: null,
      rates: rates({ inUtilizationPercent: null, outUtilizationPercent: null }),
    })
    const { api } = showing(detail(item(), [unknownSpeed]))
    page(api)
    const r = row(await interfaces(), 'Gi1/0/1')
    expect(r).toHaveTextContent('420.0 Mbps')
    expect(
      within(r).getAllByLabelText(/speed is not known, so utilization cannot be given/),
    ).toHaveLength(2)
    expect(within(r).getByLabelText('speed not reported')).toBeInTheDocument()
  })

  it('says when the device is not current that its interface states and rates are the last stored ones', async () => {
    const down = [iface(1, 'device_unavailable', { rates: noRates('stale') })]
    const { api } = showing(detail(item({ reason: 'unreachable' }), down))
    page(api)
    const panel = await screen.findByRole('region', { name: 'Interfaces' })
    expect(panel).toHaveTextContent(/The device is not current \(unreachable\)/)
    expect(panel).toHaveTextContent(/the last ones stored, not the present ones/)
    expect(row(within(panel).getByRole('table'), 'Gi1/0/1')).toHaveTextContent('DEVICE N/A')
  })

  it('says nothing about it for a current device, and names the interface counts in the footer', async () => {
    const { api } = showing(
      detail(item({ interfaces: { healthy: 1, idle: 1, warning: 1 } }), INTERFACES.slice(0, 3)),
    )
    page(api)
    const panel = await screen.findByRole('region', { name: 'Interfaces' })
    expect(panel).not.toHaveTextContent(/The device is not current/)
    expect(panel).toHaveTextContent('3 interfaces, 1 up, 1 admin down, 1 down, 0 unknown')
  })
})

describe('history', () => {
  it('asks for the device history over the range in the URL and draws it with a table twin', async () => {
    const { api, getDeviceSeries } = showing(detail(item()))
    page(api, '?range=6h')
    const figure = await screen.findByRole('figure')
    expect(figure).toHaveAccessibleName(/Poll history of ath-core-sw, last 6 hours/)
    expect(getDeviceSeries).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'dev-1', range: '6h' }),
    )
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
  })

  it('says there is no history for a range with no poll, and draws no chart', async () => {
    const empty = deviceSeries({
      reachablePolls: [0, 0, 0, 0, 0, 0],
      failedPolls: [0, 0, 0, 0, 0, 0],
    })
    const { api } = showing(detail(item()), { device: empty })
    page(api)
    expect(await screen.findByText('No history')).toBeInTheDocument()
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('fails on its own: the rest of the page stays, with its own Retry', async () => {
    const { api } = showing(detail(item()), { device: new ApiError('History down', 503) })
    page(api)
    const panel = await screen.findByRole('region', { name: 'Poll history' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('History down')
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(await summary()).toBeVisible()
  })
})

describe('interface history', () => {
  const INTERFACES: DeviceInterface[] = [iface(1), iface(2, 'down')]

  it('is not asked for until an interface is chosen, and no panel is shown', async () => {
    const { api, getInterfaceSeries } = showing(detail(item(), INTERFACES))
    page(api)
    await interfaces()
    expect(getInterfaceSeries).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Interface history' })).toBeNull()
  })

  it('opens from a row, keeps the choice in the URL, asks for that interface and range, and can be closed', async () => {
    const user = userEvent.setup()
    const { api, getInterfaceSeries } = showing(detail(item(), INTERFACES))
    page(api, '?range=6h')
    await interfaces()
    await user.click(screen.getByRole('button', { name: 'History of Gi1/0/2' }))
    expect(screen.getByTestId('location')).toHaveTextContent('interface=2')
    expect(screen.getByTestId('location')).toHaveTextContent('range=6h')
    const panel = await screen.findByRole('region', { name: 'Interface history' })
    await waitFor(() =>
      expect(getInterfaceSeries).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'dev-1', ifIndex: 2, range: '6h' }),
      ),
    )
    expect(await within(panel).findByRole('figure')).toHaveAccessibleName(
      /Traffic history of Gi1\/0\/2, last 6 hours/,
    )
    await user.click(screen.getByRole('button', { name: 'History of Gi1/0/2' }))
    expect(screen.getByTestId('location')).not.toHaveTextContent('interface=')
    expect(screen.queryByRole('region', { name: 'Interface history' })).toBeNull()
  })

  it('opens straight from a shared link, and keeps the way back to the list as it was left', async () => {
    const { api } = showing(detail(item(), INTERFACES))
    page(api, '?interface=1', 'dev-1', { list: '?status=critical' })
    expect(await screen.findByRole('region', { name: 'Interface history' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SNMP' })).toHaveAttribute(
      'href',
      '/snmp?status=critical',
    )
  })

  it('says the device lists no such interface, and asks for nothing', async () => {
    const { api, getInterfaceSeries } = showing(detail(item(), INTERFACES))
    page(api, '?interface=99')
    expect(await screen.findByText('Interface not listed')).toBeInTheDocument()
    expect(screen.getByText(/lists no present interface with ifIndex 99/)).toBeInTheDocument()
    expect(getInterfaceSeries).not.toHaveBeenCalled()
  })

  it('says how many samples gave no rate and that they are never drawn as zero traffic', async () => {
    const { api } = showing(detail(item(), INTERFACES), { iface: interfaceSeries() })
    page(api, '?interface=1')
    const panel = await screen.findByRole('region', { name: 'Interface history' })
    await within(panel).findByRole('figure')
    expect(panel).toHaveTextContent(
      '2 samples without a rate are not drawn, and never as zero traffic',
    )
  })

  it('says no sample gave a rate, and draws no line from them, when every sample was unusable', async () => {
    const none = interfaceSeries({
      inBps: [null, null, null, null, null, null],
      outBps: [null, null, null, null, null, null],
      inBpsMax: [null, null, null, null, null, null],
      outBpsMax: [null, null, null, null, null, null],
      inErrorsPerSec: [null, null, null, null, null, null],
      outErrorsPerSec: [null, null, null, null, null, null],
      inDiscardsPerSec: [null, null, null, null, null, null],
      outDiscardsPerSec: [null, null, null, null, null, null],
      validSamples: [0, 0, 0, 0, 0, 0],
      invalidSamples: [1, 1, 0, 2, 1, 1],
    })
    const { api } = showing(detail(item(), INTERFACES), { iface: none })
    page(api, '?interface=1')
    const panel = await screen.findByRole('region', { name: 'Interface history' })
    expect(
      await within(panel).findByText(/No sample in this range gave a rate/),
    ).toBeInTheDocument()
    type Drawn = { series: { id: string; data: [number, number | null][] }[] }
    const traffic = () =>
      fakeCharts
        .flatMap((chart) => chart.setOption.mock.calls.map((call) => call[0] as Drawn))
        .filter((option) => option.series?.some((s) => s.id === 'inBps'))
        .at(-1)
    await waitFor(() => expect(traffic()).toBeDefined())
    // Every bucket is a gap: none of the unusable samples is drawn, and none as zero.
    for (const s of traffic()?.series ?? []) {
      for (const [, value] of s.data) expect(value).toBeNull()
    }
  })

  it('says there is no history for an interface never sampled in the range', async () => {
    const empty = interfaceSeries({
      validSamples: [0, 0, 0, 0, 0, 0],
      invalidSamples: [0, 0, 0, 0, 0, 0],
    })
    const { api } = showing(detail(item(), INTERFACES), { iface: empty })
    page(api, '?interface=1')
    const panel = await screen.findByRole('region', { name: 'Interface history' })
    expect(await within(panel).findByText('No history')).toBeInTheDocument()
    expect(within(panel).queryByRole('figure')).toBeNull()
  })

  it('fails on its own with its Retry, and the rest of the page stays', async () => {
    const { api } = showing(detail(item(), INTERFACES), { iface: new ApiError('No series', 503) })
    page(api, '?interface=1')
    const panel = await screen.findByRole('region', { name: 'Interface history' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('No series')
    expect(await interfaces()).toBeVisible()
  })
})

describe('missing, failing and provenance', () => {
  it('says the device is not found for a 404, with the way back', async () => {
    const { api } = apiFor({ detail: new ApiError('Not found.', 404) })
    page(api, '', 'nope')
    expect(await screen.findByText('Device not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to SNMP' })).toHaveAttribute('href', '/snmp')
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
  })

  it('shows the failure and no other device when it cannot be read', async () => {
    const { api } = apiFor({ detail: new ApiError('Cannot reach the server.', null, 'network') })
    page(api)
    expect((await screen.findAllByText('Cannot reach the server.')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { level: 1, name: 'ath-core-sw' })).toBeNull()
  })

  it('tags every panel live over the console API, and none live over the sample API', async () => {
    const names = ['Summary', 'Poll history', 'Recent polls', 'Interfaces', 'Interface history']
    const live = page(showing(detail(item())).api, '?interface=1')
    await summary()
    await screen.findByRole('region', { name: 'Interface history' })
    for (const name of names) {
      expect(
        within(screen.getByRole('region', { name })).getByText(/^live/),
        name,
      ).toBeInTheDocument()
    }
    live.unmount()
    page(apiFor({ detail: detail(item()) }, 'mock').api, '?interface=1')
    await summary()
    await screen.findByRole('region', { name: 'Interface history' })
    for (const name of names) {
      expect(within(screen.getByRole('region', { name })).queryByText(/^live/), name).toBeNull()
    }
  })

  it('is not live while the SNMP feature is not connected', async () => {
    overrides.set('snmp', { connected: false })
    page(showing(detail(item())).api)
    expect(within(await summary()).queryByText(/^live/)).toBeNull()
  })

  it('draws no interface or poll of its own when the device lists none: nothing is made up', async () => {
    const { api } = showing(detail(item({ reason: 'no_poll' }), [], { polls: [] }))
    page(api)
    await summary()
    expect(await screen.findByText('No interfaces listed')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Interfaces' })).toBeNull()
    expect(iso(0)).toBeTruthy()
  })
})
