import type { ServerListItem } from '@/api/types'
import { CellMeter } from '@/ui/meters'
import { loadOf } from './serversModel'

const NAME = { cpu: 'CPU', memory: 'RAM', disk: 'Disk' } as const

/** One resource of one server as a cell meter (10 cells of 10%; a card or a table column). */
export function LoadCell({
  item,
  metric,
  className,
}: {
  item: ServerListItem
  metric: keyof typeof NAME
  className?: string
}) {
  return (
    <CellMeter
      percent={loadOf(item, metric)}
      cells={10}
      label={`${NAME[metric]} of ${item.server.name}`}
      className={className}
    />
  )
}
