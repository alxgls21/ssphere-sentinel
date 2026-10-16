import { REFERENCE_SERIES_PREFIX } from '../timeSeries'

/** A reference series (a threshold line) carries no data: a test that reads the data series leaves it out. */
export function isReferenceSeries(series: { id?: unknown }): boolean {
  return typeof series.id === 'string' && series.id.startsWith(REFERENCE_SERIES_PREFIX)
}
