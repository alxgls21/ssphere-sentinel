import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { Panel } from './Panel'
import { PanelBoundary } from './PanelBoundary'

let broken = true
function Fragile() {
  if (broken) throw new Error('chart exploded')
  return (
    <Panel title="Fragile panel" features="network">
      recovered
    </Panel>
  )
}

afterEach(() => {
  broken = true
  vi.restoreAllMocks()
})

describe('PanelBoundary', () => {
  it('keeps a throwing panel in its own frame, in its error state, and leaves its siblings alone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderApp(
      <>
        <PanelBoundary title="Fragile panel" features="network" index={2}>
          <Fragile />
        </PanelBoundary>
        <Panel title="Healthy panel" features="servers">
          still here
        </Panel>
      </>,
    )
    const frame = screen.getByRole('region', { name: 'Fragile panel' })
    expect(frame).toHaveAttribute('aria-keyshortcuts', '2')
    expect(screen.getByRole('alert')).toHaveTextContent('chart exploded')
    expect(screen.getByText('still here')).toBeInTheDocument()
  })

  it('renders the panel again on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderApp(
      <PanelBoundary title="Fragile panel" features="network">
        <Fragile />
      </PanelBoundary>,
    )
    broken = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })
})
