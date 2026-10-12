import { vi, type Mock } from 'vitest'

/**
 * A canvas-free stand-in for the ECharts runtime (jsdom has no canvas). Mock
 * the chart module with it, then inspect what the code under test asked of
 * the instance:
 *
 *   vi.mock('@/charts/echarts', async () => (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule())
 */
export interface FakeChart {
  setOption: Mock
  resize: Mock
  dispose: Mock
  dispatchAction: Mock
  /** Answers with the value itself, so the pixel is the timestamp: easy to assert. */
  convertToPixel: Mock
  getHeight: Mock
}

/** Every instance created since the last reset, oldest first. */
export const fakeCharts: FakeChart[] = []

export function resetFakeCharts(): void {
  fakeCharts.length = 0
}

export function fakeEchartsModule() {
  return {
    echarts: {
      registerTheme: vi.fn(),
      init: vi.fn(() => {
        const chart: FakeChart = {
          setOption: vi.fn(),
          resize: vi.fn(),
          dispose: vi.fn(),
          dispatchAction: vi.fn(),
          convertToPixel: vi.fn((_finder: unknown, value: number) => value),
          getHeight: vi.fn(() => 222),
        }
        fakeCharts.push(chart)
        return chart
      }),
    },
  }
}
