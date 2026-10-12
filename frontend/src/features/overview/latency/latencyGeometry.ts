/**
 * Chart geometry at the 16px root, in px. Kept apart from the option builder
 * so the panel shell can size its skeleton without importing any chart code.
 * The 222px container includes the x-axis band, so the panel never needs a
 * nested vertical scroll.
 */
export const LATENCY_GEOMETRY = {
  left: 44,
  /** Room for the direct end labels. */
  right: 56,
  rightCompact: 8,
  top: 8,
  /** The latency grid at the minimum plot size: 222px of plot in all. It grows when the plot does. */
  latency: 128,
  gap: 10,
  loss: 48,
  axisBand: 28,
} as const

export const LATENCY_CHART_HEIGHT_PX =
  LATENCY_GEOMETRY.top +
  LATENCY_GEOMETRY.latency +
  LATENCY_GEOMETRY.gap +
  LATENCY_GEOMETRY.loss +
  LATENCY_GEOMETRY.axisBand
