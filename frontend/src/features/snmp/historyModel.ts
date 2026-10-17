import type { DeviceSeries, InterfaceSeries, RangeKey } from '@/api/types'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { ChartColorName, ChartColors } from '@/charts/theme'
import type { TooltipContent, TooltipRow } from '@/charts/tooltip'
import {
  EMPTY,
  formatBitsPerSecond,
  formatLatency,
  formatTime,
  timezoneLabel,
  type Timezone,
} from '@/lib/format'
import { RANGE_WORDS } from '@/lib/range'

/**
 * Everything the SNMP history charts say in words and numbers, from one place: tooltip, spoken
 * cursor value, figure summary and table twin read the same buckets, so they cannot disagree.
 *
 * A gap is a bucket with nothing to average. An interface's rates are the console API's means over
 * the valid samples of the bucket; a sample that gave no rate is counted apart and never drawn, and
 * never as zero traffic. A bucket in which nothing was polled has no count either (not 0 failed).
 */

export interface HistorySpec<Id extends string> {
  id: Id
  label: string
  /** Token slot, bound to the metric and never to its rank among the visible series. */
  color: ChartColorName
  /** Which of the three stacked grids draws it. */
  grid: 0 | 1 | 2
  /** A bar rather than a line. */
  bar?: boolean
  /** A thin line: a maximum drawn behind the mean. */
  thin?: boolean
}

const clock = (ms: number, tz: Timezone) => formatTime(ms, tz, false)

/* ----------------------------------------------------------------- device */

export type DeviceHistoryId = 'response' | 'reachable' | 'failed'

export const DEVICE_SPECS: readonly HistorySpec<DeviceHistoryId>[] = [
  { id: 'response', label: 'Response time (mean)', color: 'primary', grid: 0 },
  { id: 'reachable', label: 'Reachable polls', color: 'series3', grid: 1, bar: true },
  { id: 'failed', label: 'Failed polls', color: 'critical', grid: 2, bar: true },
]

export const DEVICE_HISTORY_IDS: readonly DeviceHistoryId[] = DEVICE_SPECS.map(({ id }) => id)

const polledIn = (series: DeviceSeries, index: number): number =>
  (series.reachablePolls[index] ?? 0) + (series.failedPolls[index] ?? 0)

export function deviceValues(series: DeviceSeries, id: DeviceHistoryId): (number | null)[] {
  switch (id) {
    case 'response':
      return series.responseMs
    case 'reachable':
      // A bucket in which nothing was polled has no count, not a count of 0.
      return series.reachablePolls.map((count, index) =>
        polledIn(series, index) > 0 ? count : null,
      )
    case 'failed':
      return series.failedPolls.map((count, index) => (polledIn(series, index) > 0 ? count : null))
  }
}

export const hasDeviceHistory = (series: DeviceSeries): boolean =>
  series.t.some((_, index) => polledIn(series, index) > 0)

function deviceText(series: DeviceSeries, id: DeviceHistoryId, index: number): string {
  const value = deviceValues(series, id)[index]
  if (value == null) return id === 'response' ? EMPTY : 'no polls'
  if (id === 'response') return formatLatency(value)
  return `${value} of ${polledIn(series, index)}`
}

export function summarizeDevice(name: string, series: DeviceSeries, range: RangeKey): string {
  const head = `Poll history of ${name}, ${RANGE_WORDS[range]}`
  if (!hasDeviceHistory(series)) return `${head}: no polls`
  const reachable = series.reachablePolls.reduce((sum, count) => sum + count, 0)
  const failed = series.failedPolls.reduce((sum, count) => sum + count, 0)
  return `${head}: ${reachable} reachable polls, ${failed} failed. A gap is a bucket with no reachable poll; failed polls are counted apart`
}

export function describeDeviceBucket(series: DeviceSeries, index: number, tz: Timezone): string {
  const polled = polledIn(series, index)
  const parts =
    polled === 0
      ? ['no polls']
      : [
          series.responseMs[index] == null
            ? 'no response time, no reachable poll'
            : `response time ${series.responseMs[index]?.toFixed(1)} milliseconds`,
          `${series.reachablePolls[index]} reachable, ${series.failedPolls[index]} failed`,
        ]
  return [`${clock(series.t[index] ?? 0, tz)} ${timezoneLabel(tz)}`, ...parts].join(', ')
}

export function deviceTooltip(
  series: DeviceSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  return {
    title: clock(series.t[index] ?? 0, tz),
    rows: DEVICE_SPECS.filter(({ id }) => !hidden.has(id)).map((spec) => ({
      key: spec.bar ? ('rect' as const) : ('line' as const),
      color: colors[spec.color],
      value: deviceText(series, spec.id, index),
      label: spec.label,
    })),
  }
}

export function deviceTable(
  name: string,
  series: DeviceSeries,
  range: RangeKey,
  tz: Timezone,
): ChartTableModel {
  return {
    caption: `Poll history of ${name}, ${RANGE_WORDS[range]}, newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      ...DEVICE_SPECS.map(({ label }) => ({ label, numeric: true })),
    ],
    rows: series.t
      .map((time, index) => ({
        key: String(time),
        header: clock(time, tz),
        cells: DEVICE_SPECS.map(({ id }) => deviceText(series, id, index)),
      }))
      .reverse(),
  }
}

/* -------------------------------------------------------------- interface */

export type InterfaceHistoryId =
  | 'inBps'
  | 'outBps'
  | 'inBpsMax'
  | 'outBpsMax'
  | 'inErrorsPerSec'
  | 'outErrorsPerSec'
  | 'inDiscardsPerSec'
  | 'outDiscardsPerSec'

export const INTERFACE_SPECS: readonly HistorySpec<InterfaceHistoryId>[] = [
  { id: 'inBps', label: 'Inbound (mean)', color: 'primary', grid: 0 },
  { id: 'outBps', label: 'Outbound (mean)', color: 'series2', grid: 0 },
  { id: 'inBpsMax', label: 'Inbound (highest)', color: 'primary', grid: 0, thin: true },
  { id: 'outBpsMax', label: 'Outbound (highest)', color: 'series2', grid: 0, thin: true },
  { id: 'inErrorsPerSec', label: 'Inbound errors/s', color: 'primary', grid: 1 },
  { id: 'outErrorsPerSec', label: 'Outbound errors/s', color: 'series2', grid: 1 },
  { id: 'inDiscardsPerSec', label: 'Inbound discards/s', color: 'primary', grid: 2 },
  { id: 'outDiscardsPerSec', label: 'Outbound discards/s', color: 'series2', grid: 2 },
]

export const INTERFACE_HISTORY_IDS: readonly InterfaceHistoryId[] = INTERFACE_SPECS.map(
  ({ id }) => id,
)

export const interfaceValues = (
  series: InterfaceSeries,
  id: InterfaceHistoryId,
): (number | null)[] => series[id]

const sampledIn = (series: InterfaceSeries, index: number): number =>
  (series.validSamples[index] ?? 0) + (series.invalidSamples[index] ?? 0)

export const hasInterfaceHistory = (series: InterfaceSeries): boolean =>
  series.t.some((_, index) => sampledIn(series, index) > 0)

/** Whether any bucket has a value to draw: samples may all have been unusable. */
export const hasInterfaceValues = (series: InterfaceSeries): boolean =>
  INTERFACE_HISTORY_IDS.some((id) => interfaceValues(series, id).some((value) => value !== null))

const perSecond = (value: number): string => `${value.toFixed(value < 10 ? 2 : 1)}/s`

function interfaceText(series: InterfaceSeries, id: InterfaceHistoryId, index: number): string {
  const value = interfaceValues(series, id)[index]
  if (value == null) return EMPTY
  return id === 'inBps' || id === 'outBps' || id === 'inBpsMax' || id === 'outBpsMax'
    ? formatBitsPerSecond(value)
    : perSecond(value)
}

const samplesText = (series: InterfaceSeries, index: number): string =>
  `${series.validSamples[index] ?? 0} usable, ${series.invalidSamples[index] ?? 0} without a rate`

export function summarizeInterface(name: string, series: InterfaceSeries, range: RangeKey): string {
  const head = `Traffic history of ${name}, ${RANGE_WORDS[range]}`
  if (!hasInterfaceHistory(series)) return `${head}: no samples`
  const valid = series.validSamples.reduce((sum, count) => sum + count, 0)
  const invalid = series.invalidSamples.reduce((sum, count) => sum + count, 0)
  return `${head}: ${valid} usable samples, ${invalid} without a rate. A gap is a bucket with no usable sample; a sample without a rate is counted apart and never drawn as zero traffic`
}

export function describeInterfaceBucket(
  series: InterfaceSeries,
  index: number,
  tz: Timezone,
): string {
  const head = `${clock(series.t[index] ?? 0, tz)} ${timezoneLabel(tz)}`
  if (sampledIn(series, index) === 0) return `${head}, no samples`
  if ((series.validSamples[index] ?? 0) === 0) {
    return `${head}, no usable sample: ${series.invalidSamples[index]} without a rate`
  }
  const bits = (value: number | null | undefined) =>
    value == null ? 'no value' : formatBitsPerSecond(value)
  return [
    head,
    `inbound ${bits(series.inBps[index])}, outbound ${bits(series.outBps[index])}`,
    `highest inbound ${bits(series.inBpsMax[index])}, highest outbound ${bits(series.outBpsMax[index])}`,
    `errors ${interfaceText(series, 'inErrorsPerSec', index)} in, ${interfaceText(series, 'outErrorsPerSec', index)} out`,
    `discards ${interfaceText(series, 'inDiscardsPerSec', index)} in, ${interfaceText(series, 'outDiscardsPerSec', index)} out`,
    samplesText(series, index),
  ].join(', ')
}

export function interfaceTooltip(
  series: InterfaceSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  const rows: TooltipRow[] = INTERFACE_SPECS.filter(({ id }) => !hidden.has(id)).map((spec) => ({
    key: 'line' as const,
    color: colors[spec.color],
    value: interfaceText(series, spec.id, index),
    label: spec.label,
  }))
  rows.push({
    key: 'rect',
    color: colors.fgFaint,
    value: samplesText(series, index),
    label: 'Samples',
  })
  return { title: clock(series.t[index] ?? 0, tz), rows }
}

export function interfaceTable(
  name: string,
  series: InterfaceSeries,
  range: RangeKey,
  tz: Timezone,
): ChartTableModel {
  return {
    caption: `Traffic history of ${name}, ${RANGE_WORDS[range]}, newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      ...INTERFACE_SPECS.map(({ label }) => ({ label, numeric: true })),
      { label: 'Usable samples', numeric: true },
      { label: 'Samples without a rate', numeric: true },
    ],
    rows: series.t
      .map((time, index) => ({
        key: String(time),
        header: clock(time, tz),
        cells: [
          ...INTERFACE_SPECS.map(({ id }) => interfaceText(series, id, index)),
          String(series.validSamples[index] ?? 0),
          String(series.invalidSamples[index] ?? 0),
        ],
      }))
      .reverse(),
  }
}
