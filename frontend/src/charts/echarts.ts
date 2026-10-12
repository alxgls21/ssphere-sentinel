/**
 * Apache ECharts, modular: only what the console uses is registered, which
 * keeps the bundle a fraction of the full library. Register a new chart type
 * or component here before using it in an option.
 *
 * Importing this module pulls the whole chart runtime. Reach it only from a
 * React.lazy chunk so the shell and the other panels paint first.
 */
import { BarChart, LineChart } from 'echarts/charts'
import {
  AriaComponent,
  AxisPointerComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components'
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts'
import type {
  AriaComponentOption,
  AxisPointerComponentOption,
  GridComponentOption,
  MarkAreaComponentOption,
  MarkLineComponentOption,
  MarkPointComponentOption,
  TooltipComponentOption,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import type { ComposeOption } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  AriaComponent,
  CanvasRenderer,
])

export { echarts }

/** The option type for every chart in the console. */
export type ChartOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | AxisPointerComponentOption
  | MarkLineComponentOption
  | MarkPointComponentOption
  | MarkAreaComponentOption
  | AriaComponentOption
>

/** A live chart instance. */
export type ChartInstance = ReturnType<typeof echarts.init>

export type { BarSeriesOption, LineSeriesOption }
export type { XAXisComponentOption, YAXisComponentOption } from 'echarts'
