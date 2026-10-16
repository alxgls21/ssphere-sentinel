import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import DesignSystemPage from './DesignSystemPage'
import { TOKEN_GROUPS } from './tokens'
import { FILTERED_SIMULATIONS, filterId } from './vision'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const SECTION_TITLES = [
  'Palette',
  'Typography',
  'Status alphabet',
  'Provenance',
  'Controls',
  'Meters',
  'Panel states',
  'Hero',
  'Charts',
  'Timeline',
  'Motion',
]

const SIMULATION_LABEL = {
  grayscale: 'Grayscale',
  protanopia: 'Protanopia',
  deuteranopia: 'Deuteranopia',
  tritanopia: 'Tritanopia',
} as const

function renderPage() {
  return renderApp(<DesignSystemPage />, { route: '/_ds' })
}

const section = (name: string) => screen.getByRole('region', { name })
const wrapper = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-simulation]') as HTMLElement

describe('DesignSystemPage', () => {
  it('has one page heading and a labelled section for every part of the system, in order', () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Design system' })).toBeInTheDocument()
    const headings = SECTION_TITLES.map((title) =>
      within(section(title)).getByRole('heading', { level: 2, name: title }),
    )
    // Document order is reading order.
    for (const [index, heading] of headings.slice(1).entries()) {
      const previous = headings[index] as HTMLElement
      expect(
        previous.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })

  it('offers a jump link for each section that lands on that section', () => {
    renderPage()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(SECTION_TITLES)
    for (const link of links) {
      const target = document.getElementById(link.getAttribute('href')?.slice(1) ?? '')
      expect(target).toBe(section(link.textContent ?? ''))
    }
  })

  it('says everything is sample data', () => {
    renderPage()
    expect(screen.getByText(/every value on it is sample data/)).toBeInTheDocument()
  })
})

describe('color-vision simulation', () => {
  it('starts with no simulation and no filter on the content', () => {
    const { container } = renderPage()
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked()
    expect(wrapper(container).dataset.simulation).toBe('none')
    expect(wrapper(container).style.filter).toBe('')
  })

  it.each(FILTERED_SIMULATIONS)(
    'filters the whole gallery for %s and clears it for none',
    async (name) => {
      const user = userEvent.setup()
      const { container } = renderPage()
      const label = SIMULATION_LABEL[name]

      await user.click(screen.getByRole('radio', { name: label }))
      expect(screen.getByRole('radio', { name: label })).toBeChecked()
      expect(wrapper(container).dataset.simulation).toBe(name)
      expect(wrapper(container).style.filter).toContain(`#${filterId(name)}`)

      await user.click(screen.getByRole('radio', { name: 'None' }))
      expect(wrapper(container).style.filter).toBe('')
    },
  )

  it('wraps every section but never the toolbar, which must stay legible', () => {
    const { container } = renderPage()
    const content = wrapper(container)
    for (const title of SECTION_TITLES) expect(content).toContainElement(section(title))
    const toolbar = screen.getByRole('radiogroup', { name: 'Color vision simulation' })
    expect(content).not.toContainElement(toolbar)
  })

  it('defines a filter for each simulation, each with one 20-value color matrix', () => {
    renderPage()
    for (const name of FILTERED_SIMULATIONS) {
      const filter = document.getElementById(filterId(name))
      expect(filter?.tagName.toLowerCase()).toBe('filter')
      const matrix = filter?.querySelector('feColorMatrix')
      expect(matrix?.getAttribute('type')).toBe('matrix')
      expect(matrix?.getAttribute('values')?.split(' ')).toHaveLength(20)
    }
  })

  it('moves and selects with the arrow keys, like every segmented control', async () => {
    const user = userEvent.setup()
    const { container } = renderPage()
    screen.getByRole('radio', { name: 'None' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Grayscale' })).toBeChecked()
    expect(wrapper(container).dataset.simulation).toBe('grayscale')
  })

  it('explains why in words', () => {
    renderPage()
    expect(
      screen.getByText(/distinguishable by shape and word under every simulation/),
    ).toBeVisible()
  })
})

describe('palette', () => {
  it('lists every token once', () => {
    renderPage()
    const total = TOKEN_GROUPS.reduce((sum, group) => sum + group.tokens.length, 0)
    expect(within(section('Palette')).getAllByText(/^--color-/)).toHaveLength(total)
  })
})

describe('status alphabet', () => {
  it('draws every glyph at every size, labelled', () => {
    renderPage()
    const status = within(section('Status alphabet'))
    for (const name of [
      'healthy',
      'warning',
      'critical',
      'offline',
      'unknown',
      'idle',
      'planned',
    ]) {
      for (const size of [6, 10, 12, 16, 24]) {
        expect(status.getByRole('img', { name: `${name}, ${size}px` })).toBeInTheDocument()
      }
    }
  })

  it('pairs a word with each status, domain words included', () => {
    renderPage()
    const status = within(section('Status alphabet'))
    // Once as a plain tag and once on its tint; the class words are listed a third time in the legend.
    for (const word of ['OK', 'WARN', 'CRIT', 'OFFL', 'UNKN', 'IDLE']) {
      expect(status.getAllByText(word), word).toHaveLength(3)
    }
    for (const word of ['ONLINE', 'OFFLINE', 'RESTARTING']) {
      expect(status.getAllByText(word), word).toHaveLength(2)
    }
  })

  it('shows offline as a state of its own: shape, word and tint distinct from critical', () => {
    renderPage()
    const status = within(section('Status alphabet'))
    const offline = status.getAllByText('OFFLINE').map((word) => word.closest('[data-status]'))
    for (const tag of offline) expect(tag).toHaveAttribute('data-status', 'offline')
    const critical = status.getAllByText('UNHEALTHY').map((word) => word.closest('[data-status]'))
    for (const tag of critical) expect(tag).toHaveAttribute('data-status', 'critical')
    expect(offline.some((tag) => tag?.classList.contains('bg-offline-tint'))).toBe(true)
  })

  it('closes with the legend of every state', () => {
    renderPage()
    const legend = within(section('Status alphabet')).getByRole('list', { name: 'Status legend' })
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['OK', 'WARN', 'CRIT', 'OFFL', 'UNKN', 'IDLE'])
  })
})

describe('controls', () => {
  it('toggles a chip', async () => {
    const user = userEvent.setup()
    renderPage()
    const chip = within(section('Controls')).getByRole('button', { name: 'Unpressed' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps a button that explains itself focusable and one that is disabled out of the tab order', () => {
    renderPage()
    const controls = within(section('Controls'))
    expect(controls.getAllByRole('button', { name: 'aria-disabled' })[0]).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(controls.getAllByRole('button', { name: 'disabled' })[0]).toBeDisabled()
  })
})

describe('meters', () => {
  it('samples a cell meter across both thresholds and with no data', () => {
    renderPage()
    const meters = within(section('Meters')).getAllByRole('meter')
    expect(meters.map((meter) => meter.getAttribute('value'))).toEqual([
      '0',
      '45',
      '80',
      '94',
      '95',
      '100',
    ])
    expect(within(section('Meters')).getByText('CPU of api-07: no data')).toBeInTheDocument()
  })

  it('names a strip row by the entities that are not OK', () => {
    renderPage()
    expect(
      within(section('Meters')).getByRole('button', {
        name: 'Few: 1 critical (srv-01), 1 warning (srv-04), 4 ok',
      }),
    ).toBeInTheDocument()
  })

  it('names a strip row with an offline server apart from the critical ones', () => {
    renderPage()
    expect(
      within(section('Meters')).getByRole('button', {
        name: 'One server offline: 1 critical (srv-01), 1 offline (srv-02), 1 warning (srv-04), 3 ok',
      }),
    ).toBeInTheDocument()
  })

  it('draws the segmented bar with an offline segment after critical', () => {
    renderPage()
    const bar = within(section('Meters')).getByRole('img', {
      name: 'One server offline: 3 critical, 1 offline, 5 warning, 3 idle, 112 ok',
    })
    expect(
      [...bar.querySelectorAll('[data-status]')].map((part) => part.getAttribute('data-status')),
    ).toEqual(['critical', 'offline', 'warning', 'idle', 'healthy'])
  })

  it('selects a cell of the entity grid', async () => {
    const user = userEvent.setup()
    renderPage()
    const meters = within(section('Meters'))
    expect(meters.getByText('Nothing selected')).toBeInTheDocument()
    const grid = meters.getByRole('grid', { name: 'Athens-DC entities' })
    await user.click(within(grid).getAllByRole('button')[0] as HTMLElement)
    expect(meters.getByText('Selected: srv-01')).toBeInTheDocument()
  })
})

describe('panel states', () => {
  const region = (name: string) => within(section('Panel states')).getByRole('region', { name })

  it('shows a panel in every state, each its own region', () => {
    renderPage()
    for (const name of [
      'Fleet load',
      'Probe latency',
      'Needs attention',
      'Infrastructure health',
      'Docker hosts',
      'Probe targets',
      'Active alerts',
      'Servers',
    ]) {
      expect(region(name)).toBeInTheDocument()
    }
  })

  it('numbers the ready panel and marks every one mock, except the planned one', () => {
    renderPage()
    expect(region('Fleet load')).toHaveAttribute('aria-keyshortcuts', '3')
    expect(within(region('Fleet load')).getByText('mock · 15s')).toBeInTheDocument()
    expect(region('Active alerts')).toHaveAttribute('data-planned', 'true')
    expect(within(region('Active alerts')).getByText('Planned')).toBeInTheDocument()
    expect(within(region('Active alerts')).queryByText(/^mock/)).not.toBeInTheDocument()
  })

  it('shows the skeleton for a loading panel after its delay, with the header in place', async () => {
    renderPage()
    const loading = region('Probe latency')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    expect(within(loading).getByRole('heading', { name: 'Probe latency' })).toBeInTheDocument()
    await waitFor(() => expect(loading.querySelector('.animate-skeleton')).not.toBeNull())
  })

  it('offers Retry on an error, and keeps the data under a banner when only a refresh failed', () => {
    renderPage()
    const error = within(region('Infrastructure health'))
    expect(error.getByRole('alert')).toHaveTextContent('Could not load infrastructure health')
    expect(error.getByRole('button', { name: 'Retry' })).toBeInTheDocument()

    const kept = within(region('Servers'))
    expect(kept.getByRole('status')).toHaveTextContent('Refresh failed')
    expect(kept.getByRole('status')).toHaveTextContent('Showing data from 14:05:12Z')
    expect(kept.getByText('edge-gw-02')).toBeInTheDocument()
  })

  it('names a stale panel STALE and a positive empty one in words', () => {
    renderPage()
    expect(within(region('Probe targets')).getByText('STALE')).toBeInTheDocument()
    expect(
      within(region('Needs attention')).getByText('Nothing needs attention'),
    ).toBeInTheDocument()
  })
})

describe('hero', () => {
  it('shows the verdict in all five states', () => {
    renderPage()
    const verdicts = new Set(
      [...section('Hero').querySelectorAll('button[data-verdict]')].map(
        (button) => (button as HTMLElement).dataset.verdict,
      ),
    )
    expect([...verdicts].sort()).toEqual(['critical', 'degraded', 'nodata', 'nominal', 'partial'])
  })

  it('says why a verdict has no data, and dims a stale one', () => {
    renderPage()
    const hero = within(section('Hero'))
    expect(hero.getAllByText('NO DATA').length).toBeGreaterThan(0)
    expect(hero.getAllByText('data older than 2 min').length).toBeGreaterThan(0)
    const stale = hero.getByText('Critical, stale').parentElement as HTMLElement
    expect(stale.querySelector('.opacity-60')).not.toBeNull()
  })

  it('draws the tiles: implemented ones are links, planned ones are not', async () => {
    renderPage()
    const hero = within(section('Hero'))
    expect(
      hero.getByRole('link', {
        name: 'Servers: 15 of 16 online, 1 critical, 2 warning, mock data',
      }),
    ).toHaveAttribute('href', '/servers')
    expect(hero.getByRole('link', { name: /^Containers: 65 of 68 running/ })).toBeInTheDocument()
    expect(hero.getByRole('link', { name: /^Net targets: 39 of 40 up/ })).toBeInTheDocument()
    expect(hero.queryByRole('link', { name: /^(Devices|Alerts)/ })).not.toBeInTheDocument()
    // The alerts tile loads its sample: three alerts, never a link.
    expect(await hero.findByText('sample')).toBeInTheDocument()
  })

  it('shows a tile loading, failed and stale', () => {
    renderPage()
    const hero = within(section('Hero'))
    expect(hero.getByRole('link', { name: 'Servers: loading, mock data' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(hero.getByRole('alert')).toHaveTextContent('Could not load')
    expect(
      hero.getByRole('link', {
        name: 'Servers: 15 of 16 online, 1 critical, 2 warning, mock data, stale',
      }),
    ).toBeInTheDocument()
  })
})

describe('charts', () => {
  it('draws the latency chart with its legend, and the table twin beside it', async () => {
    renderPage()
    const charts = within(section('Charts'))
    const figure = await charts.findByRole('figure', { name: /^Network latency, last hour: p95/ })
    expect(within(figure).getByRole('list', { name: 'Series' })).toBeInTheDocument()
    const table = charts.getByRole('table', { name: /newest first/ })
    // One row per bucket, newest first, plus the header row.
    expect(within(table).getAllByRole('row')).toHaveLength(31)
  })
})
