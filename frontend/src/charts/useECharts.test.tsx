import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { echarts, type ChartOption } from './echarts'
import { fakeCharts, resetFakeCharts } from './testing/fakeEcharts'
import { useECharts, type ChartEnv } from './useECharts'

vi.mock('./echarts', async () => (await import('./testing/fakeEcharts')).fakeEchartsModule())

const OPTION = { series: [] } as ChartOption

function Harness({ build }: { build: (env: ChartEnv) => ChartOption }) {
  const { ref, chart } = useECharts(build)
  return <div ref={ref} data-testid="plot" data-ready={chart ? 'yes' : 'no'} />
}

/** Captures every observer the hook creates so a test can fire its resize callback. */
const observers: { callback: () => void; disconnected: boolean }[] = []
class FakeResizeObserver {
  private readonly record: { callback: () => void; disconnected: boolean }
  constructor(callback: () => void) {
    this.record = { callback, disconnected: false }
    observers.push(this.record)
  }
  observe() {}
  disconnect() {
    this.record.disconnected = true
  }
}

beforeEach(() => {
  resetFakeCharts()
  observers.length = 0
  vi.mocked(echarts.init).mockClear()
  vi.mocked(echarts.registerTheme).mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'fonts')
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-motion')
})

function stubFonts(load: () => Promise<unknown>) {
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
}

describe('useECharts', () => {
  it('waits for the mono face before the first measure', async () => {
    let loaded!: () => void
    const load = vi.fn(() => new Promise<void>((resolve) => (loaded = resolve)))
    stubFonts(load)
    render(<Harness build={() => OPTION} />)

    expect(load).toHaveBeenCalledWith('11px JetBrains Mono')
    expect(echarts.init).not.toHaveBeenCalled()

    await act(async () => loaded())
    await waitFor(() => expect(screen.getByTestId('plot')).toHaveAttribute('data-ready', 'yes'))
    expect(echarts.init).toHaveBeenCalledTimes(1)
  })

  it('still draws when the font fails to load', async () => {
    stubFonts(() => Promise.reject(new Error('404')))
    render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(1))
  })

  it('registers the sentinel theme and initialises a canvas chart on it', async () => {
    render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(1))
    expect(echarts.registerTheme).toHaveBeenCalledWith('sentinel', expect.any(Object))
    expect(echarts.init).toHaveBeenCalledWith(screen.getByTestId('plot'), 'sentinel', {
      renderer: 'canvas',
    })
  })

  it('applies the built option, replacing series so removed ones leave no ghost behind', async () => {
    const build = vi.fn(() => OPTION)
    render(<Harness build={build} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    expect(fakeCharts[0]?.setOption).toHaveBeenCalledWith(expect.objectContaining({ series: [] }), {
      replaceMerge: ['series'],
    })
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ compact: false, tokens: expect.objectContaining({ scale: 1 }) }),
    )
  })

  it('re-applies the option when the builder changes, without re-initialising', async () => {
    const { rerender } = render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalledTimes(1))
    rerender(<Harness build={() => ({ ...OPTION, backgroundColor: 'transparent' })} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalledTimes(2))
    expect(echarts.init).toHaveBeenCalledTimes(1)
  })

  it('hides a visible tooltip when the series list changes, never when only the data does', async () => {
    const withSeries = (ids: string[]) =>
      ({ series: ids.map((id) => ({ id, type: 'line' })) }) as unknown as ChartOption
    const { rerender } = render(<Harness build={() => withSeries(['a', 'b'])} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalledTimes(1))
    expect(fakeCharts[0]?.dispatchAction).not.toHaveBeenCalled()

    rerender(<Harness build={() => withSeries(['a', 'b'])} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalledTimes(2))
    expect(fakeCharts[0]?.dispatchAction).not.toHaveBeenCalled()

    rerender(<Harness build={() => withSeries(['a'])} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalledTimes(3))
    expect(fakeCharts[0]?.dispatchAction).toHaveBeenCalledWith({ type: 'hideTip' })
    // ...and before the new series list is applied.
    const hideAt = fakeCharts[0]?.dispatchAction.mock.invocationCallOrder[0] ?? 0
    const applyAt = fakeCharts[0]?.setOption.mock.invocationCallOrder[2] ?? 0
    expect(hideAt).toBeLessThan(applyAt)
  })

  it('turns animation off per update under reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduce'
    render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    expect(fakeCharts[0]?.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ animation: false }),
      expect.anything(),
    )
  })

  it('resizes with its container', async () => {
    render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(observers).toHaveLength(1))
    act(() => observers[0]?.callback())
    expect(fakeCharts[0]?.resize).toHaveBeenCalled()
  })

  it('re-initialises when the root font size changes (wall mode)', async () => {
    const build = vi.fn(() => OPTION)
    render(<Harness build={build} />)
    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(1))

    document.documentElement.style.fontSize = '24px'
    act(() => observers[0]?.callback())

    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(2))
    expect(fakeCharts[0]?.dispose).toHaveBeenCalled()
    expect(observers[0]?.disconnected).toBe(true)
    // The option is rebuilt for the new instance from the new root size.
    await waitFor(() => expect(fakeCharts[1]?.setOption).toHaveBeenCalled())
    expect(build).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ scale: 1.5 }) }),
    )
  })

  it('reports a narrow container so charts can drop end labels', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 280, configurable: true })
    try {
      const build = vi.fn(() => OPTION)
      render(<Harness build={build} />)
      await waitFor(() =>
        expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ compact: true })),
      )
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })

  it('disposes the chart and stops observing on unmount', async () => {
    const { unmount } = render(<Harness build={() => OPTION} />)
    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(1))
    unmount()
    expect(fakeCharts[0]?.dispose).toHaveBeenCalled()
    expect(observers[0]?.disconnected).toBe(true)
  })
})
