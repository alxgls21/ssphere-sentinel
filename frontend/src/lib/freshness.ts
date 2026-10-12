/**
 * How far to trust the screen. A dead dashboard must never look healthy, so
 * freshness is part of the vocabulary the verdict and every panel share.
 *
 *   live      data arrived recently
 *   fetching  a request is in flight (data is still recent)
 *   paused    the operator froze updates on purpose
 *   stale     older than the stale threshold (see lib/thresholds)
 *   nodata    older than the no-data threshold, or every request failed
 */
export type Freshness = 'live' | 'fetching' | 'paused' | 'stale' | 'nodata'
