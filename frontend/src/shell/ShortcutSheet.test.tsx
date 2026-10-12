import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { SCOPE_ORDER, SCOPE_TITLE, SHORTCUTS } from '@/config/shortcuts'
import { ShortcutSheet } from './ShortcutSheet'
import { renderShell } from './testing'

afterEach(() => vi.unstubAllGlobals())

function Opener() {
  const { openShortcuts, shortcutsOpen } = useShell()
  const { setSingleKeyShortcuts } = usePrefs()
  return (
    <>
      <button type="button" onClick={openShortcuts}>
        open sheet
      </button>
      <button type="button" onClick={() => setSingleKeyShortcuts(false)}>
        keys off
      </button>
      <output aria-label="open">{String(shortcutsOpen)}</output>
    </>
  )
}

async function setup() {
  renderShell(
    <>
      <Opener />
      <ShortcutSheet />
    </>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'open sheet' }))
  return { user, dialog: screen.getByRole('dialog', { name: 'Keyboard shortcuts' }) }
}

/** The keycaps of the row whose action text is `label`. */
function keycaps(label: string): string[] {
  const row = screen.getByText(label).closest('tr') as HTMLElement
  return Array.from(row.querySelectorAll('kbd'), (kbd) => kbd.textContent ?? '')
}

describe('ShortcutSheet', () => {
  it('is closed until it is opened, and then a labelled modal dialog', async () => {
    renderShell(
      <>
        <Opener />
        <ShortcutSheet />
      </>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open sheet' }))
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dialog.tagName).toBe('DIALOG')
    expect(dialog).toHaveAttribute('open')
  })

  it('prints one table per scope, in order, each labelled by its heading', async () => {
    await setup()
    const regions = screen.getAllByRole('region')
    expect(regions.map((region) => region.getAttribute('aria-labelledby'))).toHaveLength(
      SCOPE_ORDER.length,
    )
    for (const scope of SCOPE_ORDER) {
      const region = screen.getByRole('region', { name: SCOPE_TITLE[scope] })
      expect(within(region).getByRole('table')).toBeInTheDocument()
    }
    expect(regions.map((region) => region.querySelector('h3')?.textContent)).toEqual(
      SCOPE_ORDER.map((scope) => SCOPE_TITLE[scope]),
    )
  })

  it('has a real table: column headers, a row header of keys and the action beside it', async () => {
    await setup()
    const table = within(screen.getByRole('region', { name: 'Everywhere' })).getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Keys' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument()
    const row = within(table).getByRole('row', { name: /Pause or resume live updates/ })
    expect(within(row).getByRole('rowheader')).toHaveTextContent('p')
    expect(within(row).getByRole('cell')).toHaveTextContent('Pause or resume live updates')
  })

  it('lists every shortcut of the registry, so the sheet cannot drift from the bindings', async () => {
    await setup()
    expect(screen.getAllByRole('rowheader')).toHaveLength(SHORTCUTS.length)
    for (const shortcut of SHORTCUTS) {
      expect(screen.getAllByText(shortcut.label).length, shortcut.label).toBeGreaterThan(0)
    }
  })

  it('shows chords, alternatives and sequences as keycaps', async () => {
    await setup()
    expect(keycaps('Open the command palette')).toEqual(['Ctrl', 'K', '/'])
    expect(keycaps('Show keyboard shortcuts')).toEqual(['?', 'Ctrl', '/'])
    expect(keycaps('Previous time range')).toEqual(['Shift', 'T'])
    expect(keycaps('Go to Servers')).toEqual(['g', 's'])
    expect(keycaps('Focus panel N')).toEqual(['1–6'])
    expect(
      within(screen.getByText('Go to Servers').closest('tr') as HTMLElement).getByText('then'),
    ).toBeInTheDocument()
  })

  it('documents the panel-scoped keys the panels handle themselves', async () => {
    await setup()
    const panel = screen.getByRole('region', { name: 'In a focused panel or list' })
    for (const label of [
      'Move the selection down',
      'Copy the selected row as text',
      'Cycle the severity filter',
    ]) {
      expect(within(panel).getByText(label)).toBeInTheDocument()
    }
    expect(keycaps('Move the selection down')).toEqual(['j', 'Down'])
    expect(keycaps('Switch tab or segment, or move the chart crosshair')).toEqual(['Left', 'Right'])
  })

  it('uses Command on macOS', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgentData: undefined })
    await setup()
    const row = screen.getByText('Open the command palette').closest('tr') as HTMLElement
    expect(within(row).getByText('Command')).toBeInTheDocument()
    expect(within(row).queryByText('Ctrl')).not.toBeInTheDocument()
  })

  it('says when single-key shortcuts are off', async () => {
    const { user } = await setup()
    expect(screen.queryByText(/They are off right now/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'keys off' }))
    expect(screen.getByText(/They are off right now/)).toBeInTheDocument()
  })
})

describe('ShortcutSheet: closing', () => {
  it('closes from its button and puts focus back on what opened it', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Close shortcuts' }))
    expect(screen.getByLabelText('open')).toHaveTextContent('false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'open sheet' })).toHaveFocus()
  })

  it('follows the browser when Escape closes the dialog natively', async () => {
    const { dialog } = await setup()
    // What a browser does on Escape: close the dialog, then fire "close".
    dialog.removeAttribute('open')
    fireEvent(dialog, new Event('close'))
    expect(screen.getByLabelText('open')).toHaveTextContent('false')
  })

  it('closes when the scrim is clicked, but not when the content is', async () => {
    const { dialog, user } = await setup()
    await user.click(within(dialog).getByRole('heading', { name: 'Keyboard shortcuts' }))
    expect(screen.getByLabelText('open')).toHaveTextContent('true')
    await user.click(dialog)
    expect(screen.getByLabelText('open')).toHaveTextContent('false')
  })
})
