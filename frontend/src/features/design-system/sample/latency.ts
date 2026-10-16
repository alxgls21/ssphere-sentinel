import type { NetworkSeries } from '@/api/types'
import { SAMPLE_SERIES } from './data'

/** One minute in which p95 jumps far over the 150 ms limit for a single sample. */
const SPIKE = 11

/**
 * The gallery's network series with a lone latency spike inside the window as
 * well as the sustained climb at its end, so the chart shows both limits, the
 * triangle on every sample over the latency limit and the label on the worst.
 * Invented numbers, like the rest of the samples.
 */
export const SAMPLE_SPIKE_SERIES: NetworkSeries = {
  ...SAMPLE_SERIES,
  p95: SAMPLE_SERIES.p95.map((value, index) => (index === SPIKE ? 232 : value)),
  p50: SAMPLE_SERIES.p50.map((value, index) => (index === SPIKE ? 84 : value)),
}
