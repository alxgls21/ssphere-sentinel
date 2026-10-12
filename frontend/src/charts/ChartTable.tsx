import { cn } from '@/lib/cn'

export interface ChartTableColumn {
  label: string
  /** Numbers align right so a column reads as one scan line. */
  numeric?: boolean
}

export interface ChartTableRow {
  key: string
  /** The row header: the x value (a time) the cells belong to. */
  header: string
  cells: readonly string[]
}

export interface ChartTableModel {
  caption: string
  /** The first column heads the row headers; one column per cell after it. */
  columns: readonly ChartTableColumn[]
  rows: readonly ChartTableRow[]
}

interface ChartTableProps {
  table: ChartTableModel
  /** Height in rem so the table fills exactly the space the plot had. */
  heightRem: number
}

/**
 * The table-view twin: every value the chart draws, as a real table, so no
 * value is ever reachable only through a tooltip. The scroll region is
 * focusable so a keyboard user can read past the first screenful.
 */
export function ChartTable({ table, heightRem }: ChartTableProps) {
  return (
    <section
      // WCAG 2.1.1: a scrollable region must be reachable by keyboard.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label="Table view"
      style={{ minHeight: `${heightRem}rem` }}
      className="min-h-0 flex-1 overflow-auto rounded-sm border border-border"
    >
      <table className="type-data w-full">
        <caption className="sr-only">{table.caption}</caption>
        <thead className="sticky top-0 bg-raised">
          <tr>
            {table.columns.map((column, index) => (
              <th
                key={column.label}
                scope="col"
                className={cn(
                  'type-label h-6 px-2 font-medium whitespace-nowrap text-fg-faint',
                  index > 0 && column.numeric ? 'text-right' : 'text-left',
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <th
                scope="row"
                className="h-6 px-2 text-left font-normal whitespace-nowrap text-fg-muted"
              >
                {row.header}
              </th>
              {row.cells.map((cell, index) => (
                <td
                  key={table.columns[index + 1]?.label ?? index}
                  className={cn(
                    'h-6 px-2 whitespace-nowrap text-fg',
                    table.columns[index + 1]?.numeric && 'text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
